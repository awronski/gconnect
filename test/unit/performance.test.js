import assert from "node:assert/strict";
import test from "node:test";

import { validateCommandInput } from "../../dist/cli/command-contract.js";
import { GLOBAL_OPTIONS } from "../../dist/cli/global-options.js";
import { performanceFeature } from "../../dist/features/performance/feature.js";
import { processingToolkit } from "../../dist/processing/processing-toolkit.js";

const commands = new Map(performanceFeature.commands.map((command) => [command.contract.id, command]));
const now = new Date("2026-07-17T12:00:00.000Z");

test("performance feature exposes training status and HRV contracts", () => {
  assert.deepEqual([...commands.keys()], ["performance.training-status", "performance.hrv"]);
  for (const command of commands.values()) {
    assert.deepEqual(command.contract.rules, {
      paired: [["from", "to"]],
      exactlyOneOf: [["date", "from"]],
      incompatible: [["recover-auth", "no-auth-recovery"]]
    });
  }
});

test("training status downloads all observed factors for each date", async () => {
  const requests = [];
  const command = commands.get("performance.training-status");
  const input = validateCommandInput(command.contract, { from: "2026-07-16", to: "2026-07-17" }, [], GLOBAL_OPTIONS);
  const output = await command.invoke(fakeContext(requests, validTrainingPayload), input);
  assert.equal(requests.length, 8);
  assert.deepEqual(output.data.days.map((day) => day.date), ["2026-07-16", "2026-07-17"]);
  assert.equal(output.meta.sourceEndpoints.length, 8);
});

test("training status accepts losslessly parsed 64-bit user and device IDs", async () => {
  const unsafeId = "90071992547409930";
  const command = commands.get("performance.training-status");
  const input = validateCommandInput(command.contract, { date: "2026-07-17" }, [], GLOBAL_OPTIONS);
  const output = await command.invoke(fakeContext([], (path) => {
    if (path.includes("trainingstatus")) {
      return {
        userId: unsafeId,
        latestTrainingStatusData: {
          device: {
            calendarDate: "2026-07-17",
            sinceDate: "2026-07-01",
            trainingStatus: 1,
            timestamp: 1,
            deviceId: unsafeId,
            fitnessTrend: 1,
            fitnessTrendSport: "RUNNING",
            trainingStatusFeedbackPhrase: "PRODUCTIVE",
            trainingPaused: false,
            primaryTrainingDevice: true,
            acuteTrainingLoadDTO: {}
          }
        },
        recordedDevices: [{ deviceId: unsafeId, deviceName: "Watch", imageURL: "watch.png", category: 1 }],
        showSelector: true,
        lastPrimarySyncDate: "2026-07-17"
      };
    }
    if (path.includes("trainingloadbalance")) {
      return {
        userId: unsafeId,
        metricsTrainingLoadBalanceDTOMap: {
          device: { calendarDate: "2026-07-17", deviceId: unsafeId, primaryTrainingDevice: true }
        },
        recordedDevices: [{ deviceId: unsafeId, deviceName: "Watch", imageURL: "watch.png", category: 1 }]
      };
    }
    if (path.includes("maxmet")) return { ...validTrainingPayload(path), userId: unsafeId };
    return validTrainingPayload(path);
  }), input);

  const day = output.data.days[0];
  assert.equal(day.trainingStatus.userId, unsafeId);
  assert.equal(day.trainingStatus.latestTrainingStatusData.device.deviceId, unsafeId);
  assert.equal(day.trainingStatus.recordedDevices[0].deviceId, unsafeId);
  assert.equal(day.loadBalance.userId, unsafeId);
  assert.equal(day.loadBalance.metricsTrainingLoadBalanceDTOMap.device.deviceId, unsafeId);
  assert.equal(day.loadBalance.recordedDevices[0].deviceId, unsafeId);
  assert.equal(day.maxMet.userId, unsafeId);
});

