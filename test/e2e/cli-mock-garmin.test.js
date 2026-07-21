import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CookieJar } from "tough-cookie";

import { FileAuthState } from "../../dist/auth/auth-state.js";
import { FileDiTokenStore } from "../../dist/auth/di/index.js";
import { FileWebSessionStore } from "../../dist/auth/web/web-session-store.js";

const runFile = promisify(execFile);
const cli = join(process.cwd(), "dist", "bin", "gconnect.js");
const date = "2026-07-17";

test("every data command runs through the real CLI against a deterministic Garmin contract server", async (t) => {
  const fixture = await createFixture(t);
  const cases = [
    { args: ["activities", "list", "--from", date, "--to", date, "--type", "walking"], dataset: "activities" },
    { args: ["activities", "count"], dataset: "activities.count" },
    { args: ["activities", "get", "123", "--include-polyline"], dataset: "activity" },
    { args: ["health", "sleep", "--date", date], dataset: "sleep" },
    { args: ["health", "pulse-ox", "--date", date], dataset: "pulse-ox" },
    { args: ["health", "respiration", "--date", date], dataset: "respiration" },
    { args: ["health", "heart-rate", "--date", date], dataset: "heart-rate" },
    { args: ["health", "stress", "--date", date], dataset: "stress" },
    { args: ["health", "body-battery", "--date", date], dataset: "body-battery" },
    { args: ["performance", "training-status", "--date", date], dataset: "performance.training-status" },
    { args: ["performance", "hrv", "--date", date], dataset: "performance.hrv" },
    { args: ["performance", "hrv", "--from", date, "--to", date], dataset: "performance.hrv" },
    { args: ["api", "get", "/gc-api/userprofile-service/userprofile/user-settings/"], dataset: "api.raw" },
    { args: ["auth", "status", "--verify"], dataset: "auth.status" },
    { args: ["system", "describe", "--command", "health.sleep"], dataset: "system.command-catalogue" }
  ];

  for (const item of cases) {
    await t.test(item.args.join(" "), async () => {
      const completed = await runCli(fixture, item.args);
      assert.equal(completed.stderr, "");
      const output = JSON.parse(completed.stdout);
      assert.equal(output.meta.schemaVersion, 1);
      assert.equal(output.meta.dataset, item.dataset);
      assert.ok("data" in output);
    });
  }
});

test("browserless DI login, backend-specific routes, status, and disconnect work across processes", async (t) => {
  const fixture = await createFixture(t);
  const login = await runCli(fixture, ["auth", "login", "--username", "user@example.com"], {
    GARMIN_PASSWORD: "test-password"
  });
  const loginOutput = JSON.parse(login.stdout);
  assert.equal(loginOutput.data.backend, "private-di");
  assert.equal(loginOutput.data.verified, true);
  assert.doesNotMatch(login.stdout + login.stderr, /test-password|access-token|refresh-token|service-ticket/);

  for (const args of [
    ["health", "sleep", "--date", date],
    ["health", "pulse-ox", "--date", date],
    ["health", "heart-rate", "--date", date],
    ["performance", "training-status", "--date", date]
  ]) {
    const completed = await runCli(fixture, args);
    assert.equal(JSON.parse(completed.stdout).meta.schemaVersion, 1);
  }
  assert.ok(fixture.requests.some((url) => url.startsWith("/wellness-service/wellness/dailySleepData/profile_12345678")));
  assert.ok(fixture.requests.some((url) => url.startsWith("/wellness-service/wellness/daily/spo2/")));
  assert.ok(fixture.requests.some((url) => url.startsWith("/wellness-service/wellness/dailyHeartRate/profile_12345678")));
  assert.ok(fixture.requests.some((url) => url.startsWith("/metrics-service/metrics/trainingstatus/aggregated/")));

  const status = JSON.parse((await runCli(fixture, ["auth", "status", "--verify"])).stdout);
  assert.equal(status.data.backend, "private-di");
  const disconnected = JSON.parse((await runCli(fixture, ["auth", "disconnect"])).stdout);
  assert.equal(disconnected.data.connected, false);
  const disconnectedState = await new FileAuthState(
    join(fixture.home, "active-backend.json"),
    join(fixture.home, "auth-state.lock")
  ).activeState();
  assert.equal(disconnectedState.backend, null);
  assert.match(disconnectedState.revision, /^[0-9a-f-]{36}$/i);
  const finalStatus = JSON.parse((await runCli(fixture, ["auth", "status"])).stdout);
  assert.equal(finalStatus.data.connected, false);
});

