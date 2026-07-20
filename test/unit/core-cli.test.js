import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseArgv } from "../../dist/cli/parser.js";
import { ProcessAuthInput } from "../../dist/auth/auth-input.js";
import { defineCommand, validateCommandInput } from "../../dist/cli/command-contract.js";
import { CommandRegistry } from "../../dist/cli/command-registry.js";
import { createAuthFeature } from "../../dist/features/auth/auth-feature.js";
import { parseCalendarDate, calendarDateRange } from "../../dist/core/dates.js";
import { CliError } from "../../dist/core/errors.js";
import { parseGarminJson } from "../../dist/core/parse-json.js";
import { result } from "../../dist/core/result.js";
import { renderError } from "../../dist/output/output-service.js";
import { mapConcurrentOrdered } from "../../dist/processing/ordered-concurrency.js";
import { SecureJsonFile } from "../../dist/storage/secure-json-file.js";

test("argv parser accepts equals and separated values and rejects duplicates", () => {
  assert.deepEqual(parseArgv(["health", "sleep", "--date=2026-07-17", "--raw"]), {
    positionals: ["health", "sleep"],
    options: { date: "2026-07-17", raw: true }
  });
  assert.deepEqual(parseArgv(["activities", "list", "--limit", "20"]), {
    positionals: ["activities", "list"],
    options: { limit: "20" }
  });
  assert.throws(() => parseArgv(["--raw", "--raw"]), (error) => error.code === "DUPLICATE_OPTION");
  assert.throws(() => parseArgv(["--Bad"]), (error) => error.code === "INVALID_OPTION");
});

test("boolean option rules treat false as disabled", () => {
  const contract = {
    id: "example.flags",
    path: ["example", "flags"],
    summary: "Validate flags.",
    options: {
      enabled: { type: "boolean", description: "Enable behavior." },
      disabled: { type: "boolean", description: "Disable behavior." }
    },
    rules: { incompatible: [["enabled", "disabled"]] },
    examples: ["gconnect example flags"],
    output: { dataset: "example", shape: "document" }
  };
  assert.deepEqual(
    validateCommandInput(contract, { enabled: "false", disabled: true }, [], {}).options,
    { enabled: false, disabled: true }
  );
  assert.throws(
    () => validateCommandInput(contract, { enabled: true, disabled: true }, [], {}),
    (error) => error.code === "INVALID_OPTION_COMBINATION"
  );
});

test("hidden TTY password input preserves UTF-8 characters", async () => {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperty(stdin, "isTTY", { value: true });
  Object.defineProperty(stderr, "isTTY", { value: true });
  stdin.isRaw = false;
  stdin.setRawMode = (value) => { stdin.isRaw = value; return stdin; };
  const input = new ProcessAuthInput({ stdin, stderr });
  const reading = input.readPassword(false);
  stdin.write(Buffer.from("zażółć🔐\n", "utf8"));
  assert.equal(await reading, "zażółć🔐");
  assert.equal(stdin.isRaw, false);
});

test("password stdin preserves intentional trailing whitespace", async () => {
  const stdin = new PassThrough();
  const input = new ProcessAuthInput({ environment: {}, stdin, stderr: new PassThrough() });
  const reading = input.readPassword(true);
  stdin.end("secret \t\n");
  assert.equal(await reading, "secret \t");
});

test("auth login falls back only for browser recovery challenges", async () => {
  const recoveryRequests = [];
  const auth = {
    login: async () => {
      throw new CliError("AUTH_BROWSER_RECOVERY_REQUIRED", "Browser challenge");
    },
    recover: async (request) => {
      recoveryRequests.push(request);
      return { mechanism: "browser-companion" };
    },
    status: async (verify) => ({
      connected: true,
      backend: "web-cookie",
      verified: verify,
      accessExpiresAt: null,
      refreshExpiresAt: null
    }),
    disconnect: async () => undefined
  };
  const command = createAuthFeature(auth).commands.find((candidate) => candidate.contract.id === "auth.login");
  assert.notEqual(command, undefined);
  const context = { clock: { now: () => new Date("2026-07-17T10:00:00.000Z") } };
  const output = await command.invoke(context, {
    options: {
      username: "user@example.com",
      "password-stdin": false,
      "no-auth-recovery": false
    },
    positionals: {}
  });
  assert.equal(output.data.backend, "web-cookie");
  assert.equal(output.meta.appliedOptions.recovered, true);
  assert.deepEqual(recoveryRequests, [{ timeoutMs: 300_000, openBrowser: false }]);

  await assert.rejects(
    command.invoke(context, {
      options: {
        username: "user@example.com",
        "password-stdin": false,
        "no-auth-recovery": true
      },
      positionals: {}
    }),
    (error) => error.code === "AUTH_BROWSER_RECOVERY_REQUIRED"
  );
  assert.equal(recoveryRequests.length, 1);
});

