import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { CliError } from "../core/errors.js";
import { expectNumber, expectRecord, expectString } from "../core/json.js";
import { SecureJsonFile } from "../storage/secure-json-file.js";

export type AuthBackend = "private-di" | "web-cookie";

export interface AuthStateSnapshot {
  readonly backend: AuthBackend | null;
  readonly revision: string;
}

interface StoredAuthStateV3 {
  readonly schemaVersion: 3;
  readonly activeBackend: AuthBackend | null;
  readonly revision: string;
  readonly savedAt: string;
}

interface StoredLockOwnerV1 {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

export interface AuthStateCoordinator {
  activeState(): Promise<AuthStateSnapshot | null>;
  activeBackend(): Promise<AuthBackend | null>;
  setActiveBackend(backend: AuthBackend): Promise<void>;
  clearActiveBackend(): Promise<void>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export interface FileAuthStateOptions {
  readonly lockTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly malformedLockStaleMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_MALFORMED_LOCK_STALE_MS = 30_000;
const MAXIMUM_LOCK_BYTES = 4_096;

export class FileAuthState implements AuthStateCoordinator {
  readonly #marker: SecureJsonFile<StoredAuthStateV3>;
  readonly #lockPath: string;
  readonly #lockTimeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #malformedLockStaleMs: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #ownership = new AsyncLocalStorage<string>();

  public constructor(markerPath: string, lockPath: string, options: FileAuthStateOptions = {}) {
    this.#marker = new SecureJsonFile(markerPath, decodeStoredAuthState);
    this.#lockPath = resolve(lockPath);
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#malformedLockStaleMs = options.malformedLockStaleMs ?? DEFAULT_MALFORMED_LOCK_STALE_MS;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (async (milliseconds) => delay(milliseconds));
    assertPositiveSafeInteger(this.#lockTimeoutMs, "auth lock timeout");
    assertPositiveSafeInteger(this.#retryDelayMs, "auth lock retry delay");
    assertPositiveSafeInteger(this.#malformedLockStaleMs, "malformed auth lock stale interval");
  }

  public async activeState(): Promise<AuthStateSnapshot | null> {
    const stored = await this.#marker.load();
    return stored === null ? null : { backend: stored.activeBackend, revision: stored.revision };
  }

  public async activeBackend(): Promise<AuthBackend | null> {
    return (await this.activeState())?.backend ?? null;
  }

  public setActiveBackend(backend: AuthBackend): Promise<void> {
    return this.#saveState(backend);
  }

  public clearActiveBackend(): Promise<void> {
    return this.#saveState(null);
  }

  #saveState(activeBackend: AuthBackend | null): Promise<void> {
    return this.#marker.save({
      schemaVersion: 3,
      activeBackend,
      revision: crypto.randomUUID(),
      savedAt: new Date(this.#now()).toISOString()
    });
  }

  public async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#ownership.getStore() !== undefined) return operation();
    const owner = await this.#acquire();
    try {
      return await this.#ownership.run(owner.token, operation);
    } finally {
      await this.#release(owner);
    }
  }

  async #acquire(): Promise<StoredLockOwnerV1> {
    await this.#prepareDirectory();
    const deadline = this.#now() + this.#lockTimeoutMs;
    const owner: StoredLockOwnerV1 = {
      schemaVersion: 1,
      pid: process.pid,
      token: crypto.randomUUID(),
      createdAt: new Date(this.#now()).toISOString()
    };
    while (true) {
      try {
        const handle = await open(this.#lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          if (process.platform !== "win32") await handle.chmod(0o600);
          await handle.sync();
          await handle.close();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(this.#lockPath).catch(() => undefined);
          throw error;
        }
        return owner;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }

      if (await this.#removeAbandonedLock()) continue;
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        throw new CliError("AUTH_STATE_BUSY", "Another gconnect process is updating authentication state", {
          retryable: true,
          timeoutMs: this.#lockTimeoutMs
        }, 1);
      }
      await this.#sleep(Math.min(this.#retryDelayMs, remaining));
    }
  }

  async #prepareDirectory(): Promise<void> {
    const directory = dirname(this.#lockPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new CliError("INSECURE_CREDENTIAL_DIRECTORY", "Authentication state directory must not be a symbolic link", {
        path: directory
      }, 1);
    }
    if (process.platform !== "win32") await chmod(directory, 0o700);
  }