test("a committed login reports credential cleanup failure without hiding the new backend", async (t) => {
  const fixture = await createFixture(t);
  const webSessionPath = join(fixture.home, "web-session.json");
  await rm(webSessionPath);
  await mkdir(webSessionPath);

  await assert.rejects(
    runCli(fixture, ["auth", "login", "--username", "user@example.com"], {
      GARMIN_PASSWORD: "test-password"
    }),
    (error) => {
      assert.equal(error.stdout, "");
      const payload = JSON.parse(error.stderr);
      assert.equal(payload.error.code, "AUTH_TRANSITION_FINALIZATION_FAILED");
      assert.equal(payload.error.retryable, true);
      assert.deepEqual(payload.error.details, {
        transitionCommitted: true,
        activeBackend: "private-di",
        credentialCleanupCompleted: false,
        credentialsMayRemain: true,
        nextCommand: "gconnect auth disconnect",
        retryable: true
      });
      assert.doesNotMatch(error.stderr, /test-password|access-token|refresh-token|service-ticket/);
      return true;
    }
  );

  const state = new FileAuthState(
    join(fixture.home, "active-backend.json"),
    join(fixture.home, "auth-state.lock")
  );
  assert.equal(await state.activeBackend(), "private-di");
  assert.notEqual(await new FileDiTokenStore(join(fixture.home, "di-session.json")).load(), null);
  assert.equal(JSON.parse((await runCli(fixture, ["auth", "status"])).stdout).data.backend, "private-di");

  await rm(webSessionPath, { recursive: true });
  assert.equal(JSON.parse((await runCli(fixture, ["auth", "disconnect"])).stdout).data.connected, false);
});

test("active backend marker wins over credential residue and a disconnected tombstone fails closed", async (t) => {
  const fixture = await createFixture(t);
  const state = new FileAuthState(
    join(fixture.home, "active-backend.json"),
    join(fixture.home, "auth-state.lock")
  );
  await new FileDiTokenStore(join(fixture.home, "di-session.json")).save(diTokenSet());

  const webRequestStart = fixture.requests.length;
  await runCli(fixture, ["health", "sleep", "--date", date]);
  assert.ok(fixture.requests.slice(webRequestStart).some((url) =>
    url.startsWith("/gc-api/sleep-service/sleep/dailySleepData")));

  await state.setActiveBackend("private-di");
  const diRequestStart = fixture.requests.length;
  await runCli(fixture, ["health", "sleep", "--date", date]);
  assert.ok(fixture.requests.slice(diRequestStart).some((url) =>
    url.startsWith("/wellness-service/wellness/dailySleepData/profile_12345678")));

  await state.clearActiveBackend();
  assert.equal((await state.activeState()).backend, null);
  const status = JSON.parse((await runCli(fixture, ["auth", "status"])).stdout);
  assert.equal(status.data.connected, false);
  await assert.rejects(
    runCli(fixture, ["health", "sleep", "--date", date, "--no-auth-recovery"]),
    (error) => JSON.parse(error.stderr).error.code === "AUTH_REQUIRED"
  );
});

test("concurrent CLI processes perform one rotating DI refresh", async (t) => {
  const fixture = await createFixture(t);
  await runCli(fixture, ["auth", "login", "--username", "user@example.com"], {
    GARMIN_PASSWORD: "test-password"
  });
  const store = new FileDiTokenStore(join(fixture.home, "di-session.json"));
  const tokens = await store.load();
  assert.notEqual(tokens, null);
  await store.save({ ...tokens, accessExpiresAtEpochMs: Date.now() - 1_000 });
  const refreshesBefore = fixture.requests.filter((url) => url === "/di-oauth2-service/oauth/token").length;

  await Promise.all([
    runCli(fixture, ["health", "sleep", "--date", date]),
    runCli(fixture, ["health", "stress", "--date", date])
  ]);

  const refreshesAfter = fixture.requests.filter((url) => url === "/di-oauth2-service/oauth/token").length;
  assert.equal(refreshesAfter - refreshesBefore, 1);
  assert.ok((await store.load()).accessExpiresAtEpochMs > Date.now());
});

