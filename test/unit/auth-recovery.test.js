import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  isLoopbackRemoteAddress,
  startBrowserCompanionRecovery
} from "../../dist/auth/recovery/index.js";
import { CliError } from "../../dist/core/errors.js";

test("recovery listener uses a 256-bit nonce and serves only redacted pages with safe headers", async () => {
  const startedAt = Date.now();
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 60_000,
    prepare: async () => ({ verified: true })
  });
  const completion = assert.rejects(handle.completion, (error) => error?.code === "AUTH_RECOVERY_CANCELLED");
  try {
    const nonce = nonceFrom(handle.url);
    assert.equal(Buffer.from(nonce, "base64url").byteLength, 32);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/recover\/[A-Za-z0-9_-]{43}$/);

    const page = await localRequest(handle.url);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.match(page.headers["content-security-policy"], /default-src 'none'/);
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(page.headers["access-control-allow-origin"], undefined);
    assert.equal(page.body.includes(nonce), false);
    assert.match(page.body, /With this recovery page active, click the GConnect Browser Companion action/);
    assert.match(page.body, /Chrome's Extensions \(puzzle\) menu/);
    assert.match(page.body, /gconnect-recovery-expires-at/);

    const status = await localRequest(`${handle.url}/status`);
    assert.equal(status.status, 200);
    const statusBody = JSON.parse(status.body);
    assert.equal(statusBody.status, "waiting");
    assert.equal(Number.isSafeInteger(statusBody.expiresAt), true);
    assert.ok(statusBody.expiresAt >= startedAt + 60_000);
    assert.ok(statusBody.expiresAt <= Date.now() + 60_000);
    assert.equal(status.body.includes("cookie"), false);
  } finally {
    await handle.cancel();
    await completion;
  }
});

test("recovery listener rejects hostile Host headers, wrong paths, and non-loopback addresses", async () => {
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    prepare: async () => ({ verified: true })
  });
  const completion = assert.rejects(handle.completion, (error) => error?.code === "AUTH_RECOVERY_CANCELLED");
  try {
    const hostile = await localRequest(handle.url, { host: "evil.example" });
    assert.equal(hostile.status, 403);
    assert.deepEqual(JSON.parse(hostile.body), { error: { code: "INVALID_HOST" } });

    const wrongNonceUrl = handle.url.replace(nonceFrom(handle.url), "A".repeat(43));
    const wrongNonce = await localRequest(wrongNonceUrl);
    assert.equal(wrongNonce.status, 404);

    assert.equal(isLoopbackRemoteAddress("127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("::1"), true);
    assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("10.0.0.4"), false);
    assert.equal(isLoopbackRemoteAddress(undefined), false);
  } finally {
    await handle.cancel();
    await completion;
  }
});

test("body nonce mismatch is rejected without consuming the recovery", async () => {
  let verifyCalls = 0;
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    prepare: async () => {
      verifyCalls += 1;
      return { verified: true };
    }
  });
  const completion = assert.rejects(handle.completion, (error) => error?.code === "AUTH_RECOVERY_CANCELLED");
  try {
    const response = await postTransfer(handle.url, validTransfer("wrong-nonce"));
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), { error: { code: "RECOVERY_NONCE_MISMATCH" } });
    assert.equal(verifyCalls, 0);
    assert.equal(handle.status(), "waiting");
  } finally {
    await handle.cancel();
    await completion;
  }
});

test("oversized transfers are rejected before JSON parsing or verification", async () => {
  let verifyCalls = 0;
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    maximumBodyBytes: 256,
    prepare: async () => {
      verifyCalls += 1;
      return { verified: true };
    }
  });
  const completion = assert.rejects(handle.completion, (error) => error?.code === "AUTH_RECOVERY_CANCELLED");
  try {
    for (const omitContentLength of [false, true]) {
      const response = await localRequest(`${handle.url}/session`, {
        method: "POST",
        body: "x".repeat(257),
        omitContentLength,
        headers: { "Content-Type": "text/plain;charset=UTF-8" }
      });
      assert.equal(response.status, 413);
      assert.deepEqual(JSON.parse(response.body), { error: { code: "PAYLOAD_TOO_LARGE" } });
    }
    assert.equal(verifyCalls, 0);
    assert.equal(handle.status(), "waiting");
  } finally {
    await handle.cancel();
    await completion;
  }
});

