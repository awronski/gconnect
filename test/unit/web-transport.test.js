import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CookieJar } from "tough-cookie";

import { StoredWebSessionManager } from "../../dist/auth/web/web-session-manager.js";
import { FileWebSessionStore } from "../../dist/auth/web/web-session-store.js";
import { WebGarminDownloadService } from "../../dist/download/web-garmin-download-service.js";

const origin = "https://connect.garmin.com";

test("web session bootstrap extracts CSRF/profile state and persists updated cookies", async () => {
  const jar = new CookieJar();
  await jar.setCookie("SESSION=abc; Path=/; Secure; HttpOnly", `${origin}/app/home`);
  const calls = [];
  let saves = 0;
  const store = {
    async load() { return jar; },
    async save(saved) { assert.equal(saved, jar); saves += 1; },
    async delete() {},
    path() { return "/test/web-session.json"; }
  };
  const manager = new StoredWebSessionManager({
    store,
    async fetch(url, init) {
      calls.push({ url: String(url), cookie: new Headers(init.headers).get("cookie") });
      return new Response(`<!doctype html><meta content="csrf-value" name="csrf-token">
        <script>window.viewerIsAuthenticated = true;
        window.VIEWER_USERPREFERENCES = {"displayName":"profile_12345678"};</script>`, {
        status: 200,
        headers: { "content-type": "text/html", "set-cookie": "ROTATED=yes; Path=/; Secure" }
      });
    }
  });

  const session = await manager.session();
  assert.equal(session.csrfToken, "csrf-value");
  assert.equal(session.profileId, "profile_12345678");
  assert.match(calls[0].cookie, /SESSION=abc/);
  assert.equal(saves, 1);
  assert.match(await jar.getCookieString(`${origin}/app/home`), /ROTATED=yes/);
});

test("web session bootstrap rejects a successful login HTML response", async () => {
  const manager = new StoredWebSessionManager({
    store: memoryStore(new CookieJar()),
    async fetch() { return new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } }); }
  });
  await assert.rejects(manager.session(), (error) => error.code === "AUTH_REQUIRED");
});

test("file web session store rejects malformed or non-Garmin serialized cookies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-web-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "web-session.json");
  const store = new FileWebSessionStore(path);
  for (const cookie of [
    {},
    { key: "SESSION", value: "x", domain: "example.com", path: "/" },
    { key: "SESSION", value: "x", domain: "connect.garmin.com", path: "relative" }
  ]) {
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      backend: "web-cookie",
      savedAt: "2026-07-17T12:00:00.000Z",
      cookieJar: {
        version: "tough-cookie@6.0.0",
        storeType: "MemoryCookieStore",
        rejectPublicSuffixes: true,
        cookies: [cookie]
      }
    }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(path, 0o600);
    await assert.rejects(store.load(), (error) => error.code === "INVALID_CREDENTIAL_FILE");
  }
});

test("web session bootstrap bounds network waits and honors caller cancellation", async () => {
  const hangingFetch = async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) {
      reject(init.signal.reason);
      return;
    }
    init.signal.addEventListener("abort", () => {
      reject(init.signal.reason);
    }, { once: true });
  });
  const timed = new StoredWebSessionManager({
    store: memoryStore(new CookieJar()),
    fetch: hangingFetch,
    bootstrapTimeoutMs: 5
  });
  await assert.rejects(timed.session(), (error) => error.code === "NETWORK_ERROR");

  const controller = new AbortController();
  const cancelled = new StoredWebSessionManager({
    store: memoryStore(new CookieJar()),
    fetch: hangingFetch,
    bootstrapTimeoutMs: 1_000
  });
  const reason = new Error("caller cancelled");
  const pending = cancelled.session(false, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("web bootstrap does not hold the auth lock during network I/O", async () => {
  const events = [];
  let releaseFetch;
  const fetchBlocked = new Promise((resolve) => { releaseFetch = resolve; });
  const authState = {
    async activeState() { events.push("state"); return { backend: "web-cookie", revision: "current" }; },
    async runExclusive(operation) {
      events.push("lock:start");
      try { return await operation(); } finally { events.push("lock:end"); }
    }
  };
  const manager = new StoredWebSessionManager({
    store: memoryStore(new CookieJar()),
    authState,
    async fetch() {
      events.push("fetch:start");
      await fetchBlocked;
      events.push("fetch:end");
      return new Response(`<!doctype html><meta name="csrf-token" content="csrf">
        <script>viewerIsAuthenticated = true; VIEWER_USERPREFERENCES = {"displayName":"profile_12345678"};</script>`);
    }
  });
  const pending = manager.session();
  while (!events.includes("fetch:start")) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["state", "fetch:start"]);
  releaseFetch();
  await pending;
  assert.deepEqual(events, ["state", "fetch:start", "fetch:end", "lock:start", "state", "lock:end"]);
});

