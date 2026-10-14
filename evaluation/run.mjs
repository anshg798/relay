#!/usr/bin/env node
// npm run score -- [--solution <dir>] [--label <name>] [--out <file>] [--only ID,ID] [--concurrency N] [--skip-build]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { evaluate, ROOT, summary } from "./lib/evaluate.mjs";

const { values } = parseArgs({
  options: {
    solution: { type: "string", default: process.env.SOLUTION_DIR ?? "solution" },
    label: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "skip-build": { type: "boolean", default: false },
  },
});

// Solutions produced by `npm run generate` carry the model slug; their results go to proof-of-work.
const marker = path.join(path.resolve(values.solution), ".relay-model");
const modelSlug = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : null;
const label = values.label ?? modelSlug ?? path.basename(path.resolve(values.solution));
const out =
  values.out ??
  (modelSlug
    ? path.join(ROOT, "evaluation", "proof-of-work", "models", modelSlug, "score.json")
    : path.join(ROOT, ".eval-tmp", "results", `${label}.json`));
const result = await evaluate({
  solutionDir: values.solution,
  label,
  out,
  skipBuild: values["skip-build"],
  only: values.only ? values.only.split(",") : undefined,
  concurrency: Number(values.concurrency),
});
console.log(summary(result));
fs.writeFileSync(out.replace(/\.json$/, ".txt"), summary(result) + "\n");
console.log(`results written to ${path.relative(process.cwd(), out)}`);