test("training status preserves sparse 200 support payloads and observed optional 204", async () => {
  const command = commands.get("performance.training-status");
  const input = validateCommandInput(command.contract, { date: "2000-01-01", raw: true }, [], GLOBAL_OPTIONS);
  const sparseTrainingStatus = {
    userId: null,
    latestTrainingStatusData: null,
    recordedDevices: null,
    showSelector: false,
    lastPrimarySyncDate: null
  };
  const sparseLoadBalance = {
    userId: 1,
    metricsTrainingLoadBalanceDTOMap: null,
    recordedDevices: null
  };
  // The live capture retained these nested keys but intentionally did not
  // retain account-derived values. Nulls are synthetic placeholders here.
  const sparseMaxMet = {
    userId: 1,
    cycling: null,
    generic: {
      calendarDate: "2000-01-01",
      fitnessAge: null,
      fitnessAgeDescription: null,
      maxMetCategory: null,
      vo2MaxPreciseValue: null,
      vo2MaxValue: null
    },
    heatAltitudeAcclimation: {
      acclimationPercentage: null,
      altitudeAcclimation: null,
      altitudeAcclimationDate: null,
      altitudeAcclimationLocalTimestamp: null,
      altitudeTrend: null,
      calendarDate: "2000-01-01",
      currentAltitude: null,
      heatAcclimationDate: null,
      heatAcclimationPercentage: null,
      heatTrend: null,
      previousAcclimationPercentage: null,
      previousAltitude: null,
      previousAltitudeAcclimation: null,
      previousAltitudeAcclimationDate: null,
      previousHeatAcclimationDate: null,
      previousHeatAcclimationPercentage: null
    }
  };

  const output = await command.invoke(fakeContext([], (path) => {
    if (path.includes("trainingstatus")) return sparseTrainingStatus;
    if (path.includes("trainingloadbalance")) return sparseLoadBalance;
    if (path.includes("maxmet")) return sparseMaxMet;
    if (path.includes("heataltitudeacclimation")) return null;
    assert.fail(`unexpected endpoint ${path}`);
  }), input);

  assert.deepEqual(output.data.days, [{
    date: "2000-01-01",
    trainingStatus: sparseTrainingStatus,
    loadBalance: sparseLoadBalance,
    maxMet: sparseMaxMet,
    heatAltitudeAcclimation: null
  }]);
});

test("training status rejects a partial null sentinel", async () => {
  const command = commands.get("performance.training-status");
  const input = validateCommandInput(command.contract, { date: "2000-01-01" }, [], GLOBAL_OPTIONS);

  await assert.rejects(
    command.invoke(fakeContext([], (path) => {
      if (path.includes("trainingstatus")) {
        return { latestTrainingStatusData: null, recordedDevices: [] };
      }
      return validTrainingPayload(path);
    }), input),
    (error) => error instanceof TypeError
  );
});

test("training status rejects a bare paired-null object without sparse discriminants", async () => {
  const command = commands.get("performance.training-status");
  const input = validateCommandInput(command.contract, { date: "2000-01-01" }, [], GLOBAL_OPTIONS);

  await assert.rejects(
    () => command.invoke(fakeContext([], (path) =>
      path.includes("trainingstatus")
        ? { latestTrainingStatusData: null, recordedDevices: null }
        : validTrainingPayload(path)
    ), input),
    (error) => error instanceof TypeError
  );
});

test("training status rejects a populated map item without stable fields", async () => {
  const command = commands.get("performance.training-status");
  const input = validateCommandInput(command.contract, { date: "2026-07-17" }, [], GLOBAL_OPTIONS);

  await assert.rejects(
    () => command.invoke(fakeContext([], (path) =>
      path.includes("trainingstatus")
        ? { ...validTrainingPayload(path), latestTrainingStatusData: { x: {} } }
        : validTrainingPayload(path)
    ), input),
    (error) => error instanceof TypeError
  );
});

test("training status support decoders reject error-shaped objects", async () => {
  const command = commands.get("performance.training-status");
  const input = validateCommandInput(command.contract, { date: "2026-07-17" }, [], GLOBAL_OPTIONS);

  for (const endpoint of [
    "trainingstatus",
    "trainingloadbalance",
    "maxmet",
    "heataltitudeacclimation"
  ]) {
    await assert.rejects(
      () => command.invoke(fakeContext([], (path) =>
        path.includes(endpoint) ? { error: "redacted" } : validTrainingPayload(path)
      ), input),
      (error) => error instanceof TypeError,
      endpoint
    );
  }
});

test("training status maps and device arrays reject malformed items", async () => {
  const command = commands.get("performance.training-status");
  const input = validateCommandInput(command.contract, { date: "2026-07-17" }, [], GLOBAL_OPTIONS);
  const cases = [
    ["trainingstatus", {
      ...validTrainingPayload("trainingstatus"),
      latestTrainingStatusData: { device: 1 }
    }],
    ["trainingstatus", {
      ...validTrainingPayload("trainingstatus"),
      recordedDevices: [{}]
    }],
    ["trainingloadbalance", {
      userId: 1,
      metricsTrainingLoadBalanceDTOMap: { device: {} },
      recordedDevices: []
    }],
    ["trainingloadbalance", {
      userId: 1,
      metricsTrainingLoadBalanceDTOMap: {},
      recordedDevices: [{}]
    }]
  ];

  for (const [endpoint, malformed] of cases) {
    await assert.rejects(
      () => command.invoke(fakeContext([], (path) =>
        path.includes(endpoint) ? malformed : validTrainingPayload(path)
      ), input),
      (error) => error instanceof TypeError,
      endpoint
    );
  }
});

