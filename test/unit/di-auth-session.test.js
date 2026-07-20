import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DiAuthError,
  DiSessionManager,
  FileDiTokenStore,
  decodeStoredDiTokenSet
} from "../../dist/auth/di/index.js";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const authState = { async runExclusive(operation) { return operation(); } };

test("file DI token store writes owner-only state and loads the strict schema", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-di-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "nested", "tokens.json");
  const store = new FileDiTokenStore(path);
  const tokens = tokenSet();

  await store.save(tokens);

  assert.deepEqual(await store.load(), tokens);
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.backend, "private-di");
  assert.equal(parsed.refreshToken, "refresh-token");
  if (process.platform !== "win32") {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(directory, "nested"))).mode & 0o777, 0o700);
  }
});

test("file DI token store rejects symlinks and malformed or widened schemas", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-di-store-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target.json");
  const link = join(directory, "tokens.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await symlink(target, link);
  const linkedStore = new FileDiTokenStore(link);

  await assert.rejects(linkedStore.load(), (error) => error.code === "INSECURE_CREDENTIAL_FILE");
  await assert.rejects(linkedStore.save(tokenSet()), (error) => error.code === "INSECURE_CREDENTIAL_FILE");

  const malformedPath = join(directory, "malformed.json");
  const malformedStore = new FileDiTokenStore(malformedPath);
  await malformedStore.save(tokenSet());
  const widened = JSON.parse(await readFile(malformedPath, "utf8"));
  widened.unexpected = "field";
  await writeFile(malformedPath, `${JSON.stringify(widened)}\n`, "utf8");
  if (process.platform !== "win32") await chmod(malformedPath, 0o600);
  await assert.rejects(malformedStore.load(), (error) => error.code === "INVALID_CREDENTIAL_FILE");
});

test("stored DI decoder rejects wrong versions, backends, and token field types", () => {
  const stored = storedTokenFile();
  assert.throws(
    () => decodeStoredDiTokenSet({ ...stored, schemaVersion: 2 }),
    (error) => error.code === "DI_PROTOCOL_CHANGED"
  );
  assert.throws(
    () => decodeStoredDiTokenSet({ ...stored, backend: "official-developer" }),
    (error) => error.code === "DI_PROTOCOL_CHANGED"
  );
  assert.throws(
    () => decodeStoredDiTokenSet({ ...stored, accessExpiresAtEpochMs: "soon" }),
    (error) => error.code === "DI_PROTOCOL_CHANGED"
  );
});

test("session manager performs one refresh for concurrent callers and persists rotation before validation", async () => {
  const events = [];
  const store = new MemoryStore(tokenSet({ accessExpiresAtEpochMs: NOW + 1_000 }), events);
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let refreshCalls = 0;
  const refreshed = tokenSet({
    accessToken: "new-access",
    refreshToken: "rotated-refresh",
    accessExpiresAtEpochMs: NOW + 3_600_000
  });
  const lifecycle = {
    async exchange() { throw new Error("not used"); },
    async refresh() {
      refreshCalls += 1;
      events.push("refresh");
      await refreshGate;
      return refreshed;
    },
    async validate(tokens) {
      events.push(`validate:${tokens.accessToken}`);
    }
  };
  const manager = new DiSessionManager({ store, lifecycle, authState, now: () => NOW, refreshSkewMs: 60_000 });

  const first = manager.getValidSession();
  const second = manager.getValidSession();
  const third = manager.getValidSession();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1);
  releaseRefresh();

  assert.deepEqual(await Promise.all([first, second, third]), [refreshed, refreshed, refreshed]);
  assert.deepEqual(events, ["refresh", "save:new-access", "validate:new-access"]);
  assert.equal(store.value.refreshToken, "rotated-refresh");
});