test("stale web session persistence cannot overwrite a recovered marker revision", async () => {
  const oldJar = new CookieJar();
  const recoveredJar = new CookieJar();
  let stored = oldJar;
  let revision = "old";
  const store = {
    async load() { return stored; },
    async save(jar) { stored = jar; },
    async delete() { stored = null; },
    path() { return "/test/web-session.json"; }
  };
  const authState = {
    async activeState() { return { backend: "web-cookie", revision }; },
    async runExclusive(operation) { return operation(); }
  };
  const manager = new StoredWebSessionManager({
    store,
    authState,
    async fetch() {
      return new Response(`<!doctype html><meta name="csrf-token" content="csrf">
        <script>viewerIsAuthenticated = true; VIEWER_USERPREFERENCES = {"displayName":"profile_12345678"};</script>`);
    }
  });
  await manager.session();
  stored = recoveredJar;
  revision = "recovered";
  await assert.rejects(manager.persist(), (error) => error.code === "AUTH_STATE_CHANGED");
  assert.equal(stored, recoveredJar);
});

test("web download sends cookies and CSRF, builds stable query, and validates JSON", async () => {
  const jar = new CookieJar();
  await jar.setCookie("SESSION=abc; Path=/; Secure", origin);
  const fetches = [];
  const sessions = sessionManager(jar);
  const download = new WebGarminDownloadService({
    sessions,
    async fetch(url, init) {
      fetches.push({ url: String(url), headers: new Headers(init.headers) });
      return jsonResponse({ value: 42 });
    },
    sleep: async () => undefined
  });
  const value = await download.json({
    path: "/gc-api/test",
    query: { z: 2, a: ["x", "y"] },
    decode: (input) => input.value
  });
  assert.equal(value, 42);
  assert.equal(fetches[0].url, `${origin}/gc-api/test?a=x&a=y&z=2`);
  assert.equal(fetches[0].headers.get("connect-csrf-token"), "csrf");
  assert.match(fetches[0].headers.get("cookie"), /SESSION=abc/);
  assert.equal(await download.profileId(), "profile-id");
});

test("web download retries bounded 5xx and refreshes CSRF once after 403", async () => {
  const jar = new CookieJar();
  const sessionCalls = [];
  const sleeps = [];
  let calls = 0;
  const sessions = sessionManager(jar, sessionCalls);
  const download = new WebGarminDownloadService({
    sessions,
    async fetch() {
      calls += 1;
      if (calls === 1) return new Response("server", { status: 503 });
      if (calls === 2) return new Response("forbidden", { status: 403 });
      return jsonResponse({ ok: true });
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); }
  });
  const value = await download.json({ path: "/gc-api/test", decode: (input) => input });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [200]);
  assert.deepEqual(sessionCalls, [false, false, true]);
});