test("invalid cookie schemas, domains, paths, and duplicates never reach verification", async () => {
  let verifyCalls = 0;
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    prepare: async () => {
      verifyCalls += 1;
      return { verified: true };
    }
  });
  const completion = assert.rejects(handle.completion, (error) => error?.code === "AUTH_RECOVERY_CANCELLED");
  try {
    const nonce = nonceFrom(handle.url);
    const cookie = validCookie();
    const invalidTransfers = [
      { ...validTransfer(nonce), protocolVersion: 1 },
      { ...validTransfer(nonce), cookies: [{ ...cookie, domain: ".evil.example" }] },
      { ...validTransfer(nonce), cookies: [{ ...cookie, hostOnly: "yes" }] },
      { ...validTransfer(nonce), cookies: [{ ...cookie, hostOnly: true }] },
      { ...validTransfer(nonce), cookies: [{ ...cookie, path: "/gc-api" }] },
      { ...validTransfer(nonce), cookies: [{ ...cookie, value: "bad\nvalue" }] },
      { ...validTransfer(nonce), cookies: [{ ...cookie, extra: "not-allowed" }] },
      { ...validTransfer(nonce), cookies: [cookie, cookie] }
    ];
    for (const transfer of invalidTransfers) {
      const response = await postTransfer(handle.url, transfer);
      assert.equal(response.status, 400, JSON.stringify(transfer, redactCookieValues));
      assert.deepEqual(JSON.parse(response.body), { error: { code: "INVALID_RECOVERY_TRANSFER" } });
    }
    assert.equal(verifyCalls, 0);
    assert.equal(handle.status(), "waiting");
  } finally {
    await handle.cancel();
    await completion;
  }
});

test("one successful transfer is acknowledged before verification and later reports completion", async () => {
  let received;
  const session = { csrfToken: "stored-outside-response" };
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    prepare: async (transfer) => {
      received = transfer;
      return session;
    }
  });
  const nonce = nonceFrom(handle.url);
  const response = await postTransfer(handle.url, validTransfer(nonce));
  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(response.body), { status: "verifying" });
  const completed = await handle.completion;
  assert.equal(response.body.includes("cookie-secret"), false);
  assert.equal(handle.status(), "complete");
  assert.equal(completed.mechanism, "browser_companion");
  assert.equal(completed.session, session);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received.cookies), true);
  assert.deepEqual(received.cookies[0], validCookie());

  const terminalStatus = await localRequest(`${handle.url}/status`);
  assert.deepEqual(JSON.parse(terminalStatus.body), {
    status: "complete",
    expiresAt: JSON.parse(terminalStatus.body).expiresAt
  });
  await eventuallyRejects(() => localRequest(handle.url));
});

test("slow verification outlives the submission request and concurrent replay is rejected", async () => {
  let enterVerification;
  let finishVerification;
  const verificationEntered = new Promise((resolve) => {
    enterVerification = resolve;
  });
  const verificationCanFinish = new Promise((resolve) => {
    finishVerification = resolve;
  });
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    prepare: async () => {
      enterVerification();
      await verificationCanFinish;
      return { verified: true };
    }
  });
  const transfer = validTransfer(nonceFrom(handle.url));
  const first = postTransfer(handle.url, transfer);
  await verificationEntered;

  const acknowledgement = await first;
  assert.equal(acknowledgement.status, 202);
  assert.deepEqual(JSON.parse(acknowledgement.body), { status: "verifying" });
  assert.equal(handle.status(), "verifying");
  const inProgressStatus = await localRequest(`${handle.url}/status`);
  assert.equal(JSON.parse(inProgressStatus.body).status, "verifying");

  const replay = await postTransfer(handle.url, transfer);
  assert.equal(replay.status, 409);
  assert.deepEqual(JSON.parse(replay.body), { error: { code: "RECOVERY_IN_PROGRESS" } });

  finishVerification();
  await handle.completion;
  const terminalStatus = await localRequest(`${handle.url}/status`);
  assert.equal(JSON.parse(terminalStatus.body).status, "complete");
});

test("verification failure is redacted and exposed only as terminal status", async () => {
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    prepare: async () => {
      throw new Error("sensitive upstream body must not escape");
    }
  });
  const response = await postTransfer(handle.url, validTransfer(nonceFrom(handle.url)));

  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(response.body), { status: "verifying" });
  assert.equal(response.body.includes("sensitive"), false);
  await assert.rejects(handle.completion, (error) => {
    assert.equal(error.code, "AUTH_RECOVERY_FAILED");
    assert.equal(error.message.includes("sensitive"), false);
    return true;
  });
  assert.equal(handle.status(), "failed");
  const terminalStatus = await localRequest(`${handle.url}/status`);
  assert.equal(JSON.parse(terminalStatus.body).status, "failed");
  assert.doesNotMatch(terminalStatus.body, /sensitive|upstream|body/i);
});

