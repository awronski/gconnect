import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { gconnectPrivateDirectory } from "../../dist/auth/paths.js";
import { JsonOutputService } from "../../dist/output/output-service.js";

const commandResult = {
  meta: {
    schemaVersion: 1,
    command: "health sleep",
    dataset: "sleep",
    generatedAt: "2026-07-20T12:00:00.000Z",
    sourceEndpoints: [],
    warnings: [],
    appliedOptions: {},
    raw: false
  },
  data: { value: "fixture" }
};

test("private data is always stored under .gconnect-private in the working directory", () => {
  const cwd = join(tmpdir(), "gconnect-working-directory");
  assert.equal(gconnectPrivateDirectory(cwd), join(cwd, ".gconnect-private"));
});

test("output stays inside the private outputs directory with owner-only permissions", async (t) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "gconnect-output-"));
  const privateDirectory = join(workingDirectory, ".gconnect-private");
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));

  const stdout = [];
  const output = new JsonOutputService({ write: (value) => stdout.push(value) }, privateDirectory);
  await output.write(commandResult, { outputPath: "sleep.json" });

  const outputDirectory = join(privateDirectory, "outputs");
  const outputPath = join(outputDirectory, "sleep.json");
  assert.equal(stdout.length, 0);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), commandResult);
  if (process.platform !== "win32") {
    assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  }

  await writeFile(join(privateDirectory, "active-backend.json"), "auth-state\n", { mode: 0o600 });
  await output.write(commandResult, { outputPath: "active-backend.json" });
  assert.equal(await readFile(join(privateDirectory, "active-backend.json"), "utf8"), "auth-state\n");
  assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, "active-backend.json"), "utf8")), commandResult);

  await output.write({ ...commandResult, data: { value: "replacement" } }, { outputPath: "sleep.json" });
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).data.value, "replacement");
  assert.deepEqual((await readdir(outputDirectory)).sort(), ["active-backend.json", "sleep.json"]);
});

test("stdout output does not create private storage", async (t) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "gconnect-stdout-"));
  const privateDirectory = join(workingDirectory, ".gconnect-private");
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));

  const stdout = [];
  const output = new JsonOutputService({ write: (value) => stdout.push(value) }, privateDirectory);
  await output.write(commandResult, {});

  assert.deepEqual(JSON.parse(stdout.join("")), commandResult);
  await assert.rejects(lstat(privateDirectory), (error) => error.code === "ENOENT");
});

test("output rejects absolute, nested, traversal, and backslash paths", async () => {
  const output = new JsonOutputService({ write: () => undefined }, join(tmpdir(), ".gconnect-private-unused"));
  for (const outputPath of ["", ".", "..", "/tmp/sleep.json", "../sleep.json", "nested/sleep.json", "nested\\sleep.json"]) {
    await assert.rejects(
      output.write(commandResult, { outputPath }),
      (error) => error.code === "INVALID_OUTPUT_PATH"
    );
  }
});

test("output rejects symbolic-link private directories", async (t) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "gconnect-output-symlink-"));
  const externalDirectory = join(workingDirectory, "external");
  const privateDirectory = join(workingDirectory, ".gconnect-private");
  await mkdir(externalDirectory, { mode: 0o700 });
  await symlink(externalDirectory, privateDirectory, "dir");
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));

  const output = new JsonOutputService({ write: () => undefined }, privateDirectory);
  await assert.rejects(
    output.write(commandResult, { outputPath: "sleep.json" }),
    (error) => error.code === "INSECURE_PRIVATE_DIRECTORY"
  );
});

test("output rejects a symbolic-link outputs directory", async (t) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "gconnect-outputs-symlink-"));
  const privateDirectory = join(workingDirectory, ".gconnect-private");
  const externalDirectory = join(workingDirectory, "external");
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(externalDirectory, { mode: 0o700 });
  await symlink(externalDirectory, join(privateDirectory, "outputs"), "dir");
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));

  const output = new JsonOutputService({ write: () => undefined }, privateDirectory);
  await assert.rejects(
    output.write(commandResult, { outputPath: "sleep.json" }),
    (error) => error.code === "INSECURE_PRIVATE_DIRECTORY"
  );
});