test("CSRF refresh gets one real retry after the transient retry budget was partly used", async () => {
  const sessionCalls = [];
  let forbiddenBodyCancelled = false;
  let calls = 0;
  const download = new WebGarminDownloadService({
    sessions: sessionManager(new CookieJar(), sessionCalls),
    maximumAttempts: 2,
    async fetch() {
      calls += 1;
      if (calls === 1) return new Response("server", { status: 503 });
      if (calls === 2) {
        return new Response(new ReadableStream({
          cancel() { forbiddenBodyCancelled = true; }
        }), { status: 403 });
      }
      return jsonResponse({ ok: true });
    },
    sleep: async () => undefined
  });
  assert.deepEqual(await download.json({ path: "/gc-api/test", decode: (input) => input }), { ok: true });
  assert.equal(calls, 3);
  assert.equal(forbiddenBodyCancelled, true);
  assert.deepEqual(sessionCalls, [false, false, true]);
});

test("web download classifies auth, rate limits, network exhaustion, and protocol changes", async (t) => {
  const cases = [
    {
      name: "html",
      fetch: async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
      code: "AUTH_REQUIRED"
    },
    { name: "redirect", fetch: async () => new Response(null, { status: 302, headers: { location: "/signin" } }), code: "AUTH_REQUIRED" },
    { name: "rate", fetch: async () => new Response("", { status: 429, headers: { "retry-after": "60" } }), code: "RATE_LIMITED" },
    { name: "network", fetch: async () => { throw new Error("ECONNRESET"); }, code: "NETWORK_ERROR" },
    { name: "invalid-json", fetch: async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }), code: "PROTOCOL_CHANGED" }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const download = new WebGarminDownloadService({
        sessions: sessionManager(new CookieJar()),
        fetch: item.fetch,
        maximumAttempts: 2,
        sleep: async () => undefined
      });
      await assert.rejects(
        download.json({ path: "/gc-api/test", decode: (input) => input }),
        (error) => error.code === item.code
      );
    });
  }
});

test("web download never persists cookies from an authentication failure", async () => {
  let persists = 0;
  const sessions = sessionManager(new CookieJar());
  sessions.persist = async () => { persists += 1; };
  const download = new WebGarminDownloadService({
    sessions,
    fetch: async () => new Response(null, { status: 401 })
  });
  await assert.rejects(
    download.json({ path: "/gc-api/test", decode: (input) => input }),
    (error) => error.code === "AUTH_REQUIRED"
  );
  assert.equal(persists, 0);
});

test("optional web downloads map observed 204 no-data responses to null but preserve 404 failures", async () => {
  const noContent = new WebGarminDownloadService({
    sessions: sessionManager(new CookieJar()),
    fetch: async () => new Response(null, { status: 204 }),
    sleep: async () => undefined
  });
  assert.equal(await noContent.optionalJson({ path: "/gc-api/test", decode: () => { throw new Error("not called"); } }), null);

  const missing = new WebGarminDownloadService({
    sessions: sessionManager(new CookieJar()),
    fetch: async () => new Response(null, { status: 404 }),
    sleep: async () => undefined
  });
  await assert.rejects(
    missing.optionalJson({ path: "/gc-api/test", decode: (input) => input }),
    (error) => error.code === "NOT_FOUND"
  );
});

test("non-optional web 204 responses are passed to the decoder as null", async () => {
  const download = new WebGarminDownloadService({
    sessions: sessionManager(new CookieJar()),
    fetch: async () => new Response(null, { status: 204 })
  });
  assert.equal(await download.json({ path: "/gc-api/test", decode: (input) => input }), null);
});

function sessionManager(jar, calls = []) {
  return {
    async session(force = false) {
      calls.push(force);
      return { cookieJar: jar, csrfToken: force ? "fresh-csrf" : "csrf", profileId: "profile-id" };
    },
    async persist() {},
    async disconnect() {},
    async hasStoredSession() { return true; }
  };
}

function memoryStore(jar) {
  return {
    async load() { return jar; },
    async save() {},
    async delete() {},
    path() { return "/test/session.json"; }
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