test("verification keeps safe retryable classification internally while browser response stays generic", async () => {
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    prepare: async () => {
      throw new CliError("NETWORK_ERROR", "sensitive upstream network detail", {
        retryable: true,
        token: "sensitive-token"
      }, 1);
    }
  });
  const response = await postTransfer(handle.url, validTransfer(nonceFrom(handle.url)));
  assert.deepEqual(JSON.parse(response.body), { status: "verifying" });
  await assert.rejects(handle.completion, (error) =>
    error.code === "NETWORK_ERROR"
      && error.details.retryable === true
      && !error.message.includes("sensitive"));
  const terminalStatus = await localRequest(`${handle.url}/status`);
  assert.equal(JSON.parse(terminalStatus.body).status, "failed");
  assert.doesNotMatch(terminalStatus.body, /network|sensitive|token/i);
});

test("verification failure exposes only a safe stage, reason code, and status", async () => {
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    prepare: async () => {
      throw new CliError("AUTH_RECOVERY_VERIFICATION_FAILED", "sensitive verifier detail", {
        stage: "home-bootstrap",
        reasonCode: "AUTH_REQUIRED",
        status: 302,
        token: "sensitive-token"
      }, 3);
    }
  });
  await postTransfer(handle.url, validTransfer(nonceFrom(handle.url)));

  await assert.rejects(handle.completion, (error) => {
    assert.equal(error.code, "AUTH_RECOVERY_FAILED");
    assert.deepEqual(error.details, {
      stage: "home-bootstrap",
      reasonCode: "AUTH_REQUIRED",
      status: 302
    });
    assert.doesNotMatch(JSON.stringify(error), /sensitive|token/i);
    return true;
  });
});

test("timeout invalidates the listener and rejects completion", async () => {
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 25,
    prepare: async () => ({ verified: true })
  });
  await assert.rejects(handle.completion, (error) => error?.code === "AUTH_RECOVERY_TIMEOUT");
  assert.equal(handle.status(), "failed");
  await assert.rejects(() => localRequest(handle.url));
});

test("timeout aborts an in-flight verifier and a late callback cannot revive recovery", async () => {
  let enterVerification;
  let observedAbort = false;
  const verificationEntered = new Promise((resolve) => {
    enterVerification = resolve;
  });
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 100,
    prepare: async (_transfer, signal) => {
      enterVerification();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      return { verified: true };
    }
  });
  const submission = postTransfer(handle.url, validTransfer(nonceFrom(handle.url)));
  await verificationEntered;
  assert.equal((await submission).status, 202);
  await assert.rejects(handle.completion, (error) => error?.code === "AUTH_RECOVERY_TIMEOUT");
  assert.equal(observedAbort, true);
  assert.equal(handle.status(), "failed");
});

test("cancel is idempotent, invalidates the listener, and rejects completion", async () => {
  const handle = await startBrowserCompanionRecovery({
    timeoutMs: 2_000,
    prepare: async () => ({ verified: true })
  });
  const completion = assert.rejects(handle.completion, (error) => error?.code === "AUTH_RECOVERY_CANCELLED");
  await handle.cancel();
  await handle.cancel();
  await completion;
  assert.equal(handle.status(), "cancelled");
  await assert.rejects(() => localRequest(handle.url));
});

