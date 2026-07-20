import assert from "node:assert/strict";
import test from "node:test";

import {
  activitiesFeature,
  activitiesGetCommand,
  activitiesListCommand,
  decodeActivityDetails,
  decodeActivityList,
  decodeActivityPolyline
} from "../../dist/features/activities/index.js";
import { validateCommandInput } from "../../dist/cli/command-contract.js";
import { GLOBAL_OPTIONS } from "../../dist/cli/global-options.js";
import { processingToolkit } from "../../dist/processing/processing-toolkit.js";

const FIXTURE_ACTIVITY_TIMESTAMP = Date.parse("2026-07-17T06:00:00.000Z");

const NOW = new Date("2026-07-17T12:00:00.000Z");

test("activities feature exposes isolated list and get commands", () => {
  assert.equal(activitiesFeature.id, "activities");
  assert.deepEqual(
    activitiesFeature.commands.map((command) => command.contract.id),
    ["activities.list", "activities.get"]
  );
  assert.deepEqual(activitiesListCommand.contract.rules?.paired, [["from", "to"]]);
  assert.equal(activitiesGetCommand.contract.options["include-details"].defaultValue, true);
});

test("activities list applies defaults, normalizes IDs, and reports conservative pagination", async () => {
  const requests = [];
  const context = fakeContext(requests, () => [
    {
      activityId: 123456789,
      deviceId: 987654321,
      activityUUID: "activity-uuid",
      activityName: "Morning walk",
      activityType: { typeKey: "walking", parentTypeId: 1 },
      startTimeLocal: "2026-07-17 08:00:00",
      startTimeGMT: "2026-07-17 06:00:00",
      distance: 5000,
      duration: 3600,
      movingDuration: 3500,
      calories: 300,
      averageHR: 110,
      maxHR: 145,
      hasPolyline: true,
      unknownGarminField: { retainedInRawMode: true }
    }
  ]);
  const input = validateCommandInput(activitiesListCommand.contract, {}, [], GLOBAL_OPTIONS);

  const output = await activitiesListCommand.invoke(context, input);

  assert.deepEqual(requests, [
    {
      path: "/gc-api/activitylist-service/activities/search/activities",
      query: { start: 0, limit: 20 }
    }
  ]);
  assert.equal(output.meta.generatedAt, NOW.toISOString());
  assert.equal(output.meta.raw, false);
  assert.deepEqual(output.data.page, { start: 0, limit: 20, hasMore: false });
  assert.deepEqual(output.data.items[0], {
    id: "123456789",
    uuid: "activity-uuid",
    name: "Morning walk",
    type: "walking",
    startTimeLocal: "2026-07-17 08:00:00",
    startTimeGmt: "2026-07-17 06:00:00",
    distanceMeters: 5000,
    durationSeconds: 3600,
    movingDurationSeconds: 3500,
    calories: 300,
    averageHeartRate: 110,
    maxHeartRate: 145,
    deviceId: "987654321",
    hasPolyline: true
  });
});

test("activities list maps paired date and type filters and preserves decoded wire data in raw mode", async () => {
  const requests = [];
  const context = fakeContext(requests, () => [
    {
      activityId: 123,
      deviceId: 456,
      activityName: "Long ID activity",
      extra: [1, 2, 3]
    },
    { activityId: "90071992547409930", deviceId: "90071992547409931" }
  ]);
  const input = validateCommandInput(
    activitiesListCommand.contract,
    {
      from: "2026-07-01",
      to: "2026-07-17",
      type: "walking",
      limit: "100",
      start: "20",
      raw: true
    },
    [],
    GLOBAL_OPTIONS
  );

  const output = await activitiesListCommand.invoke(context, input);

  assert.deepEqual(requests[0], {
    path: "/gc-api/activitylist-service/activities/search/activities",
    query: {
      start: 20,
      limit: 100,
      startDate: "2026-07-01",
      endDate: "2026-07-17",
      activityType: "walking"
    }
  });
  assert.equal(output.meta.raw, true);
  assert.deepEqual(output.data, [
    {
      activityId: 123,
      deviceId: 456,
      activityName: "Long ID activity",
      extra: [1, 2, 3]
    },
    { activityId: "90071992547409930", deviceId: "90071992547409931" }
  ]);
});

test("activities list rejects incomplete, reversed, and out-of-bound options", async () => {
  assert.throws(
    () => validateCommandInput(activitiesListCommand.contract, { from: "2026-07-01" }, [], GLOBAL_OPTIONS),
    (error) => error.code === "INCOMPLETE_OPTION_GROUP"
  );
  assert.throws(
    () => validateCommandInput(activitiesListCommand.contract, { limit: "101" }, [], GLOBAL_OPTIONS),
    (error) => error.code === "INVALID_OPTION"
  );
  assert.throws(
    () => validateCommandInput(activitiesListCommand.contract, { start: "-1" }, [], GLOBAL_OPTIONS),
    (error) => error.code === "INVALID_OPTION"
  );

  const reversed = validateCommandInput(
    activitiesListCommand.contract,
    { from: "2026-07-18", to: "2026-07-17" },
    [],
    GLOBAL_OPTIONS
  );
  await assert.rejects(
    activitiesListCommand.invoke(fakeContext([], () => []), reversed),
    (error) => error.code === "INVALID_DATE_RANGE"
  );
});

