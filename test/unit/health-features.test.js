import assert from "node:assert/strict";
import test from "node:test";

import { validateCommandInput } from "../../dist/cli/command-contract.js";
import { CommandRegistry } from "../../dist/cli/command-registry.js";
import { GLOBAL_OPTIONS } from "../../dist/cli/global-options.js";
import { healthFeature } from "../../dist/features/health/feature.js";
import { processingToolkit } from "../../dist/processing/processing-toolkit.js";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const FIXTURE_TIMESTAMP = Date.parse("2026-07-17T08:00:00.000Z");
const commands = new Map(healthFeature.commands.map((command) => [command.contract.id, command]));

const pulseOxWire = {
  averageSpO2: 97,
  spO2SingleValuesDescriptorList: [
    { index: 1, key: "spo2Reading" },
    { index: 0, key: "timestamp" }
  ],
  spO2SingleValues: [[FIXTURE_TIMESTAMP, 98]],
  spO2HourlyAveragesDescriptorList: [
    { index: 0, key: "timestamp" },
    { index: 1, key: "spo2Level" }
  ],
  spO2HourlyAverages: [[FIXTURE_TIMESTAMP, 97]],
  monitoringEnvironmentValuesDescriptorList: [
    { index: 0, key: "timestamp" },
    { index: 1, key: "monitoringEnvironmentLevel" }
  ],
  monitoringEnvironmentValues: [[FIXTURE_TIMESTAMP, 2]]
};

const respirationWire = {
  calendarDate: "2026-07-17",
  respirationValueDescriptorsDTOList: [
    { index: 1, key: "respiration" },
    { index: 0, key: "timestamp" }
  ],
  respirationValuesArray: [[FIXTURE_TIMESTAMP, 14.5]],
  respirationAveragesValueDescriptorDTOList: [],
  respirationAveragesValuesArray: []
};

const heartRateWire = {
  calendarDate: "2026-07-17",
  restingHeartRate: 52,
  heartRateValueDescriptors: [
    { index: 0, key: "timestamp" },
    { index: 1, key: "heartrate" }
  ],
  heartRateValues: [[FIXTURE_TIMESTAMP, 61]]
};

const stressWire = {
  calendarDate: "2026-07-17",
  avgStressLevel: 24,
  stressValueDescriptorsDTOList: [
    { index: 0, key: "timestamp" },
    { index: 1, key: "stressLevel" }
  ],
  stressValuesArray: [[FIXTURE_TIMESTAMP, 21]],
  bodyBatteryValueDescriptorsDTOList: [
    { bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: "timestamp" },
    { bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: "bodyBatteryStatus" },
    { bodyBatteryValueDescriptorIndex: 2, bodyBatteryValueDescriptorKey: "bodyBatteryLevel" },
    { bodyBatteryValueDescriptorIndex: 3, bodyBatteryValueDescriptorKey: "bodyBatteryVersion" }
  ],
  bodyBatteryValuesArray: [[FIXTURE_TIMESTAMP, "MEASURED", 75, 3]]
};

const bodyBatteryEventWire = {
  event: {
    eventType: "SLEEP",
    eventStartTimeGmt: "2026-07-17T00:00:00.000Z",
    timezoneOffset: 7_200_000,
    durationInMilliseconds: 28_800_000,
    bodyBatteryImpact: 32,
    feedbackType: "POSITIVE",
    shortFeedback: "Restored"
  },
  activityName: null,
  activityType: null,
  activityId: null,
  averageStress: 10,
  stressValueDescriptorsDTOList: [
    { index: 0, key: "timestamp" },
    { index: 1, key: "stressLevel" }
  ],
  stressValuesArray: [[FIXTURE_TIMESTAMP, 10]],
  bodyBatteryValueDescriptorsDTOList: [
    { bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: "timestamp" },
    { bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: "bodyBatteryStatus" },
    { bodyBatteryValueDescriptorIndex: 2, bodyBatteryValueDescriptorKey: "bodyBatteryLevel" },
    { bodyBatteryValueDescriptorIndex: 3, bodyBatteryValueDescriptorKey: "bodyBatteryVersion" }
  ],
  bodyBatteryValuesArray: [[FIXTURE_TIMESTAMP, "MEASURED", 80, 3]]
};