test("browser companion manifest and worker retain the narrow cookie-transfer boundary", async () => {
  const root = new URL("../../browser-companion/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  const background = await readFile(new URL("background.js", root), "utf8");
  const content = await readFile(new URL("recovery-page.js", root), "utf8");

  assert.equal(manifest.version, "0.2.0");
  assert.deepEqual(manifest.permissions, ["cookies"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://connect.garmin.com/*",
    "http://127.0.0.1/*"
  ]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["http://127.0.0.1/recover/*"]);
  assert.equal(manifest.action.default_title, "Approve GConnect browser recovery");
  assert.match(background, /chrome\.cookies\.getAll\(\{ url: GARMIN_HOME \}\)/);
  assert.match(background, /protocolVersion: 2/);
  assert.match(background, /hostOnly: cookie\.hostOnly/);
  assert.match(background, /GARMIN_APPLICATION_STABLE_MS = 2_000/);
  assert.match(background, /elapsed >= GARMIN_APPLICATION_STABLE_MS/);
  assert.match(background, /STATUS_REQUEST_TIMEOUT_MS = 5_000/);
  assert.match(background, /SESSION_REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(background, /chrome\.action\.onClicked\.addListener/);
  assert.match(background, /fetch\(`\$\{recoveryUrl\}\/session`/);
  assert.equal(background.includes("activeRecoveries"), false);
  assert.match(content, /RECOVERY_POLL_MS = 500/);
  assert.match(content, /gconnect-browser-recovery-approved/);
  assert.equal(background.includes("console."), false);
  assert.equal(background.includes("document."), false);
  assert.equal(content.includes("cookies"), false);
  assert.equal(content.includes("console."), false);
});

test("browser companion resumes stable-URL polling after worker restarts and quick-acks transfer", async () => {
  const background = await readFile(new URL("../../browser-companion/background.js", import.meta.url), "utf8");
  let listener;
  let actionListener;
  let now = 1_000;
  let cookieCaptureTime;
  let postTime;
  let postedTransfer;
  let listenerStage = "waiting";
  let queryCalls = 0;
  let createCalls = 0;
  let tabReads = 0;
  const actionMessages = [];
  const recoveryUrl = `http://127.0.0.1:4567/recover/${"n".repeat(43)}`;
  const garminTab = {
    id: 7,
    status: "complete",
    url: "https://connect.garmin.com/app/home?ready=1"
  };
  const chrome = {
    action: { onClicked: { addListener(value) { actionListener = value; } } },
    runtime: { onMessage: { addListener(value) { listener = value; } } },
    tabs: {
      async sendMessage(tabId, message) { actionMessages.push({ tabId, message }); },
      async query() { queryCalls += 1; return []; },
      async create() { createCalls += 1; return garminTab; },
      async get() {
        tabReads += 1;
        return garminTab;
      }
    },
    cookies: {
      async getAll() {
        cookieCaptureTime = now;
        return [{
          name: "SESSION",
          value: "opaque",
          domain: ".garmin.com",
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax"
        }];
      }
    }
  };
  const fetch = async (url, init) => {
    if (url.endsWith("/status")) {
      return {
        ok: true,
        status: 200,
        async json() { return { status: listenerStage, expiresAt: 61_000 }; }
      };
    }
    postTime = now;
    postedTransfer = JSON.parse(init.body);
    listenerStage = "verifying";
    return { ok: true, status: 202, body: { async cancel() {} } };
  };
  const startWorker = () => {
    runInNewContext(background, {
      AbortController,
      chrome,
      clearTimeout,
      Date: { now: () => now },
      Error,
      fetch,
      JSON,
      Number,
      Promise,
      URL,
      setTimeout
    });
    assert.equal(typeof listener, "function");
  };

  startWorker();
  actionListener({ id: 99, url: "https://evil.example/recover/fake" });
  actionListener({ id: 12, url: recoveryUrl });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(actionMessages)), [{
    tabId: 12,
    message: { type: "gconnect-browser-recovery-approved" }
  }]);

  const first = await sendBackgroundPoll(listener, { type: "gconnect-browser-recovery", recoveryUrl });
  assert.equal(first.state, "waiting");
  assert.equal(first.tabId, 7);
  assert.equal(first.applicationUrl, garminTab.url);

  now = 2_999;
  startWorker();
  const notStable = await sendBackgroundPoll(listener, {
    type: "gconnect-browser-recovery",
    recoveryUrl,
    tabId: 7,
    applicationUrl: first.applicationUrl,
    applicationReadySince: 1_000
  });
  assert.equal(notStable.state, "waiting");
  assert.equal(cookieCaptureTime, undefined);

  now = 3_000;
  startWorker();
  const submitted = await sendBackgroundPoll(listener, {
    type: "gconnect-browser-recovery",
    recoveryUrl,
    tabId: 7,
    applicationUrl: first.applicationUrl,
    applicationReadySince: 1_000
  });
  assert.equal(submitted.state, "waiting");
  assert.equal(cookieCaptureTime, 3_000);
  assert.equal(postTime, cookieCaptureTime);
  assert.equal(listenerStage, "verifying");
  assert.equal(postedTransfer.protocolVersion, 2);
  assert.equal(postedTransfer.cookies[0].hostOnly, false);

  startWorker();
  assert.equal((await sendBackgroundPoll(listener, {
    type: "gconnect-browser-recovery",
    recoveryUrl,
    tabId: 7
  })).state, "waiting");
  listenerStage = "complete";
  startWorker();
  assert.equal((await sendBackgroundPoll(listener, {
    type: "gconnect-browser-recovery",
    recoveryUrl,
    tabId: 7
  })).state, "complete");

  assert.equal(queryCalls, 1);
  assert.equal(createCalls, 1);
  assert.equal(tabReads, 2);
});

test("one browser-companion poll returns immediately with the listener's absolute deadline", async () => {
  const background = await readFile(new URL("../../browser-companion/background.js", import.meta.url), "utf8");
  let listener;
  let now = 1_000;
  let statusRequests = 0;
  let tabReads = 0;
  let cookieReads = 0;
  const expiresAt = now + 60_000;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener(value) { listener = value; } } },
    tabs: {
      async sendMessage() {},
      async get() {
        tabReads += 1;
        return { id: 9, status: "loading", url: "https://connect.garmin.com/signin" };
      }
    },
    cookies: {
      async getAll() {
        cookieReads += 1;
        return [];
      }
    }
  };
  runInNewContext(background, {
    AbortController,
    chrome,
    clearTimeout,
    Date: { now: () => now },
    Error,
    fetch: async (url) => {
      assert.match(url, /\/status$/);
      statusRequests += 1;
      return {
        ok: true,
        status: 200,
        async json() { return { status: "waiting", expiresAt }; }
      };
    },
    JSON,
    Number,
    Promise,
    URL,
    setTimeout
  });

  const recoveryUrl = `http://127.0.0.1:4567/recover/${"n".repeat(43)}`;
  const response = await sendBackgroundPoll(listener, {
    type: "gconnect-browser-recovery",
    recoveryUrl,
    tabId: 9
  });
  assert.equal(response.accepted, true);
  assert.equal(response.state, "waiting");
  assert.equal(response.expiresAt, expiresAt);
  assert.equal(statusRequests, 1);
  assert.equal(now, 1_000);
  assert.equal(tabReads, 1);
  assert.equal(cookieReads, 0);
});

