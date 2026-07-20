import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const ADAPTER_FEATURES = new Set(["auth", "system"]);
const SHARED_FEATURE_FILES = new Set([
  "features/auth-recovery-options.ts",
  "features/context.ts",
  "features/date-selector.ts",
  "features/feature.ts",
  "features/raw-option.ts"
]);

test("source imports are acyclic and data features stay behind shared ports", async () => {
  const files = await sourceFiles(sourceRoot);
  const dataFeatures = new Set(files.flatMap((file) => {
    const match = /^features\/([^/]+)\//.exec(relative(sourceRoot, file));
    return match?.[1] === undefined || ADAPTER_FEATURES.has(match[1]) ? [] : [match[1]];
  }));
  const graph = new Map();
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const local = relative(sourceRoot, file);
    const imports = importedSourceFiles(file, content).filter((target) => files.includes(target));
    graph.set(file, imports);

    const match = /^features\/([^/]+)\//.exec(local);
    if (match?.[1] === undefined || !dataFeatures.has(match[1])) continue;
    const component = match[1];
    assert.doesNotMatch(content, /from\s+["']node:/, `${local} imports a Node builtin`);
    assert.doesNotMatch(content, /\bprocess\.|\bfetch\s*\(/, `${local} accesses a process or fetch global`);
    for (const target of imports) {
      const imported = relative(sourceRoot, target);
      const featureMatch = /^features\/([^/]+)\//.exec(imported);
      if (featureMatch !== null && dataFeatures.has(featureMatch[1]) && featureMatch[1] !== component) {
        assert.fail(`${local} imports another data feature: ${imported}`);
      }
      if (imported.startsWith("features/") && featureMatch?.[1] !== component && !SHARED_FEATURE_FILES.has(imported)) {
        assert.fail(`${local} imports a non-shared feature module: ${imported}`);
      }
      assert.equal(
        /^(auth|download|output|storage|bin)\//.test(imported) || imported === "composition.ts",
        false,
        `${local} bypasses FeatureContext via ${imported}`
      );
    }
  }
  assertAcyclic(graph);
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat().sort();
}

function importedSourceFiles(file, content) {
  const imports = [];
  for (const match of content.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    imports.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
  }
  return imports;
}

function assertAcyclic(graph) {
  const complete = new Set();
  const active = [];
  const visit = (file) => {
    if (complete.has(file)) return;
    const cycleIndex = active.indexOf(file);
    if (cycleIndex >= 0) {
      const cycle = [...active.slice(cycleIndex), file].map((item) => relative(sourceRoot, item)).join(" -> ");
      assert.fail(`source import cycle: ${cycle}`);
    }
    active.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    active.pop();
    complete.add(file);
  };
  for (const file of graph.keys()) visit(file);
}