test("activities get downloads details by default and decodes descriptor-indexed metrics", async () => {
  const requests = [];
  const detailsFixture = {
    activityId: 123456789,
    measurementCount: 1,
    metricsCount: 2,
    totalMetricsCount: 2,
    metricDescriptors: [
      { metricsIndex: 1, key: "directHeartRate", unit: { id: 1, key: "bpm", factor: 1 } },
      { metricsIndex: 0, key: "directTimestamp", unit: { id: 2, key: "ms", factor: 1 } }
    ],
    activityDetailMetrics: [{ metrics: [FIXTURE_ACTIVITY_TIMESTAMP, 112] }],
    geoPolylineDTO: { polyline: [] },
    detailsAvailable: true,
    retainedOnlyInRawMode: "value"
  };
  const context = fakeContext(requests, (request) => {
    assert.match(request.path, /\/details$/);
    return detailsFixture;
  });
  const input = validateCommandInput(activitiesGetCommand.contract, {}, ["123456789"], GLOBAL_OPTIONS);

  const output = await activitiesGetCommand.invoke(context, input);

  assert.deepEqual(requests, [
    {
      path: "/gc-api/activity-service/activity/123456789/details",
      query: { maxChartSize: 10000, maxPolylineSize: 0, maxHeatMapSize: 2000 }
    }
  ]);
  assert.equal(output.data.activityId, "123456789");
  assert.equal(output.data.details.activityId, "123456789");
  assert.deepEqual(output.data.details.metrics, [
    { directTimestamp: FIXTURE_ACTIVITY_TIMESTAMP, directHeartRate: 112 }
  ]);
  assert.equal(output.data.polyline, null);
});

test("activities get can request only a raw full-resolution polyline", async () => {
  const requests = [];
  const polylineFixture = {
    polyline: [[1, 2, 120]],
    minLat: 1,
    maxLat: 1,
    minLon: 2,
    maxLon: 2,
    futureField: "preserved"
  };
  const context = fakeContext(requests, () => polylineFixture);
  const input = validateCommandInput(
    activitiesGetCommand.contract,
    { "include-details": "false", "include-polyline": true, raw: true },
    ["90071992547409930"],
    GLOBAL_OPTIONS
  );

  const output = await activitiesGetCommand.invoke(context, input);

  assert.deepEqual(requests, [
    {
      path: "/gc-api/activity-service/activity/90071992547409930/polyline/full-resolution/",
      query: undefined
    }
  ]);
  assert.equal(output.meta.raw, true);
  assert.deepEqual(output.data, {
    activityId: "90071992547409930",
    details: null,
    polyline: polylineFixture
  });
  assert.equal(output.meta.warnings.length, 1);
});

test("activities get raw details preserve unknown nested Garmin fields", async () => {
  const fixture = {
    activityId: 123,
    measurementCount: 1,
    metricsCount: 1,
    totalMetricsCount: 1,
    metricDescriptors: [{
      metricsIndex: 0,
      key: "heartRate",
      futureDescriptor: true,
      unit: { id: 1, key: "bpm", factor: 1, futureUnit: "kept" }
    }],
    activityDetailMetrics: [{ metrics: [100], futureRow: "kept" }],
    detailsAvailable: true,
    futureTopLevel: { kept: true }
  };
  const input = validateCommandInput(
    activitiesGetCommand.contract,
    { raw: true },
    ["123"],
    GLOBAL_OPTIONS
  );
  const output = await activitiesGetCommand.invoke(fakeContext([], () => fixture), input);
  assert.deepEqual(output.data.details, fixture);
});

test("activities get rejects invalid IDs and an empty include selection", async () => {
  const invalidId = validateCommandInput(activitiesGetCommand.contract, {}, ["abc"], GLOBAL_OPTIONS);
  await assert.rejects(
    activitiesGetCommand.invoke(fakeContext([], () => null), invalidId),
    (error) => error.code === "INVALID_ACTIVITY_ID"
  );

  const empty = validateCommandInput(
    activitiesGetCommand.contract,
    { "include-details": "false", "include-polyline": "false" },
    ["123"],
    GLOBAL_OPTIONS
  );
  await assert.rejects(
    activitiesGetCommand.invoke(fakeContext([], () => null), empty),
    (error) => error.code === "INVALID_OPTION_COMBINATION"
  );
});

test("activity wire decoders classify malformed payloads as protocol changes", () => {
  assert.throws(
    () => decodeActivityList({ activityId: 1 }),
    (error) => error.code === "PROTOCOL_CHANGED"
  );
  assert.throws(
    () =>
      decodeActivityDetails({
        activityId: 1,
        measurementCount: 0,
        metricsCount: 0,
        totalMetricsCount: 0,
        metricDescriptors: [],
        activityDetailMetrics: [],
        detailsAvailable: "yes"
      }),
    (error) => error.code === "PROTOCOL_CHANGED"
  );
  assert.throws(
    () => decodeActivityPolyline({ polyline: [[1, 2]], minLat: 1, maxLat: 1, minLon: 2, maxLon: 2 }),
    (error) => error.code === "PROTOCOL_CHANGED"
  );
  assert.throws(
    () => decodeActivityList([{ activityId: Number.MAX_SAFE_INTEGER + 1 }]),
    (error) => error.code === "PROTOCOL_CHANGED"
  );
});

function fakeContext(requests, responseFor) {
  return {
    download: {
      async json(request) {
        requests.push({ path: request.path, query: request.query });
        return request.decode(responseFor(request));
      },
      async optionalJson(request) {
        requests.push({ path: request.path, query: request.query });
        const response = responseFor(request);
        return response === null ? null : request.decode(response);
      }
    },
    processing: processingToolkit,
    clock: { now: () => new Date(NOW) }
  };
}