test("range ordering, raw mode, atomic file output, and JSON-only failures hold at process boundary", async (t) => {
  const fixture = await createFixture(t);
  const range = await runCli(fixture, ["health", "sleep", "--from", "2026-07-16", "--to", date, "--raw"]);
  const rangeOutput = JSON.parse(range.stdout);
  assert.deepEqual(rangeOutput.data.items.map((item) => item.date), ["2026-07-16", date]);
  assert.equal(rangeOutput.meta.raw, true);

  const outputPath = join(fixture.home, "outputs", "sleep.json");
  const written = await runCli(fixture, ["health", "sleep", "--date", date, "--output", "sleep.json"]);
  assert.equal(written.stdout, "");
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).meta.dataset, "sleep");

  for (const unsafePath of [outputPath, "../sleep.json", "nested/sleep.json"]) {
    await assert.rejects(
      runCli(fixture, ["health", "sleep", "--date", date, "--output", unsafePath]),
      (error) => JSON.parse(error.stderr).error.code === "INVALID_OUTPUT_PATH"
    );
  }

  await assert.rejects(
    runCli(fixture, ["health", "sleep", "--date", "2026-02-30"]),
    (error) => {
      assert.equal(error.stdout, "");
      assert.equal(JSON.parse(error.stderr).error.code, "INVALID_DATE");
      return true;
    }
  );
});

test("command help bypasses required feature arguments and raw is rejected where unsupported", async (t) => {
  const fixture = await createFixture(t);
  for (const args of [
    ["health", "sleep", "--help"],
    ["activities", "get", "--help"]
  ]) {
    const output = JSON.parse((await runCli(fixture, args)).stdout);
    assert.equal(output.meta.dataset, "system.command-description");
  }
  await assert.rejects(
    runCli(fixture, ["auth", "status", "--raw"]),
    (error) => JSON.parse(error.stderr).error.code === "UNKNOWN_OPTION"
  );

  const rootHelp = JSON.parse((await runCli(fixture, ["--help"])).stdout);
  assert.equal(rootHelp.meta.dataset, "system.command-catalogue");
  assert.ok(rootHelp.data.commands.length > 0);
  assert.equal(JSON.parse((await runCli(fixture, ["--version"])).stdout).meta.dataset, "system.version");
  await assert.rejects(
    runCli(fixture, ["--version=banana"]),
    (error) => JSON.parse(error.stderr).error.code === "INVALID_OPTION"
  );
  await assert.rejects(
    runCli(fixture, ["--help", "--version"]),
    (error) => JSON.parse(error.stderr).error.code === "INVALID_OPTION_COMBINATION"
  );
});

test("authentication recovery flags are rejected where they have no effect", async (t) => {
  const fixture = await createFixture(t);
  for (const args of [
    ["auth", "status", "--recover-auth"],
    ["auth", "recover", "--no-auth-recovery"],
    ["auth", "disconnect", "--recover-auth=false"],
    ["system", "describe", "--no-auth-recovery=false"]
  ]) {
    await assert.rejects(
      runCli(fixture, args),
      (error) => JSON.parse(error.stderr).error.code === "UNKNOWN_OPTION"
    );
  }
});

test("auth recover prints a copyable link, verifies companion cookies, stores them, and exits with JSON", async (t) => {
  const fixture = await createFixture(t);
  const child = spawn(process.execPath, [cli, "auth", "recover"], {
    cwd: fixture.cwd,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GCONNECT_TEST_ORIGIN: fixture.origin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const link = await waitForRecoveryLink(() => stderr);
  const nonce = link.split("/").at(-1);
  const response = await fetch(`${link}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: 2,
      nonce,
      source: "browser-companion",
      cookies: [{
        name: "RECOVERED",
        value: "fresh-session",
        domain: ".garmin.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax"
      }]
    })
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "verifying" });
  await waitForRecoveryTerminalStatus(link, "complete");
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout).meta.dataset, "auth.recovery");
  assert.match(stderr, /Open this one-time link/);
  assert.doesNotMatch(stdout + stderr, /fresh-session|RECOVERED/);
  const jar = await new FileWebSessionStore(join(fixture.home, "web-session.json")).load();
  assert.match(await jar.getCookieString("https://connect.garmin.com/app/home"), /RECOVERED=fresh-session/);
});

test("a concurrent disconnect tombstone prevents recovery from reconnecting missing state", async (t) => {
  const fixture = await createFixture(t);
  const markerPath = join(fixture.home, "active-backend.json");
  await rm(markerPath);
  const child = spawn(process.execPath, [cli, "auth", "recover"], {
    cwd: fixture.cwd,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GCONNECT_TEST_ORIGIN: fixture.origin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const link = await waitForRecoveryLink(() => stderr);

  await runCli(fixture, ["auth", "disconnect"]);
  const nonce = link.split("/").at(-1);
  const response = await fetch(`${link}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: 2,
      nonce,
      source: "browser-companion",
      cookies: [{
        name: "STALE",
        value: "must-not-commit",
        domain: ".garmin.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax"
      }]
    })
  });
  assert.equal(response.status, 202);
  await waitForRecoveryTerminalStatus(link, "complete");
  const [exitCode] = await exited;

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /"code": "AUTH_STATE_CHANGED"/);
  assert.doesNotMatch(stderr, /must-not-commit|STALE/);
  assert.equal(await new FileWebSessionStore(join(fixture.home, "web-session.json")).load(), null);
  const disconnected = await new FileAuthState(
    markerPath,
    join(fixture.home, "auth-state.lock")
  ).activeState();
  assert.equal(disconnected.backend, null);
});

