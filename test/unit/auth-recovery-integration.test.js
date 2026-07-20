import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import test from "node:test";
import { CookieJar } from "tough-cookie";

import { GarminAuthService } from "../../dist/auth/auth-service.js";
import { BrowserRecoveryRunner } from "../../dist/auth/recovery/browser-recovery-runner.js";
import { WebCookieRecoveryVerifier } from "../../dist/auth/recovery/web-cookie-verifier.js";

test("web recovery verifies home and a read-only probe before atomically replacing stored cookies", async () => {
  const oldJar = new CookieJar();
  await oldJar.setCookie("OLD=session; Domain=.garmin.com; Path=/; Secure", "https://connect.garmin.com/app/home");
  const saves = [];
  const store = {
    async load() { return oldJar; },
    async save(jar) { saves.push(jar); },
    async delete() {},
    path() { return "/test/web-session.json"; }
  };
  const requests = [];
  const verifier = new WebCookieRecoveryVerifier({
    store,
    async fetch(url, init) {
      requests.push({ url: String(url), cookie: new Headers(init.headers).get("cookie") });
      if (String(url).endsWith("/app/home")) {
        return new Response(`<meta name="csrf-token" content="csrf"><script>
          window.viewerIsAuthenticated = true;
          window.VIEWER_USERPREFERENCES = {"displayName":"profile_12345678"};
        </script>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response('{"userData":{}}', { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const verified = await verifier.prepare(transfer(), new AbortController().signal);
  assert.equal(verified.profileId, "profile_12345678");
  assert.equal(requests.length, 2);
  assert.match(requests[0].cookie, /SESSION=fresh/);
  assert.match(requests[1].cookie, /SESSION=fresh/);
  assert.equal(saves.length, 0);
  await Promise.all([verified.commit(), verified.commit()]);
  assert.equal(saves.length, 1);
  assert.doesNotMatch(await saves[0].getCookieString("https://connect.garmin.com/app/home"), /OLD=/);
});

test("failed recovery verification leaves the previous stored jar untouched", async () => {
  const oldJar = new CookieJar();
  const saves = [];
  const verifier = new WebCookieRecoveryVerifier({
    store: {
      async load() { return oldJar; },
      async save(jar) { saves.push(jar); },
      async delete() {},
      path() { return "/test/web-session.json"; }
    },
    async fetch() { return new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }); }
  });
  await assert.rejects(
    verifier.prepare(transfer(), new AbortController().signal),
    (error) => error.code === "AUTH_RECOVERY_VERIFICATION_FAILED"
      && error.details.stage === "home-bootstrap"
      && error.details.reasonCode === "AUTH_REQUIRED"
      && error.details.status === 200
  );
  assert.equal(saves.length, 0);
});

test("web recovery preserves a host-only prefixed session cookie", async () => {
  const requests = [];
  const verifier = new WebCookieRecoveryVerifier({
    store: {
      async load() { return null; },
      async save() {},
      async delete() {},
      path() { return "/test/web-session.json"; }
    },
    async fetch(url, init) {
      requests.push(new Headers(init.headers).get("cookie"));
      if (String(url).endsWith("/app/home")) {
        return new Response(`<meta name="csrf-token" content="csrf"><script>
          window.viewerIsAuthenticated = true;
          window.VIEWER_USERPREFERENCES = {"displayName":"profile_12345678"};
        </script>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response('{"userData":{}}', { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const hostOnlyTransfer = transfer();
  hostOnlyTransfer.cookies[0] = {
    ...hostOnlyTransfer.cookies[0],
    name: "__Host-SESSION",
    domain: "connect.garmin.com",
    hostOnly: true
  };

  await verifier.prepare(hostOnlyTransfer, new AbortController().signal);

  assert.equal(requests.length, 2);
  assert.match(requests[0], /__Host-SESSION=fresh/);
  assert.match(requests[1], /__Host-SESSION=fresh/);
});

test("browser recovery runner prints only a safe link and completes after companion submission", async () => {
  let stderr = "";
  const opened = [];
  const runner = new BrowserRecoveryRunner({
    verifier: {
      async prepare() {
        return { profileId: "private-profile", async commit() {} };
      }
    },
    stderr: { write(value) { stderr += value; } },
    openUrl: async (url) => { opened.push(url); }
  });
  const completion = runner.recover({ timeoutMs: 2_000, openBrowser: true });
  while (!/http:\/\/127\.0\.0\.1:\d+\/recover\/[A-Za-z0-9_-]{43}/.test(stderr)) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const url = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/recover\/[A-Za-z0-9_-]{43}/)[0];
  const nonce = url.split("/").at(-1);
  const response = await fetch(`${url}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transfer(nonce))
  });
  assert.equal(response.status, 202);
  const prepared = await completion;
  assert.equal((await fetch(`${url}/status`)).status, 200);
  assert.equal(prepared.mechanism, "browser_companion");
  assert.equal(typeof prepared.commit, "function");
  assert.deepEqual(opened, [url]);
  const companionDirectory = stderr.match(/Load unpacked, and select:\n([^\n]+)/)?.[1];
  assert.ok(companionDirectory);
  assert.equal(isAbsolute(companionDirectory), true);
  assert.match(companionDirectory, /browser-companion\/?$/);
  assert.match(stderr, /browser session verified/);
  assert.match(stderr, /With the recovery page active, click the GConnect Browser Companion action/);
  assert.match(stderr, /Extensions\/puzzle menu/);
  assert.doesNotMatch(stderr, /Garmin Connect is connected/);
  assert.doesNotMatch(stderr, /fresh|private-profile|SESSION/);
});

test("auth-state lock is acquired only after browser preparation completes", async () => {
  const events = [];
  let finishPreparation;
  const preparationCanFinish = new Promise((resolve) => { finishPreparation = resolve; });
  const fixture = authServiceFixture({
    events,
    recovery: {
      async recover() {
        assert.equal(fixture.locked(), false);
        events.push("prepare:start");
        await preparationCanFinish;
        events.push("prepare:done");
        return {
          mechanism: "browser_companion",
          async commit() {
            assert.equal(fixture.locked(), true);
            events.push("cookies:commit");
          }
        };
      }
    }
  });

  const pending = fixture.service.recover({ timeoutMs: 900_000, openBrowser: false });
  while (!events.includes("prepare:start")) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["state:read", "prepare:start"]);
  finishPreparation();

  assert.deepEqual(await pending, { mechanism: "browser_companion" });
  assert.deepEqual(events, [
    "state:read",
    "prepare:start",
    "prepare:done",
    "lock:enter",
    "state:read:locked",
    "cookies:commit",
    "marker:web-cookie",
    "di:delete",
    "lock:exit",
    "backend:changed"
  ]);
});

test("failed browser preparation changes neither credentials nor backend marker", async () => {
  const events = [];
  const fixture = authServiceFixture({
    events,
    recovery: {
      async recover() {
        events.push("prepare:failed");
        throw new Error("verification failed");
      }
    }
  });

  await assert.rejects(fixture.service.recover({ timeoutMs: 2_000, openBrowser: false }), /verification failed/);
  assert.deepEqual(events, ["state:read", "prepare:failed"]);
  assert.deepEqual(fixture.state(), { backend: "private-di", revision: "before-recovery" });
});

test("recovery refuses to overwrite auth state changed during browser wait", async () => {
  const events = [];
  let finishPreparation;
  const preparationCanFinish = new Promise((resolve) => { finishPreparation = resolve; });
  let commitCalls = 0;
  const fixture = authServiceFixture({
    events,
    recovery: {
      async recover() {
        events.push("prepare:start");
        await preparationCanFinish;
        return {
          mechanism: "browser_companion",
          async commit() { commitCalls += 1; }
        };
      }
    }
  });

  const pending = fixture.service.recover({ timeoutMs: 2_000, openBrowser: false });
  while (!events.includes("prepare:start")) await new Promise((resolve) => setImmediate(resolve));
  fixture.replaceState({ backend: "private-di", revision: "concurrent-login" });
  finishPreparation();

  await assert.rejects(pending, (error) => error.code === "AUTH_STATE_CHANGED");
  assert.equal(commitCalls, 0);
  assert.equal(events.includes("marker:web-cookie"), false);
  assert.equal(events.includes("di:delete"), false);
});

test("a disconnect creates a revisioned tombstone that cancels recovery started from missing state", async () => {
  const events = [];
  let finishPreparation;
  const preparationCanFinish = new Promise((resolve) => { finishPreparation = resolve; });
  let commitCalls = 0;
  const fixture = authServiceFixture({
    events,
    initialState: null,
    recovery: {
      async recover() {
        events.push("prepare:start");
        await preparationCanFinish;
        return {
          mechanism: "browser_companion",
          async commit() { commitCalls += 1; }
        };
      }
    }
  });

  const pending = fixture.service.recover({ timeoutMs: 2_000, openBrowser: false });
  while (!events.includes("prepare:start")) await new Promise((resolve) => setImmediate(resolve));
  await fixture.service.disconnect();
  finishPreparation();

  await assert.rejects(pending, (error) => error.code === "AUTH_STATE_CHANGED");
  assert.equal(commitCalls, 0);
  assert.deepEqual(fixture.state(), { backend: null, revision: "committed-disconnect" });
});

test("recovery detects a disconnected to login to disconnected ABA transition", async () => {
  const events = [];
  let finishPreparation;
  const preparationCanFinish = new Promise((resolve) => { finishPreparation = resolve; });
  let commitCalls = 0;
  const fixture = authServiceFixture({
    events,
    initialState: { backend: null, revision: "before-recovery" },
    recovery: {
      async recover() {
        events.push("prepare:start");
        await preparationCanFinish;
        return {
          mechanism: "browser_companion",
          async commit() { commitCalls += 1; }
        };
      }
    }
  });

  const pending = fixture.service.recover({ timeoutMs: 2_000, openBrowser: false });
  while (!events.includes("prepare:start")) await new Promise((resolve) => setImmediate(resolve));
  fixture.replaceState({ backend: "private-di", revision: "concurrent-login" });
  await fixture.service.disconnect();
  finishPreparation();

  await assert.rejects(pending, (error) => error.code === "AUTH_STATE_CHANGED");
  assert.equal(commitCalls, 0);
  assert.deepEqual(fixture.state(), { backend: null, revision: "committed-disconnect" });
});

test("post-commit recovery cleanup failures preserve the new backend and expose actionable state", async () => {
  const events = [];
  const fixture = authServiceFixture({
    events,
    deleteDiError: new Error("secret cleanup failure"),
    recovery: successfulRecovery(events)
  });

  await assert.rejects(
    fixture.service.recover({ timeoutMs: 2_000, openBrowser: false }),
    (error) => {
      assert.equal(error.code, "AUTH_TRANSITION_FINALIZATION_FAILED");
      assert.deepEqual(error.details, committedCleanupDetails("web-cookie"));
      assert.doesNotMatch(JSON.stringify(error.details), /secret cleanup failure/);
      return true;
    }
  );
  assert.deepEqual(fixture.state(), { backend: "web-cookie", revision: "committed-recovery" });
  assert.deepEqual(events, [
    "state:read",
    "lock:enter",
    "state:read:locked",
    "cookies:commit",
    "marker:web-cookie",
    "di:delete",
    "lock:exit",
    "backend:changed"
  ]);
});

test("a lock-release failure after recovery commit gets the same truthful classification", async () => {
  const events = [];
  const fixture = authServiceFixture({
    events,
    lockReleaseError: new Error("lock release failed"),
    recovery: successfulRecovery(events)
  });

  await assert.rejects(
    fixture.service.recover({ timeoutMs: 2_000, openBrowser: false }),
    (error) => {
      assert.equal(error.code, "AUTH_TRANSITION_FINALIZATION_FAILED");
      assert.deepEqual(error.details, committedCleanupDetails("web-cookie", true));
      return true;
    }
  );
  assert.deepEqual(fixture.state(), { backend: "web-cookie", revision: "committed-recovery" });
  assert.equal(events.at(-1), "backend:changed");
});

test("disconnect cleanup failure reports that the disconnected state was already committed", async () => {
  const events = [];
  const fixture = authServiceFixture({
    events,
    deleteDiError: new Error("secret cleanup failure"),
    recovery: successfulRecovery(events)
  });

  await assert.rejects(
    fixture.service.disconnect(),
    (error) => {
      assert.equal(error.code, "AUTH_TRANSITION_FINALIZATION_FAILED");
      assert.deepEqual(error.details, committedCleanupDetails(null));
      return true;
    }
  );
  assert.deepEqual(fixture.state(), { backend: null, revision: "committed-disconnect" });
  assert.deepEqual(events, [
    "lock:enter",
    "marker:clear",
    "di:delete",
    "web:delete",
    "lock:exit",
    "backend:changed"
  ]);
});

test("listener startup failure does not poison later browser recovery", async () => {
  const runner = new BrowserRecoveryRunner({
    verifier: { async prepare() { return { profileId: "profile_12345678", async commit() {} }; } },
    stderr: { write() {} }
  });
  await assert.rejects(
    runner.recover({ timeoutMs: 1, openBrowser: false }),
    (error) => error.code === "INVALID_RECOVERY_OPTION"
  );
  await assert.rejects(
    runner.recover({ timeoutMs: 10, openBrowser: false }),
    (error) => error.code === "AUTH_RECOVERY_TIMEOUT"
  );
});

function authServiceFixture({
  events,
  recovery,
  initialState = { backend: "private-di", revision: "before-recovery" },
  deleteDiError = null,
  lockReleaseError = null
}) {
  let locked = false;
  let activeState = initialState;
  const authState = {
    async activeState() {
      events.push(locked ? "state:read:locked" : "state:read");
      return activeState;
    },
    async activeBackend() { return activeState?.backend ?? null; },
    async setActiveBackend(backend) {
      assert.equal(locked, true);
      events.push(`marker:${backend}`);
      activeState = { backend, revision: "committed-recovery" };
    },
    async clearActiveBackend() {
      assert.equal(locked, true);
      events.push("marker:clear");
      activeState = { backend: null, revision: "committed-disconnect" };
    },
    async runExclusive(operation) {
      assert.equal(locked, false);
      events.push("lock:enter");
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
        events.push("lock:exit");
        if (lockReleaseError !== null) throw lockReleaseError;
      }
    }
  };
  const service = new GarminAuthService({
    input: {},
    authenticator: () => ({}),
    diStore: {
      async load() { return null; },
      async save() {},
      async delete() {
        assert.equal(locked, true);
        events.push("di:delete");
        if (deleteDiError !== null) throw deleteDiError;
      }
    },
    diSessions: {},
    diTokens: {},
    webSessions: {
      async disconnect() {
        assert.equal(locked, true);
        events.push("web:delete");
      }
    },
    authState,
    recovery,
    onBackendChanged: () => events.push("backend:changed")
  });
  return {
    service,
    locked: () => locked,
    state: () => activeState,
    replaceState: (value) => { activeState = value; }
  };
}

function successfulRecovery(events) {
  return {
    async recover() {
      return {
        mechanism: "browser_companion",
        async commit() { events.push("cookies:commit"); }
      };
    }
  };
}

function committedCleanupDetails(activeBackend, credentialCleanupCompleted = false) {
  return {
    transitionCommitted: true,
    activeBackend,
    credentialCleanupCompleted,
    credentialsMayRemain: !credentialCleanupCompleted,
    nextCommand: credentialCleanupCompleted ? "gconnect auth status" : "gconnect auth disconnect",
    retryable: true
  };
}

function transfer(nonce = "n".repeat(43)) {
  return {
    protocolVersion: 2,
    nonce,
    source: "browser-companion",
    cookies: [{
      name: "SESSION",
      value: "fresh",
      domain: ".garmin.com",
      hostOnly: false,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax"
    }]
  };
}