  async #removeAbandonedLock(): Promise<boolean> {
    let metadata;
    try {
      metadata = await lstat(this.#lockPath);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new CliError("INSECURE_AUTH_STATE_LOCK", "Authentication lock path must be a regular file, not a link", {
        path: this.#lockPath
      }, 1);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new CliError("INSECURE_AUTH_STATE_LOCK", "Authentication lock file permissions must be 0600", {
        path: this.#lockPath,
        mode: (metadata.mode & 0o777).toString(8)
      }, 1);
    }

    const owner = await this.#readLockOwner();
    if (owner === null) {
      if (this.#now() - metadata.mtimeMs < this.#malformedLockStaleMs) return false;
      return this.#unlinkIfUnchanged(null);
    }
    if (isProcessAlive(owner.pid)) return false;
    return this.#unlinkIfUnchanged(owner.token);
  }

  async #readLockOwner(): Promise<StoredLockOwnerV1 | null> {
    try {
      const metadata = await lstat(this.#lockPath);
      if (metadata.size > MAXIMUM_LOCK_BYTES) return null;
      return decodeStoredLockOwner(JSON.parse(await readFile(this.#lockPath, "utf8")));
    } catch (error) {
      if (isMissing(error)) return null;
      return null;
    }
  }

  async #unlinkIfUnchanged(expectedToken: string | null): Promise<boolean> {
    const current = await this.#readLockOwner();
    if ((current?.token ?? null) !== expectedToken) return false;
    try {
      await unlink(this.#lockPath);
      return true;
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
  }

  async #release(owner: StoredLockOwnerV1): Promise<void> {
    const current = await this.#readLockOwner();
    if (current?.token !== owner.token) {
      throw new CliError("AUTH_STATE_LOCK_LOST", "Authentication state lock ownership was lost", {}, 1);
    }
    await unlink(this.#lockPath);
  }
}

function decodeStoredAuthState(input: unknown): StoredAuthStateV3 {
  const record = expectRecord(input, "authentication state");
  assertExactKeys(record, ["schemaVersion", "activeBackend", "revision", "savedAt"], "authentication state");
  if (expectNumber(record.schemaVersion, "authentication state.schemaVersion") !== 3) {
    throw new TypeError("authentication state.schemaVersion must be 3");
  }
  const activeBackend = record.activeBackend;
  if (activeBackend !== null && activeBackend !== "private-di" && activeBackend !== "web-cookie") {
    throw new TypeError("authentication state.activeBackend is invalid");
  }
  const revision = expectString(record.revision, "authentication state.revision");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(revision)) {
    throw new TypeError("authentication state.revision must be a UUID");
  }
  const savedAt = expectString(record.savedAt, "authentication state.savedAt");
  if (Number.isNaN(Date.parse(savedAt))) {
    throw new TypeError("authentication state.savedAt must be an ISO timestamp");
  }
  return { schemaVersion: 3, activeBackend, revision, savedAt };
}

function decodeStoredLockOwner(input: unknown): StoredLockOwnerV1 {
  const record = expectRecord(input, "authentication lock");
  assertExactKeys(record, ["schemaVersion", "pid", "token", "createdAt"], "authentication lock");
  if (expectNumber(record.schemaVersion, "authentication lock.schemaVersion") !== 1) {
    throw new TypeError("authentication lock.schemaVersion must be 1");
  }
  const pid = expectNumber(record.pid, "authentication lock.pid");
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("authentication lock.pid is invalid");
  const token = expectString(record.token, "authentication lock.token");
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new TypeError("authentication lock.token is invalid");
  const createdAt = expectString(record.createdAt, "authentication lock.createdAt");
  if (Number.isNaN(Date.parse(createdAt))) throw new TypeError("authentication lock.createdAt must be an ISO timestamp");
  return { schemaVersion: 1, pid, token, createdAt };
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} contains unexpected or missing fields`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { readonly code?: unknown }).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { readonly code?: unknown }).code === "ESRCH";
}
