#!/usr/bin/env node
// npm run check:reference [-- --repeat N]
// Builds reference/, runs the full verifier N times (default 2), and requires a
// 100% score with identical per-check outcomes on every run (determinism).
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { evaluate, ROOT, summary } from "./lib/evaluate.mjs";

const { values } = parseArgs({
  options: { repeat: { type: "string", default: "2" }, concurrency: { type: "string", default: "4" } },
});
const repeat = Math.max(1, Number(values.repeat));
const POW = path.join(ROOT, "evaluation", "proof-of-work", "reference");
fs.mkdirSync(POW, { recursive: true });

const runs = [];
for (let i = 1; i <= repeat; i++) {
  const r = await evaluate({
    solutionDir: path.join(ROOT, "reference"),
    label: `reference-run-${i}`,
    out: path.join(POW, `run-${i}.json`),
    skipBuild: i > 1,
    concurrency: Number(values.concurrency),
  });
  console.log(summary(r));
  runs.push(r);
}

const sig = (r) => JSON.stringify(r.checks.map((c) => [c.id, c.passed]));
const deterministic = runs.every((r) => sig(r) === sig(runs[0]) && r.score === runs[0].score);
const perfect = runs.every((r) => r.score === 1);

fs.writeFileSync(
  path.join(POW, "summary.json"),
  JSON.stringify({ runs: runs.length, checks: runs[0].total, scores: runs.map((r) => r.scorePercent), perfect, deterministic }, null, 2) + "\n",
);

console.log(`\nreference: ${perfect ? "100% on every run" : "NOT 100%"}; ${deterministic ? "deterministic" : "NON-DETERMINISTIC"} across ${runs.length} runs`);
process.exit(perfect && deterministic ? 0 : 1);