test("auth login does not recover invalid credentials or network failures", async () => {
  let recoveryCount = 0;
  let failure = new CliError("AUTH_INVALID_CREDENTIALS", "Invalid credentials");
  const auth = {
    login: async () => { throw failure; },
    recover: async () => { recoveryCount += 1; return { mechanism: "browser-companion" }; },
    status: async () => { throw new Error("status must not be called"); },
    disconnect: async () => undefined
  };
  const command = createAuthFeature(auth).commands.find((candidate) => candidate.contract.id === "auth.login");
  const input = {
    options: { "password-stdin": false, "no-auth-recovery": false },
    positionals: {}
  };
  await assert.rejects(command.invoke({}, input), (error) => error.code === "AUTH_INVALID_CREDENTIALS");
  failure = new CliError("NETWORK_ERROR", "Network unavailable");
  await assert.rejects(command.invoke({}, input), (error) => error.code === "NETWORK_ERROR");
  assert.equal(recoveryCount, 0);
});

test("command definitions enforce declared result metadata and raw mode", async () => {
  const command = defineCommand({
    contract: {
      id: "example.read",
      path: ["example", "read"],
      summary: "Example command.",
      options: {
        raw: { type: "boolean", defaultValue: false, description: "Return raw data." }
      },
      examples: ["gconnect example read"],
      output: { dataset: "example", shape: "document" }
    },
    parse: () => ({}),
    execute: async () => result({
      command: "wrong.command",
      dataset: "wrong.dataset",
      sourceEndpoints: [],
      appliedOptions: {},
      raw: false,
      data: {}
    })
  });
  await assert.rejects(
    command.invoke({}, { options: { raw: true }, positionals: {} }),
    (error) => error.code === "INTERNAL_CONTRACT_ERROR"
  );
});

test("command registry rejects global option collisions and unknown rule references", () => {
  const definition = (contract) => ({
    id: "example",
    commands: [defineCommand({ contract, parse: () => ({}), execute: async () => result({
      command: contract.id,
      dataset: contract.output.dataset,
      sourceEndpoints: [],
      appliedOptions: {},
      data: {}
    }) })]
  });
  assert.throws(() => new CommandRegistry([definition({
    id: "example.help",
    path: ["example", "help"],
    summary: "Invalid collision.",
    options: { help: { type: "boolean", description: "Collision." } },
    examples: ["gconnect example help"],
    output: { dataset: "example", shape: "document" }
  })]), /redeclares reserved option/);
  assert.throws(() => new CommandRegistry([definition({
    id: "example.rules",
    path: ["example", "rules"],
    summary: "Invalid rule.",
    options: {},
    rules: { paired: [["missing", "also-missing"]] },
    examples: ["gconnect example rules"],
    output: { dataset: "example", shape: "document" }
  })]), /rule references unknown option/);
});

test("command registry rejects invalid option descriptors and non-executable examples", () => {
  const feature = (suffix, options, overrides = {}) => ({
    id: `example-${suffix}`,
    commands: [defineCommand({
      contract: {
        id: `example.${suffix}`,
        path: ["example", suffix],
        summary: "Example command.",
        options,
        examples: [`gconnect example ${suffix}`],
        output: { dataset: "example", shape: "document" },
        ...overrides
      },
      parse: () => ({}),
      execute: async () => result({
        command: `example.${suffix}`,
        dataset: "example",
        sourceEndpoints: [],
        appliedOptions: {},
        data: {}
      })
    })]
  });
  assert.throws(
    () => new CommandRegistry([feature("range", { count: { type: "integer", minimum: 10, maximum: 1, description: "Count." } })]),
    /minimum greater than maximum/
  );
  assert.throws(
    () => new CommandRegistry([feature("default", { count: { type: "integer", minimum: 1, maximum: 5, defaultValue: 6, description: "Count." } })]),
    /invalid integer default/
  );
  assert.throws(
    () => new CommandRegistry([feature("enum", { mode: { type: "enum", values: ["one"], defaultValue: "two", description: "Mode." } })]),
    /invalid enum default/
  );
  assert.throws(
    () => new CommandRegistry([feature("name", { Bad: { type: "boolean", description: "Invalid name." } })]),
    /invalid name/
  );
  assert.throws(
    () => new CommandRegistry([feature("example", {}, { examples: ["example example"] })]),
    /directly executable/
  );
});

test("calendar dates are real local date labels and bounded ranges are inclusive", () => {
  const from = parseCalendarDate("2024-02-28");
  const to = parseCalendarDate("2024-03-01");
  assert.deepEqual(calendarDateRange(from, to), ["2024-02-28", "2024-02-29", "2024-03-01"]);
  assert.throws(() => parseCalendarDate("2025-02-29"), (error) => error.code === "INVALID_DATE");
  assert.throws(
    () => calendarDateRange(parseCalendarDate("2026-07-18"), parseCalendarDate("2026-07-17")),
    (error) => error.code === "INVALID_DATE_RANGE"
  );
  assert.throws(
    () => calendarDateRange(parseCalendarDate("2026-01-01"), parseCalendarDate("2026-01-03"), 2),
    (error) => error.code === "DATE_RANGE_TOO_LARGE"
  );
});