test("--recover-auth resumes the failed data command exactly once while --no-auth-recovery fails immediately", async (t) => {
  const fixture = await createFixture(t);
  await runCli(fixture, ["auth", "disconnect"]);
  await assert.rejects(
    runCli(fixture, ["health", "sleep", "--date", date, "--no-auth-recovery"]),
    (error) => {
      assert.equal(JSON.parse(error.stderr).error.code, "AUTH_REQUIRED");
      assert.doesNotMatch(error.stderr, /http:\/\/127\.0\.0\.1/);
      return true;
    }
  );

  const child = spawn(process.execPath, [cli, "health", "sleep", "--date", date, "--recover-auth"], {
    cwd: fixture.cwd,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GCONNECT_TEST_ORIGIN: fixture.origin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const link = await waitForRecoveryLink(() => stderr);
  const nonce = link.split("/").at(-1);
  const response = await fetch(`${link}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: 2,
      nonce,
      source: "browser-companion",
      cookies: [{
        name: "SESSION",
        value: "resumed",
        domain: ".garmin.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax"
      }]
    })
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "verifying" });
  await waitForRecoveryTerminalStatus(link, "complete");
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout).meta.dataset, "sleep");
  assert.match(stderr, /Garmin browser session verified; committing authentication state/);
  assert.doesNotMatch(stdout + stderr, /resumed/);
});

async function createFixture(t) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/app/home") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<meta name="csrf-token" content="test-csrf"><script>
        window.viewerIsAuthenticated = true;
        window.VIEWER_USERPREFERENCES = {"displayName":"profile_12345678"};
      </script>`);
      return;
    }
    const payload = responseFor(url.pathname, url.searchParams);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const cwd = await mkdtemp(join(tmpdir(), "gconnect-e2e-"));
  const home = join(cwd, ".gconnect-private");
  await mkdir(home, { mode: 0o700 });
  const jar = new CookieJar();
  await jar.setCookie("SESSION=fixture; Domain=.garmin.com; Path=/; Secure; HttpOnly", "https://connect.garmin.com");
  await new FileWebSessionStore(join(home, "web-session.json")).save(jar);
  await new FileAuthState(join(home, "active-backend.json"), join(home, "auth-state.lock"))
    .setActiveBackend("web-cookie");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  });
  return { origin, cwd, home, requests };
}

function runCli(fixture, args, extraEnvironment = {}) {
  return runFile(process.execPath, [cli, ...args], {
    cwd: fixture.cwd,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GCONNECT_TEST_ORIGIN: fixture.origin,
      ...extraEnvironment
    },
    encoding: "utf8"
  });
}

