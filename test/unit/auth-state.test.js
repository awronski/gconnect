import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileAuthState } from "../../dist/auth/auth-state.js";
import { DiSessionManager, FileDiTokenStore } from "../../dist/auth/di/index.js";
import { AutoGarminDownloadService } from "../../dist/download/auto-garmin-download-service.js";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

test("active backend marker is atomic, owner-only, and is the sole download authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-auth-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const markerPath = join(directory, "active-backend.json");
  const state = new FileAuthState(markerPath, join(directory, "auth-state.lock"));
  const selected = [];
  const download = new AutoGarminDownloadService({
    authState: state,
    di: fakeDownload("di", selected),
    web: fakeDownload("web", selected)
  });

  assert.equal(await state.activeState(), null);
  await state.setActiveBackend("web-cookie");
  assert.equal(await download.profileId(), "web-profile");
  download.reset();
  await state.setActiveBackend("private-di");
  assert.equal(await download.profileId(), "di-profile");
  download.reset();
  await state.clearActiveBackend();
  const disconnected = await state.activeState();
  assert.equal(disconnected.backend, null);
  assert.match(disconnected.revision, /^[0-9a-f-]{36}$/i);
  await assert.rejects(download.profileId(), (error) => error.code === "AUTH_REQUIRED");
  assert.deepEqual(selected, ["web", "di"]);

  assert.equal(JSON.parse(await readFile(markerPath, "utf8")).activeBackend, null);
  await state.setActiveBackend("web-cookie");
  const firstRevision = (await state.activeState()).revision;
  await state.setActiveBackend("web-cookie");
  assert.notEqual((await state.activeState()).revision, firstRevision);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(markerPath, "utf8"))).sort(), [
    "activeBackend", "revision", "savedAt", "schemaVersion"
  ]);
  assert.equal(JSON.parse(await readFile(markerPath, "utf8")).schemaVersion, 3);
  const activeState = await state.activeState();
  assert.match(activeState.revision, /^[0-9a-f-]{36}$/i);
  if (process.platform !== "win32") assert.equal((await lstat(markerPath)).mode & 0o777, 0o600);
});

test("auth state hard-cuts to the revisioned nullable v3 schema", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-auth-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const markerPath = join(directory, "active-backend.json");
  const state = new FileAuthState(markerPath, join(directory, "auth-state.lock"));
  await writeFile(markerPath, `${JSON.stringify({
    schemaVersion: 2,
    activeBackend: "web-cookie",
    revision: "00000000-0000-4000-8000-000000000000",
    savedAt: new Date(NOW).toISOString()
  })}\n`, { mode: 0o600 });

  await assert.rejects(state.activeState(), (error) => error.code === "INVALID_CREDENTIAL_FILE");
  await rm(markerPath);
  await state.clearActiveBackend();
  const stored = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(stored.schemaVersion, 3);
  assert.equal(stored.activeBackend, null);
  assert.match(stored.revision, /^[0-9a-f-]{36}$/i);
  await state.clearActiveBackend();
  assert.notEqual(JSON.parse(await readFile(markerPath, "utf8")).revision, stored.revision);
});

test("two independent session managers serialize refresh and re-read the rotated token inside the lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-auth-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileDiTokenStore(join(directory, "di-session.json"));
  await store.save(tokenSet({ accessExpiresAtEpochMs: NOW }));
  const lockPath = join(directory, "auth-state.lock");
  const firstState = new FileAuthState(join(directory, "active-backend.json"), lockPath);
  const secondState = new FileAuthState(join(directory, "active-backend.json"), lockPath);
  let refreshCalls = 0;
  const lifecycle = {
    async refresh() {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 75));
      return tokenSet({
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
        accessExpiresAtEpochMs: NOW + 3_600_000
      });
    },
    async validate() {}
  };
  const first = new DiSessionManager({
    store,
    lifecycle,
    authState: firstState,
    now: () => NOW,
    refreshSkewMs: 0
  });
  const second = new DiSessionManager({
    store,
    lifecycle,
    authState: secondState,
    now: () => NOW,
    refreshSkewMs: 0
  });

  const sessions = await Promise.all([first.getValidSession(), second.getValidSession()]);

  assert.equal(refreshCalls, 1);
  assert.deepEqual(sessions.map((tokens) => tokens.refreshToken), ["rotated-refresh", "rotated-refresh"]);
  assert.equal((await store.load()).refreshToken, "rotated-refresh");
  await assert.rejects(lstat(lockPath), (error) => error.code === "ENOENT");
});

test("a lock left by a crashed process is removed without changing committed backend state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-auth-crash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const markerPath = join(directory, "active-backend.json");
  const lockPath = join(directory, "auth-state.lock");
  const state = new FileAuthState(markerPath, lockPath, { lockTimeoutMs: 1_000, retryDelayMs: 5 });
  await state.setActiveBackend("web-cookie");
  const deadPid = 999_999;
  assert.throws(() => process.kill(deadPid, 0), (error) => error.code === "ESRCH");
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: deadPid,
    token: "00000000-0000-4000-8000-000000000000",
    createdAt: new Date(NOW).toISOString()
  })}\n`, { mode: 0o600 });

  await state.runExclusive(async () => {
    assert.equal(await state.activeBackend(), "web-cookie");
    await state.setActiveBackend("private-di");
  });

  assert.equal(await state.activeBackend(), "private-di");
  await assert.rejects(lstat(lockPath), (error) => error.code === "ENOENT");
});

test("a live lock owner produces a bounded retryable busy error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-auth-busy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = join(directory, "auth-state.lock");
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    token: "00000000-0000-4000-8000-000000000000",
    createdAt: new Date().toISOString()
  })}\n`, { mode: 0o600 });
  const state = new FileAuthState(join(directory, "active-backend.json"), lockPath, {
    lockTimeoutMs: 30,
    retryDelayMs: 5
  });

  await assert.rejects(
    state.runExclusive(async () => undefined),
    (error) => error.code === "AUTH_STATE_BUSY" && error.details.retryable === true
  );
});

function fakeDownload(name, selected) {
  return {
    async json(request) {
      selected.push(name);
      return request.decode({});
    },
    async optionalJson(request) {
      selected.push(name);
      return request.decode({});
    },
    async profileId() {
      selected.push(name);
      return `${name}-profile`;
    }
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
