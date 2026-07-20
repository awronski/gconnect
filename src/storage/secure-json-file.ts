import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { CliError } from "../core/errors.js";

const MAX_SECRET_FILE_BYTES = 1_048_576;

export class SecureJsonFile<T> {
  readonly #path: string;
  readonly #decode: (input: unknown) => T;

  public constructor(path: string, decode: (input: unknown) => T) {
    this.#path = resolve(path);
    this.#decode = decode;
  }

  public path(): string {
    return this.#path;
  }

  public async load(): Promise<T | null> {
    if (!await validateExistingCredentialDirectory(dirname(this.#path))) return null;
    let metadata;
    try {
      metadata = await lstat(this.#path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new CliError("INSECURE_CREDENTIAL_FILE", "Credential path must be a regular file, not a link", {
        path: this.#path
      }, 1);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new CliError("INSECURE_CREDENTIAL_FILE", "Credential file permissions must be 0600", {
        path: this.#path,
        mode: (metadata.mode & 0o777).toString(8)
      }, 1);
    }
    if (metadata.size > MAX_SECRET_FILE_BYTES) {
      throw new CliError("INVALID_CREDENTIAL_FILE", "Credential file is too large", {
        path: this.#path,
        maximumBytes: MAX_SECRET_FILE_BYTES
      }, 1);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#path, "utf8"));
    } catch (error) {
      throw new CliError("INVALID_CREDENTIAL_FILE", "Credential file is not valid JSON", {
        path: this.#path,
        reason: error instanceof Error ? error.message : String(error)
      }, 1);
    }
    try {
      return this.#decode(parsed);
    } catch (error) {
      throw new CliError("INVALID_CREDENTIAL_FILE", "Credential file does not match the expected schema", {
        path: this.#path,
        reason: error instanceof Error ? error.message : String(error)
      }, 1);
    }
  }

  public async save(value: T): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new CliError("INSECURE_CREDENTIAL_DIRECTORY", "Credential directory must not be a symbolic link", {
        path: directory
      }, 1);
    }
    if (process.platform !== "win32") await chmod(directory, 0o700);

    try {
      const existing = await lstat(this.#path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new CliError("INSECURE_CREDENTIAL_FILE", "Refusing to replace a non-regular credential path", {
          path: this.#path
        }, 1);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const temporary = `${directory}/.${basename(this.#path)}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      // Rename is the commit point: no fallible work may happen after the target is replaced.
      await rename(temporary, this.#path);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  public async delete(): Promise<void> {
    if (!await validateExistingCredentialDirectory(dirname(this.#path))) return;
    try {
      const metadata = await lstat(this.#path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new CliError("INSECURE_CREDENTIAL_FILE", "Refusing to delete a non-regular credential path", {
          path: this.#path
        }, 1);
      }
      await unlink(this.#path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

async function validateExistingCredentialDirectory(directory: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new CliError("INSECURE_CREDENTIAL_DIRECTORY", "Credential directory must not be a symbolic link", {
      path: directory
    }, 1);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new CliError("INSECURE_CREDENTIAL_DIRECTORY", "Credential directory permissions must be 0700", {
      path: directory,
      mode: (metadata.mode & 0o777).toString(8)
    }, 1);
  }
  return true;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}