async function waitForRecoveryLink(readStderr) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = readStderr().match(/http:\/\/127\.0\.0\.1:\d+\/recover\/[A-Za-z0-9_-]{43}/);
    if (match !== null) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Recovery link was not printed: ${readStderr()}`);
}

async function waitForRecoveryTerminalStatus(link, expected) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${link}/status`);
    const status = (await response.json()).status;
    if (status === expected) return;
    assert.equal(status, "verifying");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Recovery did not reach ${expected}`);
}

function responseFor(pathname, query) {
  if (pathname === "/mobile/api/login") {
    return { responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "service-ticket" };
  }
  if (pathname === "/di-oauth2-service/oauth/token") {
    return {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      refresh_token_expires_in: 86400,
      token_type: "bearer"
    };
  }
  if (pathname === "/userprofile-service/socialProfile") {
    return { displayName: "profile_12345678", fullName: "Fixture" };
  }
  if (pathname.endsWith("/activities/search/activities")) {
    assert.equal(query.get("startDate"), date);
    assert.equal(query.get("endDate"), date);
    assert.equal(query.get("activityType"), "walking");
    return [{ activityId: 123, deviceId: 456, activityName: "Walk", activityType: { typeKey: "walking" } }];
  }
  if (pathname.endsWith("/activities/count")) return { totalCount: 2000 };
  if (pathname.endsWith("/activity/123/details")) {
    return {
      activityId: 123,
      measurementCount: 1,
      metricsCount: 1,
      totalMetricsCount: 1,
      detailsAvailable: true,
      metricDescriptors: [{ metricsIndex: 0, key: "heartRate", unit: { id: 1, key: "bpm", factor: 1 } }],
      activityDetailMetrics: [{ metrics: [100] }]
    };
  }
  if (pathname.endsWith("/activity/123/polyline/full-resolution/")) {
    return { polyline: [[1, 2, 100]], minLat: 1, maxLat: 1, minLon: 2, maxLon: 2 };
  }
  if (pathname.endsWith("/sleep/dailySleepData") || pathname.includes("/wellness/dailySleepData/")) return { dailySleepDTO: { calendarDate: query.get("date") } };
  if (pathname.includes("/daily/spo2acclimation/") || pathname.includes("/daily/spo2/")) {
    return {
      averageSpO2: 97,
      spO2SingleValuesDescriptorList: [{ index: 0, key: "timestamp" }, { index: 1, key: "spo2Reading" }],
      spO2SingleValues: [[1, 98]],
      spO2HourlyAveragesDescriptorList: [],
      spO2HourlyAverages: [],
      monitoringEnvironmentValuesDescriptorList: [],
      monitoringEnvironmentValues: []
    };
  }
  if (pathname.includes("/daily/respiration/")) {
    return { calendarDate: date, respirationValueDescriptorsDTOList: [{ index: 0, key: "timestamp" }, { index: 1, key: "respiration" }], respirationValuesArray: [[1, 14]] };
  }
  if (pathname.endsWith("/dailyHeartRate") || pathname.includes("/dailyHeartRate/")) {
    return { calendarDate: date, heartRateValueDescriptors: [{ index: 0, key: "timestamp" }, { index: 1, key: "heartrate" }], heartRateValues: [[1, 60]] };
  }
  if (pathname.includes("/dailyStress/")) return stressFixture();
  if (pathname.includes("/bodyBattery/events/")) return [];
  if (pathname.includes("/trainingstatus/daily/") || pathname.includes("/trainingstatus/aggregated/")) {
    return {
      userId: 1,
      latestTrainingStatusData: {},
      recordedDevices: [],
      showSelector: true,
      lastPrimarySyncDate: date
    };
  }
  if (pathname.includes("/trainingloadbalance/")) {
    return { userId: 1, metricsTrainingLoadBalanceDTOMap: {}, recordedDevices: [] };
  }
  if (pathname.includes("/maxmet/")) {
    return {
      userId: 1,
      cycling: null,
      generic: {
        calendarDate: date,
        maxMetCategory: 1,
        vo2MaxPreciseValue: 50,
        vo2MaxValue: 50
      },
      heatAltitudeAcclimation: {
        calendarDate: date,
        heatAcclimationPercentage: 0,
        altitudeAcclimation: 0
      }
    };
  }
  if (pathname.includes("/heataltitudeacclimation/")) {
    return { calendarDate: date, heatAcclimationPercentage: 0, altitudeAcclimation: 0 };
  }
  if (pathname.includes("/hrv/daily/")) return { hrvSummaries: [hrvSummaryFixture()], userProfilePk: 1 };
  if (pathname.includes("/hrv/")) {
    return {
      hrvSummary: hrvSummaryFixture(),
      hrvReadings: [{
        hrvValue: 45,
        readingTimeGMT: `${date}T01:00:00.000Z`,
        readingTimeLocal: `${date}T03:00:00.000`
      }]
    };
  }
  if (pathname.endsWith("/user-settings/") || pathname.endsWith("/user-settings")) return { userData: { measurementSystem: "metric" } };
  throw new Error(`Unhandled fixture endpoint: ${pathname}`);
}

function stressFixture() {
  return {
    calendarDate: date,
    stressValueDescriptorsDTOList: [{ index: 0, key: "timestamp" }, { index: 1, key: "stressLevel" }],
    stressValuesArray: [[1, 20]],
    bodyBatteryValueDescriptorsDTOList: [
      { bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: "timestamp" },
      { bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: "bodyBatteryLevel" }
    ],
    bodyBatteryValuesArray: [[1, 75]]
  };
}

function hrvSummaryFixture() {
  return {
    baseline: {},
    calendarDate: date,
    createTimeStamp: `${date}T12:00:00.000Z`,
    feedbackPhrase: "BALANCED",
    status: "BALANCED",
    lastNight5MinHigh: 50,
    lastNightAvg: 45,
    weeklyAvg: 44
  };
}

function diTokenSet(overrides = {}) {
  return {
    backend: "private-di",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    clientId: "GCM_IOS_DARK",
    accessExpiresAtEpochMs: Date.now() + 3_600_000,
    refreshExpiresAtEpochMs: Date.now() + 86_400_000,
    ...overrides
  };
}
