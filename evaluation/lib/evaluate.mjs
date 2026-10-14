// Shared evaluation pipeline: build a solution, run every verifier check, score it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { checks, Client, Server } from "./harness.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVAL = path.join(ROOT, "evaluation");
const CHECK_TIMEOUT_MS = 60_000;

let loaded = false;
async function loadChecks() {
  if (loaded) return;
  const dir = path.join(EVAL, "tests");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    await import(pathToFileURL(path.join(dir, f)).href);
  }
  loaded = true;
}

/** Load scoring.yml + acceptance-criteria.yml and verify they are consistent with the checks. */
export async function loadConfig() {
  await loadChecks();
  const scoring = YAML.parse(fs.readFileSync(path.join(EVAL, "scoring.yml"), "utf8"));
  const criteria = YAML.parse(fs.readFileSync(path.join(EVAL, "acceptance-criteria.yml"), "utf8"));
  const cats = scoring.categories;
  const sum = Object.values(cats).reduce((s, c) => s + c.weight, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`scoring.yml weights sum to ${sum}, expected 1.0`);
  const ids = new Set(checks.map((c) => c.id));
  for (const c of checks) if (!cats[c.category]) throw new Error(`check ${c.id} has unknown category ${c.category}`);
  for (const cat of Object.keys(cats)) {
    if (!checks.some((c) => c.category === cat)) throw new Error(`category ${cat} has no checks`);
  }
  const covered = new Set();
  for (const ac of criteria.criteria) {
    for (const id of ac.checks) {
      if (!ids.has(id)) throw new Error(`${ac.id} references unknown check ${id}`);
      covered.add(id);
    }
  }
  const orphans = [...ids].filter((id) => !covered.has(id));
  if (orphans.length) throw new Error(`checks not linked to any acceptance criterion: ${orphans.join(", ")}`);
  return { scoring, criteria, checks };
}

export function build(solutionDir, logFile) {
  const r = spawnSync("bash", [path.join(ROOT, "app-setup", "build.sh"), solutionDir], { encoding: "utf8" });
  if (logFile) fs.writeFileSync(logFile, `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  return r.status === 0;
}

async function runOne(chk, solutionDir, workRoot) {
  const workDir = path.join(workRoot, chk.id);
  fs.mkdirSync(workDir, { recursive: true });
  const server = new Server({ root: ROOT, solutionDir, workDir });
  const client = new Client(server);
  client.restart = () => server.restart();
  const t0 = Date.now();
  try {
    await server.start();
    let timer;
    await Promise.race([
      chk.fn(client),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`check timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    return { id: chk.id, category: chk.category, title: chk.title, passed: true, ms: Date.now() - t0 };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).split("\n").slice(0, 12).join("\n");
    return { id: chk.id, category: chk.category, title: chk.title, passed: false, ms: Date.now() - t0, error: msg };
  } finally {
    await server.kill();
  }
}

/**
 * Evaluate a solution directory. Returns a result object (also written to `out` if given).
 */
export async function evaluate({ solutionDir, label = "solution", out, skipBuild = false, only, concurrency = 4, log = console.log }) {
  const { scoring } = await loadConfig();
  solutionDir = path.resolve(solutionDir);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `relay-eval-${label.replace(/[^a-z0-9_-]/gi, "_")}-`));
  const selected = only ? checks.filter((c) => only.includes(c.id)) : checks;

  let built = true;
  if (!skipBuild) built = build(solutionDir, path.join(workRoot, "build.log"));

  let results;
  if (!built) {
    log(`[${label}] build failed — every check fails (see ${path.join(workRoot, "build.log")})`);
    results = selected.map((c) => ({ id: c.id, category: c.category, title: c.title, passed: false, ms: 0, error: "build failed" }));
  } else {
    results = new Array(selected.length);
    let next = 0;
    const worker = async () => {
      while (next < selected.length) {
        const i = next++;
        results[i] = await runOne(selected[i], solutionDir, workRoot);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  }

  const categories = {};
  let score = 0;
  for (const [name, cat] of Object.entries(scoring.categories)) {
    const rs = results.filter((r) => r.category === name);
    const passed = rs.filter((r) => r.passed).length;
    const fraction = rs.length ? passed / rs.length : 0;
    categories[name] = { weight: cat.weight, passed, total: rs.length, fraction: round(fraction), contribution: round(cat.weight * fraction) };
    score += cat.weight * fraction;
  }
  const result = {
    label,
    solutionDir: path.relative(ROOT, solutionDir) || ".",
    built,
    score: round(score),
    scorePercent: round(score * 100, 2),
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    categories,
    checks: results.map(({ ms, ...r }) => r),
  };
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  }
  fs.rmSync(workRoot, { recursive: true, force: true });
  return result;
}

export function summary(result) {
  const lines = [`${result.label}: score ${result.scorePercent}% (${result.passed}/${result.total} checks)`];
  for (const [name, c] of Object.entries(result.categories)) {
    lines.push(`  ${name.padEnd(13)} ${String(c.passed).padStart(2)}/${String(c.total).padEnd(2)}  weight ${c.weight.toFixed(2)}  -> ${c.contribution.toFixed(4)}`);
  }
  const failed = result.checks.filter((c) => !c.passed);
  if (failed.length) {
    lines.push("  failed checks:");
    for (const f of failed) lines.push(`    ${f.id} ${f.title}: ${f.error.split("\n")[0].slice(0, 160)}`);
  }
  return lines.join("\n");
}

function round(x, d = 6) {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}
