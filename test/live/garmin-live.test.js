import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const runFile = promisify(execFile);
const cli = join(process.cwd(), "dist", "bin", "gconnect.js");
const liveDate = process.env.GCONNECT_LIVE_DATE;
const live = liveDate === undefined ? test.skip : test;

live("authorized Garmin account satisfies every documented live data contract", async (t) => {
  const commands = [
    { args: ["health", "sleep", "--date", liveDate], dataset: "sleep" },
    { args: ["health", "pulse-ox", "--date", liveDate], dataset: "pulse-ox" },
    { args: ["health", "respiration", "--date", liveDate], dataset: "respiration" },
    { args: ["health", "heart-rate", "--date", liveDate], dataset: "heart-rate" },
    { args: ["health", "stress", "--date", liveDate], dataset: "stress" },
    { args: ["health", "body-battery", "--date", liveDate], dataset: "body-battery" },
    { args: ["performance", "training-status", "--date", liveDate], dataset: "performance.training-status" },
    { args: ["performance", "hrv", "--date", liveDate], dataset: "performance.hrv" },
    { args: ["performance", "hrv", "--from", liveDate, "--to", liveDate], dataset: "performance.hrv" }
  ];
  for (const item of commands) {
    await t.test(item.args.slice(0, 2).join(" "), async () => {
      const output = await runLive(item.args);
      assert.equal(output.meta.dataset, item.dataset);
      assert.equal(output.meta.schemaVersion, 1);
    });
  }
});

live("activity pagination and filters are honored by Garmin", async () => {
  const count = await runLive(["activities", "count"]);
  assert.equal(count.meta.dataset, "activities.count");
  assert.ok(Number.isSafeInteger(count.data.total));
  assert.ok(count.data.total >= 0);

  const first = await runLive(["activities", "list", "--offset", "0", "--limit", "20"]);
  const second = await runLive(["activities", "list", "--offset", "20", "--limit", "20"]);
  assert.equal(first.meta.dataset, "activities");
  assert.equal(second.meta.dataset, "activities");
  const firstIds = new Set(first.data.items.map((item) => item.id));
  assert.equal(second.data.items.some((item) => firstIds.has(item.id)), false);

  const filterArgs = ["activities", "list", "--from", liveDate, "--to", liveDate, "--limit", "100"];
  if (process.env.GCONNECT_LIVE_ACTIVITY_TYPE !== undefined) {
    filterArgs.push("--type", process.env.GCONNECT_LIVE_ACTIVITY_TYPE);
  }
  const filtered = await runLive(filterArgs);
  for (const activity of filtered.data.items) {
    if (activity.startTimeLocal !== null) assert.equal(activity.startTimeLocal.slice(0, 10), liveDate);
    if (process.env.GCONNECT_LIVE_ACTIVITY_TYPE !== undefined && activity.type !== null) {
      assert.equal(activity.type, process.env.GCONNECT_LIVE_ACTIVITY_TYPE);
    }
  }
});

live("one known activity returns strict details and optional polyline", {
  skip: process.env.GCONNECT_LIVE_ACTIVITY_ID === undefined
}, async () => {
  const output = await runLive([
    "activities",
    "get",
    process.env.GCONNECT_LIVE_ACTIVITY_ID,
    "--include-polyline"
  ]);
  assert.equal(output.data.activityId, process.env.GCONNECT_LIVE_ACTIVITY_ID);
  assert.notEqual(output.data.details, null);
});

live("a configured no-data date is represented explicitly rather than as a schema failure", {
  skip: process.env.GCONNECT_LIVE_MISSING_DATE === undefined
}, async () => {
  const output = await runLive(["health", "sleep", "--date", process.env.GCONNECT_LIVE_MISSING_DATE]);
  assert.equal(output.data.items[0].date, process.env.GCONNECT_LIVE_MISSING_DATE);
  assert.ok(output.data.items[0].data === null || typeof output.data.items[0].data === "object");
});

async function runLive(args) {
  const completed = await runFile(process.execPath, [cli, ...args, "--no-auth-recovery"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024
  });
  assert.equal(completed.stderr, "");
  return JSON.parse(completed.stdout);
}