test("health feature registers six isolated command contracts", () => {
  const registry = new CommandRegistry([healthFeature]);
  assert.deepEqual(
    registry.contracts().map((contract) => contract.id),
    [
      "health.sleep",
      "health.pulse-ox",
      "health.respiration",
      "health.heart-rate",
      "health.stress",
      "health.body-battery"
    ]
  );

  for (const contract of registry.contracts()) {
    assert.deepEqual(Object.keys(contract.options), ["date", "from", "to", "raw", "recover-auth", "no-auth-recovery"]);
    assert.deepEqual(contract.rules?.paired, [["from", "to"]]);
    assert.deepEqual(contract.rules?.exactlyOneOf, [["date", "from"]]);
    assert.deepEqual(contract.rules?.incompatible, [["recover-auth", "no-auth-recovery"]]);
    assert.equal(contract.output.shape, "collection");
  }
});

test("every health command accepts one date selector plus shared raw and recovery options", () => {
  for (const command of commands.values()) {
    assert.doesNotThrow(() => validated(command, { date: "2026-07-17" }));
    assert.doesNotThrow(() => validated(command, {
      from: "2026-07-16",
      to: "2026-07-17",
      raw: true
    }));
    assert.equal(validated(command, { date: "2026-07-17", raw: true }).options.raw, true);

    for (const rawOptions of [
      {},
      { from: "2026-07-16" },
      { to: "2026-07-17" },
      { date: "2026-07-17", from: "2026-07-16", to: "2026-07-17" }
    ]) {
      assert.throws(
        () => validated(command, rawOptions),
        (error) => error?.code === "INCOMPLETE_OPTION_GROUP" || error?.code === "INVALID_OPTION_COMBINATION",
        `${command.contract.id}: ${JSON.stringify(rawOptions)}`
      );
    }
  }
});

test("sleep uses the exact endpoint and non-sleep buffer query", async () => {
  const sleepWire = { dailySleepDTO: { calendarDate: "2026-07-17", sleepTimeSeconds: 28_800 } };
  const { output, requests } = await run("health.sleep", { date: "2026-07-17" }, () => sleepWire);

  assert.deepEqual(requests, [{
    path: "/gc-api/sleep-service/sleep/dailySleepData",
    diPath: "/wellness-service/wellness/dailySleepData/{profileId}",
    query: { date: "2026-07-17", nonSleepBufferMinutes: 60 }
  }]);
  assert.deepEqual(output.data.items, [{ date: "2026-07-17", data: sleepWire }]);
  assert.equal(output.meta.generatedAt, NOW.toISOString());
  assert.equal(output.meta.raw, false);
});

test("sleep preserves Garmin's observed sparse 200 no-data shape", async () => {
  const sparseSleepWire = {
    dailySleepDTO: {
      calendarDate: "2000-01-01",
      sleepStartTimestampGMT: null,
      sleepEndTimestampGMT: null,
      sleepStartTimestampLocal: null,
      sleepEndTimestampLocal: null,
      sleepTimeSeconds: null,
      deepSleepSeconds: null,
      lightSleepSeconds: null,
      remSleepSeconds: null,
      awakeSleepSeconds: null,
      unmeasurableSleepSeconds: null,
      averageSpO2Value: null,
      lowestSpO2Value: null,
      highestSpO2Value: null,
      averageRespirationValue: null,
      lowestRespirationValue: null,
      highestRespirationValue: null,
      averageHeartRate: null,
      averageStressLevel: null
    },
    sleepMovement: [],
    sleepLevels: [],
    sleepRestlessMoments: [],
    wellnessSpO2SleepSummaryDTO: null,
    wellnessEpochSPO2DataDTOList: [],
    wellnessEpochRespirationDataDTOList: [],
    wellnessEpochRespirationAveragesList: [],
    sleepHeartRate: [],
    sleepStress: [],
    sleepBodyBattery: [],
    hrvData: [],
    breathingDisruptionData: []
  };

  const { output } = await run("health.sleep", { date: "2000-01-01" }, () => sparseSleepWire);

  assert.deepEqual(output.data.items, [{ date: "2000-01-01", data: sparseSleepWire }]);
});