test("browser companion rejects status deadlines outside the bounded recovery window", async () => {
  const background = await readFile(new URL("../../browser-companion/background.js", import.meta.url), "utf8");
  for (const expiresAt of ["not-a-number", 900_001]) {
    let listener;
    let openedTabs = 0;
    const recoveryUrl = `http://127.0.0.1:4567/recover/${"n".repeat(43)}`;
    const chrome = {
      action: { onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener(value) { listener = value; } } },
      tabs: {
        async sendMessage() {},
        async query() { openedTabs += 1; return []; }
      },
      cookies: { async getAll() { throw new Error("must not capture"); } }
    };
    runInNewContext(background, {
      AbortController,
      chrome,
      clearTimeout,
      Date: { now: () => 0 },
      Error,
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() { return { status: "waiting", expiresAt }; }
      }),
      JSON,
      Number,
      Promise,
      URL,
      setTimeout
    });
    const response = await sendBackgroundPoll(listener, {
      type: "gconnect-browser-recovery",
      recoveryUrl
    });
    assert.equal(response.accepted, true);
    assert.equal(response.state, "retry");
    assert.equal(openedTabs, 0);
  }
});

test("recovery page requires the extension action and safely reports rejection", async () => {
  const content = await readFile(new URL("../../browser-companion/recovery-page.js", import.meta.url), "utf8");
  const recoveryUrl = `http://127.0.0.1:4567/recover/${"n".repeat(43)}`;
  let approvalListener;
  let sendCalls = 0;
  const status = { textContent: "Waiting for your approval in the browser companion." };
  const document = recoveryDocument(status, 61_000);
  runInNewContext(content, {
    chrome: {
      runtime: {
        onMessage: { addListener(value) { approvalListener = value; } },
        async sendMessage() {
          sendCalls += 1;
          return { accepted: false, sensitive: "must not render" };
        }
      }
    },
    Date: { now: () => 1_000 },
    document,
    Number,
    Promise,
    setTimeout,
    URL,
    window: { location: { href: recoveryUrl } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendCalls, 0);
  approvalListener({ type: "not-approved" });
  assert.equal(sendCalls, 0);
  approvalListener({ type: "gconnect-browser-recovery-approved" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendCalls, 1);
  assert.equal(status.textContent, "Browser recovery failed. Return to the terminal and try again.");
  assert.equal(status.textContent.includes("sensitive"), false);
});

test("recovery page retries a lost worker message and carries only non-sensitive readiness state", async () => {
  const content = await readFile(new URL("../../browser-companion/recovery-page.js", import.meta.url), "utf8");
  const recoveryUrl = `http://127.0.0.1:4567/recover/${"n".repeat(43)}`;
  const expiresAt = 61_000;
  const applicationUrl = "https://connect.garmin.com/app/home?ready=1";
  let now = 1_000;
  let approvalListener;
  let sendCalls = 0;
  let nextTimerId = 1;
  const sentMessages = [];
  const timers = new Map();
  const status = { textContent: "Waiting for your approval in the browser companion." };

  runInNewContext(content, {
    chrome: {
      runtime: {
        onMessage: { addListener(value) { approvalListener = value; } },
        async sendMessage(message) {
          sendCalls += 1;
          sentMessages.push(message);
          if (sendCalls === 1) throw new Error("worker restarted");
          if (
            Number.isSafeInteger(message.applicationReadySince)
            && now - message.applicationReadySince >= 2_000
          ) {
            return { accepted: true, state: "complete", expiresAt };
          }
          return {
            accepted: true,
            state: "waiting",
            expiresAt,
            tabId: 7,
            applicationUrl
          };
        }
      }
    },
    Date: { now: () => now },
    document: recoveryDocument(status, expiresAt),
    Number,
    Promise,
    setTimeout(callback, milliseconds) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    URL,
    window: { location: { href: recoveryUrl } }
  });

  approvalListener({ type: "gconnect-browser-recovery-approved" });
  for (let index = 0; index < 10 && status.textContent !== "Browser session sent. Return to the terminal."; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const next = timers.entries().next().value;
    if (next === undefined) continue;
    const [id, timer] = next;
    timers.delete(id);
    now += timer.milliseconds;
    timer.callback();
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(status.textContent, "Browser session sent. Return to the terminal.");
  assert.ok(sendCalls >= 6);
  assert.equal(sentMessages[0].type, "gconnect-browser-recovery");
  assert.equal(sentMessages[0].recoveryUrl, recoveryUrl);
  assert.deepEqual(Object.keys(sentMessages[0]).sort(), ["recoveryUrl", "type"]);
  assert.equal(sentMessages.at(-1).tabId, 7);
  assert.equal(sentMessages.at(-1).applicationUrl, applicationUrl);
  assert.equal(Number.isSafeInteger(sentMessages.at(-1).applicationReadySince), true);
  assert.equal(JSON.stringify(sentMessages).includes("cookie"), false);
});

function validTransfer(nonce) {
  return {
    protocolVersion: 2,
    nonce,
    source: "browser-companion",
    cookies: [validCookie()]
  };
}

function validCookie() {
  return {
    name: "SESSION",
    value: "cookie-secret",
    domain: ".garmin.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expirationDate: 2_000_000_000
  };
}

function nonceFrom(url) {
  const nonce = new URL(url).pathname.split("/").at(-1);
  assert.ok(nonce);
  return nonce;
}

function postTransfer(url, transfer) {
  return localRequest(`${url}/session`, {
    method: "POST",
    body: JSON.stringify(transfer),
    headers: { "Content-Type": "text/plain;charset=UTF-8" }
  });
}

function localRequest(url, options = {}) {
  const target = new URL(url);
  const body = options.body;
  const headers = {
    ...options.headers,
    Host: options.host ?? target.host,
    ...(body === undefined || options.omitContentLength
      ? {}
      : { "Content-Length": Buffer.byteLength(body) })
  };
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: responseBody
      }));
    });
    request.once("error", reject);
    request.setTimeout(1_000, () => request.destroy(new Error("request timed out")));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function redactCookieValues(key, value) {
  return key === "value" ? "[redacted]" : value;
}

function sendBackgroundPoll(listener, message) {
  return new Promise((resolve) => {
    assert.equal(listener(message, { url: message.recoveryUrl }, resolve), true);
  });
}

function recoveryDocument(status, expiresAt) {
  return {
    readyState: "complete",
    querySelector(selector) {
      assert.equal(selector, 'meta[name="gconnect-recovery-expires-at"]');
      return { content: String(expiresAt) };
    },
    getElementById(id) {
      assert.equal(id, "gconnect-recovery-status");
      return status;
    },
    addEventListener() {
      throw new Error("DOMContentLoaded listener is unnecessary after load");
    }
  };
}

async function eventuallyRejects(operation) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await operation();
    } catch {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("operation did not reject after listener close");
}
