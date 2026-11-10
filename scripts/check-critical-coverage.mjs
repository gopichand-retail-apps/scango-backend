import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coverageSummaryPath = fileURLToPath(new URL("../coverage/coverage-summary.json", import.meta.url));
const coverageSummary = JSON.parse(readFileSync(coverageSummaryPath, "utf8"));
const criticalFiles = [
  "src/checkout.machine.mjs",
  "src/checkout.repository.mjs",
  "src/checkout.service.mjs",
  "src/content-model.schema.mjs",
  "src/routes.mjs",
  "src/server.mjs",
];
const requiredPercent = 95;
const metrics = ["lines", "statements", "functions", "branches"];

for (const path of criticalFiles) {
  const absolutePath = resolve(path);
  const fileCoverage = coverageSummary[absolutePath];
  assert.ok(fileCoverage, `Missing coverage report for critical file: ${path}`);
  for (const metric of metrics) {
    const percent = fileCoverage[metric].pct;
    assert.ok(percent >= requiredPercent, `${path} ${metric} coverage is ${percent}%, below ${requiredPercent}%.`);
  }
}

process.stdout.write(
  `Critical checkout coverage passed (${criticalFiles.length} files, ${requiredPercent}% each metric).\n`,
);