test("Pulse Ox uses the date-addressed endpoint and decodes all known series", async () => {
  const { output, requests } = await run("health.pulse-ox", { date: "2026-07-17" }, () => pulseOxWire);
  const data = output.data.items[0].data;

  assert.deepEqual(requests, [{
    path: "/gc-api/wellness-service/wellness/daily/spo2acclimation/2026-07-17",
    diPath: "/wellness-service/wellness/daily/spo2/2026-07-17",
    query: undefined
  }]);
  assert.deepEqual(data.spO2SingleValues, [{ timestamp: FIXTURE_TIMESTAMP, spo2Reading: 98 }]);
  assert.deepEqual(data.spO2HourlyAverages, [{ timestamp: FIXTURE_TIMESTAMP, spo2Level: 97 }]);
  assert.deepEqual(data.monitoringEnvironmentValues, [{
    timestamp: FIXTURE_TIMESTAMP,
    monitoringEnvironmentLevel: 2
  }]);
});

test("Pulse Ox accepts Garmin's observed null single-value series", async () => {
  const wire = {
    ...pulseOxWire,
    spO2SingleValues: null
  };
  const { output } = await run("health.pulse-ox", { date: "2026-07-17" }, () => wire);
  assert.equal(output.data.items[0].data.spO2SingleValues, null);
});

test("respiration uses its path date and decodes rows by descriptor index", async () => {
  const { output, requests } = await run("health.respiration", { date: "2026-07-17" }, () => respirationWire);

  assert.deepEqual(requests, [{
    path: "/gc-api/wellness-service/wellness/daily/respiration/2026-07-17",
    query: undefined
  }]);
  assert.deepEqual(output.data.items[0].data.respirationValuesArray, [{
    respiration: 14.5,
    timestamp: FIXTURE_TIMESTAMP
  }]);
});

test("heart rate uses its query date and decodes its descriptor series", async () => {
  const { output, requests } = await run("health.heart-rate", { date: "2026-07-17" }, () => heartRateWire);

  assert.deepEqual(requests, [{
    path: "/gc-api/wellness-service/wellness/dailyHeartRate",
    diPath: "/wellness-service/wellness/dailyHeartRate/{profileId}",
    query: { date: "2026-07-17" }
  }]);
  assert.deepEqual(output.data.items[0].data.heartRateValues, [{
    timestamp: FIXTURE_TIMESTAMP,
    heartrate: 61
  }]);
});

test("stress decodes stress and Body Battery series with their different descriptor shapes", async () => {
  const { output, requests } = await run("health.stress", { date: "2026-07-17" }, () => stressWire);
  const data = output.data.items[0].data;

  assert.deepEqual(requests, [{
    path: "/gc-api/wellness-service/wellness/dailyStress/2026-07-17",
    query: undefined
  }]);
  assert.deepEqual(data.stressValuesArray, [{ timestamp: FIXTURE_TIMESTAMP, stressLevel: 21 }]);
  assert.deepEqual(data.bodyBatteryValuesArray, [{
    timestamp: FIXTURE_TIMESTAMP,
    bodyBatteryStatus: "MEASURED",
    bodyBatteryLevel: 75,
    bodyBatteryVersion: 3
  }]);
});