test("ordered concurrency stops claiming work and settles active workers before rejecting", async () => {
  const started = [];
  let activeWorkerFinished = false;
  await assert.rejects(
    mapConcurrentOrdered([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 0) throw new Error("failed");
      await new Promise((resolve) => setImmediate(resolve));
      activeWorkerFinished = true;
      return value;
    }),
    /failed/
  );
  assert.deepEqual(started, [0, 1]);
  assert.equal(activeWorkerFinished, true);
});

test("error renderer recursively redacts secrets", () => {
  const output = renderError(new CliError("AUTH_REQUIRED", "Login failed Cookie: SID=message-secret\n?access_token=query-secret", {
    accessToken: "secret-access-token",
    nested: {
      cookie: "SID=secret",
      mfaVerificationCode: "123456",
      otp: "654321",
      passcode: "112233",
      safe: "visible",
      message: "Bearer abc.def.ghi"
    }
  }));
  assert.doesNotMatch(output, /secret-access-token|SID=secret|abc\.def\.ghi|message-secret|query-secret|123456|654321|112233/);
  assert.match(output, /visible/);
  assert.equal(JSON.parse(output).error.code, "AUTH_REQUIRED");
});

test("error renderer honors explicit retryability for auth-state and network errors", () => {
  assert.equal(JSON.parse(renderError(new CliError("AUTH_STATE_BUSY", "busy", { retryable: true }))).error.retryable, true);
  assert.equal(JSON.parse(renderError(new CliError("AUTH_STATE_CHANGED", "changed", { retryable: true }))).error.retryable, true);
  assert.equal(JSON.parse(renderError(new CliError("NETWORK_ERROR", "permanent", { retryable: false }))).error.retryable, false);
  assert.equal(JSON.parse(renderError(new CliError("NETWORK_ERROR", "temporary"))).error.retryable, true);
});

test("Garmin JSON parsing preserves unsafe integer identifiers without changing normal metrics", () => {
  assert.deepEqual(parseGarminJson('{"activityId":9223372036854775807,"heartRate":61,"respiration":14.5}'), {
    activityId: "9223372036854775807",
    heartRate: 61,
    respiration: 14.5
  });
  assert.throws(() => parseGarminJson('{"duplicate":1,"duplicate":2}'));
});

test("secure JSON store writes atomically with owner-only mode and validates schema", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-secure-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const path = join(directory, "nested", "session.json");
  const file = new SecureJsonFile(path, (input) => {
    if (input?.version !== 1) throw new TypeError("wrong version");
    return input;
  });
  await file.save({ version: 1, value: "ok" });
  assert.deepEqual(await file.load(), { version: 1, value: "ok" });
  assert.equal((await import("node:fs/promises")).stat(path).then((stat) => stat.mode & 0o777) instanceof Promise, true);
  const mode = (await (await import("node:fs/promises")).stat(path)).mode & 0o777;
  if (process.platform !== "win32") assert.equal(mode, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).value, "ok");

  if (process.platform !== "win32") {
    await chmod(dirname(path), 0o755);
    await assert.rejects(file.load(), (error) => error.code === "INSECURE_CREDENTIAL_DIRECTORY");
    await chmod(dirname(path), 0o700);
    await chmod(path, 0o644);
    await assert.rejects(file.load(), (error) => error.code === "INSECURE_CREDENTIAL_FILE");
  }
});

test("secure JSON store refuses a symlink target", async (t) => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "gconnect-symlink-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const target = join(directory, "target.json");
  const link = join(directory, "session.json");
  await (await import("node:fs/promises")).writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, link);
  const file = new SecureJsonFile(link, (input) => input);
  await assert.rejects(file.load(), (error) => error.code === "INSECURE_CREDENTIAL_FILE");
});

test("secure JSON store refuses a symlinked credential directory", async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "gconnect-directory-symlink-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const external = join(root, "external");
  const privateDirectory = join(root, ".gconnect-private");
  await mkdir(external, { mode: 0o700 });
  await writeFile(join(external, "session.json"), "{\"version\":1}\n", { mode: 0o600 });
  await symlink(external, privateDirectory, "dir");
  const file = new SecureJsonFile(join(privateDirectory, "session.json"), (input) => input);

  await assert.rejects(file.load(), (error) => error.code === "INSECURE_CREDENTIAL_DIRECTORY");
  await assert.rejects(file.save({ version: 2 }), (error) => error.code === "INSECURE_CREDENTIAL_DIRECTORY");
  await assert.rejects(file.delete(), (error) => error.code === "INSECURE_CREDENTIAL_DIRECTORY");
  assert.equal(JSON.parse(await readFile(join(external, "session.json"), "utf8")).version, 1);
});

test("secure JSON store removes its temporary file when serialization fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gconnect-secure-failure-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const file = new SecureJsonFile(join(directory, "session.json"), (input) => input);
  const circular = {};
  circular.self = circular;
  await assert.rejects(file.save(circular), /circular/i);
  assert.deepEqual(await readdir(directory), []);
});