test("session manager makes callers arriving after token rotation await validation", async () => {
  const old = tokenSet({ accessExpiresAtEpochMs: NOW });
  const refreshed = tokenSet({ accessToken: "new-access", accessExpiresAtEpochMs: NOW + 3_600_000 });
  const store = new MemoryStore(old);
  let releaseValidation;
  const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
  const lifecycle = lifecycleStub({
    async refresh() { return refreshed; },
    async validate() { await validationGate; }
  });
  const manager = new DiSessionManager({ store, lifecycle, authState, now: () => NOW, refreshSkewMs: 0 });

  const first = manager.getValidSession();
  while (store.value.accessToken !== "new-access") await new Promise((resolve) => setImmediate(resolve));
  let secondSettled = false;
  const second = manager.getValidSession().finally(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  releaseValidation();
  assert.deepEqual(await Promise.all([first, second]), [refreshed, refreshed]);
});

test("session manager leaves a fresh session untouched and reports a missing session distinctly", async () => {
  let refreshCalls = 0;
  const lifecycle = lifecycleStub({
    async refresh() {
      refreshCalls += 1;
      return tokenSet();
    }
  });
  const manager = new DiSessionManager({
    store: new MemoryStore(tokenSet({ accessExpiresAtEpochMs: NOW + 3_600_000 })),
    lifecycle,
    authState,
    now: () => NOW,
    refreshSkewMs: 60_000
  });
  assert.equal((await manager.getValidSession()).accessToken, "access-token");
  assert.equal(refreshCalls, 0);

  const empty = new DiSessionManager({ store: new MemoryStore(null), lifecycle, authState });
  await assert.rejects(empty.getValidSession(), (error) => error.code === "DI_SESSION_REQUIRED");
});

test("session manager validates before adopting a ticket-issued session", async () => {
  const events = [];
  const store = new MemoryStore(null, events);
  const lifecycle = lifecycleStub({
    async validate(tokens) {
      events.push(`validate:${tokens.accessToken}`);
    }
  });
  const manager = new DiSessionManager({ store, lifecycle, authState });

  await manager.adopt(tokenSet({ accessToken: "ticket-access" }));

  assert.deepEqual(events, ["validate:ticket-access", "save:ticket-access"]);
});

test("session manager preserves a rotated token when subsequent validation rejects it", async () => {
  const store = new MemoryStore(tokenSet({ accessExpiresAtEpochMs: NOW }));
  const rotated = tokenSet({ accessToken: "rotated-access", refreshToken: "rotated-refresh" });
  const lifecycle = lifecycleStub({
    async refresh() { return rotated; },
    async validate() { throw new DiAuthError("DI_TOKEN_REJECTED", "rejected", { status: 401 }); }
  });
  const manager = new DiSessionManager({ store, lifecycle, authState, now: () => NOW, refreshSkewMs: 0 });

  await assert.rejects(manager.getValidSession(), (error) => error.code === "DI_TOKEN_REJECTED");
  assert.deepEqual(store.value, rotated);
});

test("runWithSession refreshes and replays exactly once after a bearer rejection", async () => {
  const old = tokenSet({ accessToken: "old-access" });
  const refreshed = tokenSet({ accessToken: "refreshed-access", refreshToken: "rotated-refresh" });
  const store = new MemoryStore(old);
  let refreshCalls = 0;
  const lifecycle = lifecycleStub({
    async refresh() {
      refreshCalls += 1;
      return refreshed;
    }
  });
  const manager = new DiSessionManager({ store, lifecycle, authState, now: () => NOW });
  const seen = [];

  const result = await manager.runWithSession(async (tokens) => {
    seen.push(tokens.accessToken);
    if (tokens.accessToken === "old-access") {
      throw new DiAuthError("DI_TOKEN_REJECTED", "expired", { status: 401 });
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(refreshCalls, 1);
  assert.deepEqual(seen, ["old-access", "refreshed-access"]);
});

class MemoryStore {
  constructor(value, events = []) {
    this.value = value;
    this.events = events;
  }

  async load() {
    return this.value;
  }

  async save(tokens) {
    this.events.push(`save:${tokens.accessToken}`);
    this.value = tokens;
  }

  async delete() {
    this.value = null;
  }
}

function lifecycleStub(overrides = {}) {
  return {
    async exchange() { throw new Error("not used"); },
    async refresh(tokens) { return tokens; },
    async validate() {},
    ...overrides
  };
}

function tokenSet(overrides = {}) {
  return {
    backend: "private-di",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    clientId: "client-id",
    accessExpiresAtEpochMs: NOW + 3_600_000,
    refreshExpiresAtEpochMs: NOW + 7_200_000,
    ...overrides
  };
}

function storedTokenFile(overrides = {}) {
  return {
    schemaVersion: 1,
    ...tokenSet(),
    ...overrides
  };
}
