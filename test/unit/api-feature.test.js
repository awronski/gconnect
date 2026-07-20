import assert from "node:assert/strict";
import test from "node:test";

import { validateCommandInput } from "../../dist/cli/command-contract.js";
import { GLOBAL_OPTIONS } from "../../dist/cli/global-options.js";
import { apiFeature } from "../../dist/features/api/api-feature.js";

const command = apiFeature.commands[0];

test("raw API GET parses repeated URL query values without exposing transport controls", async () => {
  const requests = [];
  const input = validateCommandInput(
    command.contract,
    { query: "date=2026-07-17&tag=one&tag=two" },
    ["/gc-api/example-service/resource"],
    GLOBAL_OPTIONS
  );
  const output = await command.invoke({
    download: {
      async json(request) { requests.push(request); return request.decode({ ok: true }); },
      async optionalJson() { throw new Error("unused"); },
      async profileId() { return "profile"; }
    },
    processing: {},
    clock: { now: () => new Date("2026-07-17T12:00:00Z") }
  }, input);
  assert.deepEqual({ ...requests[0].query }, { date: "2026-07-17", tag: ["one", "two"] });
  assert.equal(output.meta.raw, true);
  assert.deepEqual(output.data, { ok: true });
});

test("raw API GET rejects origin/path confusion and sensitive query names", async () => {
  for (const path of [
    "https://example.com/gc-api/test",
    "/app/home",
    "/gc-api/../app/home",
    "/gc-api/%2e%2e/app/home",
    "/gc-api/%252e%252e/app/home",
    "/gc-api/%252fapp/home",
    "/gc-api/resource%20name",
    "/gc-api/test?cookie=x"
  ]) {
    const input = validateCommandInput(command.contract, {}, [path], GLOBAL_OPTIONS);
    await assert.rejects(command.invoke({ displayOnly: true }, input), (error) => error.code === "INVALID_API_PATH");
  }
  const input = validateCommandInput(command.contract, { query: "csrf-token=secret" }, ["/gc-api/test"], GLOBAL_OPTIONS);
  await assert.rejects(command.invoke({ displayOnly: true }, input), (error) => error.code === "INVALID_QUERY");
});

test("raw API GET permits legitimate token-like names and prototype-looking keys", async () => {
  const requests = [];
  const input = validateCommandInput(
    command.contract,
    { query: "continuationToken=next&originalStartDate=2026-07-01&constructor=value&__proto__=safe" },
    ["/gc-api/test"],
    GLOBAL_OPTIONS
  );
  await command.invoke({
    download: {
      async json(request) { requests.push(request); return request.decode({ ok: true }); },
      async optionalJson() { throw new Error("unused"); },
      async profileId() { return "profile"; }
    },
    processing: {},
    clock: { now: () => new Date("2026-07-17T12:00:00Z") }
  }, input);
  assert.deepEqual({ ...requests[0].query }, {
    continuationToken: "next",
    originalStartDate: "2026-07-01",
    constructor: "value",
    ["__proto__"]: "safe"
  });
});