test("Body Battery combines daily stress and events without requesting messagingToday", async () => {
  const { output, requests } = await run("health.body-battery", { date: "2026-07-17" }, (request) =>
    request.path.includes("/events/") ? [bodyBatteryEventWire] : stressWire
  );
  const data = output.data.items[0].data;

  assert.deepEqual(requests.map((request) => request.path).sort(), [
    "/gc-api/wellness-service/wellness/bodyBattery/events/2026-07-17",
    "/gc-api/wellness-service/wellness/dailyStress/2026-07-17"
  ]);
  assert.equal(requests.some((request) => request.path.includes("messagingToday")), false);
  assert.deepEqual(data.dailyStress.bodyBatteryValuesArray, [{
    timestamp: FIXTURE_TIMESTAMP,
    bodyBatteryStatus: "MEASURED",
    bodyBatteryLevel: 75,
    bodyBatteryVersion: 3
  }]);
  assert.deepEqual(data.events[0].stressValuesArray, [{
    timestamp: FIXTURE_TIMESTAMP,
    stressLevel: 10
  }]);
});

test("Body Battery accepts activity events without stress samples", async () => {
  const activityEvent = {
    ...bodyBatteryEventWire,
    activityId: 123_456_789,
    averageStress: null,
    stressValueDescriptorsDTOList: null,
    stressValuesArray: null
  };
  const { output } = await run("health.body-battery", { date: "2026-07-17" }, (request) =>
    request.path.includes("/events/") ? [activityEvent] : stressWire
  );

  assert.equal(output.data.items[0].data.events[0].averageStress, null);
  assert.equal(output.data.items[0].data.events[0].stressValuesArray, null);
});

test("date ranges produce stable ordered items and exact applied options", async () => {
  const { output, requests } = await run(
    "health.sleep",
    { from: "2026-07-15", to: "2026-07-17" },
    (request) => ({ dailySleepDTO: { calendarDate: request.query.date } })
  );

  assert.deepEqual(requests.map((request) => request.query.date), [
    "2026-07-15",
    "2026-07-16",
    "2026-07-17"
  ]);
  assert.deepEqual(output.data.items.map((item) => item.date), [
    "2026-07-15",
    "2026-07-16",
    "2026-07-17"
  ]);
  assert.deepEqual(output.meta.appliedOptions, { from: "2026-07-15", to: "2026-07-17" });
});

test("health ranges reject reverse and excessive ranges before downloading", async () => {
  for (const rawOptions of [
    { from: "2026-07-17", to: "2026-07-16" },
    { from: "2025-01-01", to: "2026-01-03" }
  ]) {
    const command = commandFor("health.sleep");
    const { context, requests } = fakeContext(() => ({}));
    await assert.rejects(
      () => command.invoke(context, validated(command, rawOptions)),
      (error) => error?.code === "INVALID_DATE_RANGE" || error?.code === "DATE_RANGE_TOO_LARGE"
    );
    assert.equal(requests.length, 0);
  }
});

test("legitimate optional no-data days remain ordered as explicit null items", async () => {
  const { output } = await run("health.sleep", { date: "2026-07-17" }, async () => null);
  assert.deepEqual(output.data.items, [{ date: "2026-07-17", data: null }]);
});

test("normalized health output stringifies known public IDs while raw mode preserves wire values", async () => {
  const wire = { ...heartRateWire, userProfilePK: 123, deviceId: 456 };
  const normalized = await run("health.heart-rate", { date: "2026-07-17" }, async () => wire);
  assert.equal(normalized.output.data.items[0].data.userProfilePK, "123");
  assert.equal(normalized.output.data.items[0].data.deviceId, "456");
  const raw = await run("health.heart-rate", { date: "2026-07-17", raw: true }, async () => wire);
  assert.equal(raw.output.data.items[0].data.userProfilePK, 123);
  assert.equal(raw.output.data.items[0].data.deviceId, 456);
});