test("daily HRV and range HRV use their distinct exact endpoints", async () => {
  const command = commands.get("performance.hrv");
  const dailyRequests = [];
  const dailyInput = validateCommandInput(command.contract, { date: "2026-07-17" }, [], GLOBAL_OPTIONS);
  const daily = await command.invoke(fakeContext(dailyRequests, () => ({
    hrvSummary: validHrvSummary(),
    hrvReadings: [validHrvReading()]
  })), dailyInput);
  assert.equal(dailyRequests[0].path, "/gc-api/hrv-service/hrv/2026-07-17");
  assert.equal(daily.data.date, "2026-07-17");

  const rangeRequests = [];
  const rangeInput = validateCommandInput(command.contract, { from: "2026-07-01", to: "2026-07-17" }, [], GLOBAL_OPTIONS);
  const range = await command.invoke(fakeContext(rangeRequests, () => ({
    hrvSummaries: [validHrvSummary()]
  })), rangeInput);
  assert.equal(rangeRequests[0].path, "/gc-api/hrv-service/hrv/daily/2026-07-01/2026-07-17");
  assert.equal(range.data.from, "2026-07-01");
});

test("daily and range HRV preserve observed optional 204 no-data responses", async () => {
  const command = commands.get("performance.hrv");
  const dailyInput = validateCommandInput(command.contract, { date: "2000-01-01" }, [], GLOBAL_OPTIONS);
  const daily = await command.invoke(fakeContext([], () => null), dailyInput);
  assert.deepEqual(daily.data, { date: "2000-01-01", payload: null });

  const rangeInput = validateCommandInput(
    command.contract,
    { from: "2000-01-01", to: "2000-01-02" },
    [],
    GLOBAL_OPTIONS
  );
  const range = await command.invoke(fakeContext([], () => null), rangeInput);
  assert.deepEqual(range.data, { from: "2000-01-01", to: "2000-01-02", payload: null });
});

test("performance decoders reject malformed top-level contracts", async () => {
  const command = commands.get("performance.hrv");
  const input = validateCommandInput(command.contract, { date: "2026-07-17" }, [], GLOBAL_OPTIONS);
  await assert.rejects(
    command.invoke(fakeContext([], () => ({ hrvSummary: {} })), input),
    (error) => error instanceof TypeError
  );
});

test("HRV decoders reject malformed collection items", async () => {
  const command = commands.get("performance.hrv");
  const dailyInput = validateCommandInput(command.contract, { date: "2026-07-17" }, [], GLOBAL_OPTIONS);
  await assert.rejects(
    command.invoke(fakeContext([], () => ({ hrvSummary: validHrvSummary(), hrvReadings: [{}] })), dailyInput),
    (error) => error instanceof TypeError
  );

  const rangeInput = validateCommandInput(
    command.contract,
    { from: "2026-07-16", to: "2026-07-17" },
    [],
    GLOBAL_OPTIONS
  );
  await assert.rejects(
    command.invoke(fakeContext([], () => ({ hrvSummaries: [{}] })), rangeInput),
    (error) => error instanceof TypeError
  );
});

function validTrainingPayload(path) {
  if (path.includes("trainingstatus")) {
    return {
      userId: 1,
      latestTrainingStatusData: {},
      recordedDevices: [],
      showSelector: true,
      lastPrimarySyncDate: "2026-07-17"
    };
  }
  if (path.includes("trainingloadbalance")) {
    return { userId: 1, metricsTrainingLoadBalanceDTOMap: {}, recordedDevices: [] };
  }
  if (path.includes("maxmet")) {
    return {
      userId: 1,
      cycling: null,
      generic: {
        calendarDate: "2026-07-17",
        maxMetCategory: 1,
        vo2MaxPreciseValue: 50,
        vo2MaxValue: 50
      },
      heatAltitudeAcclimation: {
        calendarDate: "2026-07-17",
        heatAcclimationPercentage: 0,
        altitudeAcclimation: 0
      }
    };
  }
  if (path.includes("heataltitudeacclimation")) {
    return { calendarDate: "2026-07-17", heatAcclimationPercentage: 0, altitudeAcclimation: 0 };
  }
  assert.fail(`unexpected endpoint ${path}`);
}

function validHrvSummary() {
  return {
    baseline: {},
    calendarDate: "2026-07-17",
    createTimeStamp: "2026-07-17T12:00:00.000Z",
    feedbackPhrase: "BALANCED",
    status: "BALANCED",
    lastNight5MinHigh: 50,
    lastNightAvg: 45,
    weeklyAvg: 44
  };
}

function validHrvReading() {
  return {
    hrvValue: 45,
    readingTimeGMT: "2026-07-17T01:00:00.000Z",
    readingTimeLocal: "2026-07-17T03:00:00.000"
  };
}

function fakeContext(requests, response) {
  const download = {
    async json(request) {
      requests.push({ path: request.path, query: request.query });
      return request.decode(response(request.path));
    },
    async optionalJson(request) {
      requests.push({ path: request.path, query: request.query });
      const payload = response(request.path);
      return payload === null ? null : request.decode(payload);
    },
    async profileId() { return "profile-id"; }
  };
  return { download, processing: processingToolkit, clock: { now: () => now } };
}