test("raw mode preserves every endpoint's complete encoded payload", async () => {
  const cases = [
    ["health.sleep", {
      dailySleepDTO: { calendarDate: "2026-07-17", unknownFutureField: 1 },
      anotherField: [1, 2, 3]
    }],
    ["health.pulse-ox", pulseOxWire],
    ["health.respiration", respirationWire],
    ["health.heart-rate", heartRateWire],
    ["health.stress", stressWire]
  ];

  for (const [id, wire] of cases) {
    const { output } = await run(id, { date: "2026-07-17", raw: true }, () => wire);
    assert.equal(output.meta.raw, true, id);
    assert.deepEqual(output.data.items[0].data, wire, id);
  }

  const { output } = await run("health.body-battery", { date: "2026-07-17", raw: true }, (request) =>
    request.path.includes("/events/") ? [bodyBatteryEventWire] : stressWire
  );
  assert.deepEqual(output.data.items[0].data, {
    dailyStress: stressWire,
    events: [bodyBatteryEventWire]
  });
});

test("every health endpoint rejects an unexpected top-level response", async () => {
  for (const id of [
    "health.sleep",
    "health.pulse-ox",
    "health.respiration",
    "health.heart-rate",
    "health.stress"
  ]) {
    await assert.rejects(
      () => run(id, { date: "2026-07-17" }, () => []),
      (error) => error?.code === "PROTOCOL_CHANGED",
      id
    );
  }

  await assert.rejects(
    () => run("health.body-battery", { date: "2026-07-17" }, (request) =>
      request.path.includes("/events/") ? {} : stressWire
    ),
    (error) => error?.code === "PROTOCOL_CHANGED"
  );
});

test("descriptor rows fail loudly when Garmin's compact encoding changes", async () => {
  await assert.rejects(
    () => run("health.heart-rate", { date: "2026-07-17" }, () => ({
      ...heartRateWire,
      heartRateValues: [[FIXTURE_TIMESTAMP]]
    })),
    (error) => error?.code === "PROTOCOL_CHANGED"
  );
  await assert.rejects(
    () => run("health.heart-rate", { date: "2026-07-17" }, () => ({
      ...heartRateWire,
      heartRateValueDescriptors: [],
      heartRateValues: [[FIXTURE_TIMESTAMP, 60]]
    })),
    (error) => error?.code === "PROTOCOL_CHANGED"
  );
  await assert.rejects(
    () => run("health.heart-rate", { date: "2026-07-17", raw: true }, () => ({
      ...heartRateWire,
      heartRateValueDescriptors: [],
      heartRateValues: [[FIXTURE_TIMESTAMP, 60]]
    })),
    (error) => error?.code === "PROTOCOL_CHANGED"
  );
});

test("Body Battery rejects error-shaped event items", async () => {
  await assert.rejects(
    () => run("health.body-battery", { date: "2026-07-17", raw: true }, (request) =>
      request.path.includes("/events/") ? [{ error: "unexpected" }] : stressWire),
    (error) => error?.code === "PROTOCOL_CHANGED"
  );
});

test("sleep rejects an error-shaped daily DTO", async () => {
  await assert.rejects(
    () => run("health.sleep", { date: "2026-07-17", raw: true }, () => ({
      dailySleepDTO: { error: "unexpected" }
    })),
    (error) => error?.code === "PROTOCOL_CHANGED"
  );
});

function commandFor(id) {
  const command = commands.get(id);
  assert.ok(command, `missing command ${id}`);
  return command;
}

function validated(command, rawOptions) {
  return validateCommandInput(command.contract, rawOptions, [], GLOBAL_OPTIONS);
}

async function run(id, rawOptions, responder) {
  const command = commandFor(id);
  const { context, requests } = fakeContext(responder);
  const output = await command.invoke(context, validated(command, rawOptions));
  return { output, requests };
}

function fakeContext(responder) {
  const requests = [];
  const download = {
    async json(request) {
      requests.push({ path: request.path, ...(request.diPath === undefined ? {} : { diPath: request.diPath }), query: request.query });
      return request.decode(await responder(request));
    },
    async optionalJson(request) {
      requests.push({ path: request.path, ...(request.diPath === undefined ? {} : { diPath: request.diPath }), query: request.query });
      const response = await responder(request);
      return response === null ? null : request.decode(response);
    },
    async profileId() { return "profile-id"; }
  };
  return {
    requests,
    context: {
      download,
      processing: processingToolkit,
      clock: { now: () => NOW }
    }
  };
}
