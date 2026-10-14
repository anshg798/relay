#!/usr/bin/env node
// npm run generate -- [--model <litellm model id>] [--no-docker]
//
// Single-pass solution generation with OpenHands:
//   1. copies task/public into runs/<model-slug>/workspace (fresh every time)
//   2. runs OpenHands headless once with task/instruction.md as the task
//   3. copies the result to ./solution so `npm run score` evaluates it
//   4. stores the OpenHands JSONL log under evaluation/proof-of-work/models/<slug>/
//
// Environment (see .env.example): LLM_MODEL, LLM_API_KEY, LLM_BASE_URL (optional),
// LLM_REASONING_EFFORT (default "medium", seeded into the OpenHands agent settings),
// LLM_CACHING_PROMPT (default "true"; "false" for providers without prompt caching, e.g. Gemini free tier),
// LLM_NUM_RETRIES (default 5; retries for rate-limit/overload errors, backoff capped at 120s),
// OPENHANDS_CMD (override the agent command; {task} is replaced by the task file path).
//
// By default the agent runs inside the task sandbox image (relay-env, built from
// environment/Dockerfile) with the OpenHands CLI installed on top at run time.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no dependency).
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined && m[2] !== "") process.env[m[1]] = m[2];
  }
}

const { values } = parseArgs({
  options: {
    model: { type: "string", default: process.env.LLM_MODEL },
    "no-docker": { type: "boolean", default: false },
  },
});
const model = values.model;
if (!model) {
  console.error("generate: set LLM_MODEL (or pass --model)");
  process.exit(2);
}
if (!process.env.LLM_API_KEY) {
  console.error("generate: set LLM_API_KEY");
  process.exit(2);
}

const slug = model.replace(/[^a-zA-Z0-9._-]+/g, "_");
const runDir = path.join(ROOT, "runs", slug);
const workspace = path.join(runDir, "workspace");
const powDir = path.join(ROOT, "evaluation", "proof-of-work", "models", slug);
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(powDir, { recursive: true });
fs.cpSync(path.join(ROOT, "task", "public"), workspace, { recursive: true });

const instruction = fs.readFileSync(path.join(ROOT, "task", "instruction.md"), "utf8");
const taskFile = path.join(runDir, "task.md");
fs.writeFileSync(
  taskFile,
  `${instruction}\n\n---\nYou are working in the project directory (/workspace). Implement the service there. ` +
    `The grader will run \`npm install\`, \`npm run build\` and \`npm start\` in that directory. ` +
    `This is a single attempt: finish when your implementation is complete.\n`,
);

const env = {
  ...process.env,
  LLM_MODEL: model,
  LLM_REASONING_EFFORT: process.env.LLM_REASONING_EFFORT ?? "medium",
  OPENHANDS_SUPPRESS_BANNER: "1",
};
const passEnv = ["LLM_MODEL", "LLM_API_KEY", "LLM_BASE_URL", "LLM_REASONING_EFFORT", "LLM_CACHING_PROMPT", "LLM_NUM_RETRIES", "OPENHANDS_SUPPRESS_BANNER"].filter((k) => env[k]);
// The OpenHands CLI (1.x) has no flag or env var for reasoning effort; without saved settings
// it builds the LLM with the SDK default ("high"). Seed ~/.openhands/agent_settings.json with
// the requested effort; --override-with-envs then supplies model, key and base URL from env.
// It also has no iteration-limit option: conversations run with the SDK default of 500.
const OPENHANDS_MAX_ITERATIONS = 500;
const seedFile = path.join(runDir, "seed_agent.py");
fs.writeFileSync(
  seedFile,
  `import os
from openhands.sdk import LLM
from openhands_cli.stores import agent_store as s
llm = LLM(model=os.environ["LLM_MODEL"], api_key=os.environ["LLM_API_KEY"],
          base_url=os.environ.get("LLM_BASE_URL") or None, usage_id="agent",
          reasoning_effort=os.environ.get("LLM_REASONING_EFFORT", "medium"),
          caching_prompt=os.environ.get("LLM_CACHING_PROMPT", "true").lower() != "false",
          num_retries=int(os.environ.get("LLM_NUM_RETRIES", "5")), retry_max_wait=120)
s.AgentStore().save(s.get_default_cli_agent(llm))
print(f"seeded agent: {llm.model} reasoning_effort={llm.reasoning_effort} caching_prompt={llm.caching_prompt} num_retries={llm.num_retries}", flush=True)
`,
);
const DEFAULT_CMD = "openhands --headless --json --override-with-envs -f {task}";

const logFile = path.join(powDir, "openhands.jsonl");
const started = new Date().toISOString();
let res;
if (values["no-docker"]) {
  const cmd = (process.env.OPENHANDS_CMD ?? DEFAULT_CMD).replace("{task}", JSON.stringify(taskFile));
  res = spawnSync("bash", ["-lc", cmd], { cwd: workspace, env, encoding: "utf8", maxBuffer: 1 << 30 });
} else {
  const inner = (process.env.OPENHANDS_CMD ?? DEFAULT_CMD).replace("{task}", "/task/task.md");
  const script = [
    "set -e",
    "command -v openhands >/dev/null || (curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null && ~/.local/bin/uv tool install --python 3.12 openhands >/dev/null)",
    'export PATH="$HOME/.local/bin:$PATH"',
    "$HOME/.local/share/uv/tools/openhands/bin/python /task/seed_agent.py >&2",
    "cd /workspace",
    inner,
  ].join(" && ");
  const args = ["run", "--rm", "-v", `${workspace}:/workspace`, "-v", `${runDir}:/task:ro`];
  for (const k of passEnv) args.push("-e", k);
  args.push(process.env.RELAY_ENV_IMAGE ?? "relay-env", "bash", "-lc", script);
  res = spawnSync("docker", args, { env, encoding: "utf8", maxBuffer: 1 << 30 });
}
fs.writeFileSync(logFile, res.stdout ?? "");
fs.writeFileSync(path.join(powDir, "openhands.stderr.log"), res.stderr ?? "");

// Hand the workspace to the scorer.
const solution = path.join(ROOT, "solution");
fs.rmSync(solution, { recursive: true, force: true });
fs.cpSync(workspace, solution, {
  recursive: true,
  filter: (src) => !path.relative(workspace, src).split(path.sep).some((p) => ["node_modules", "dist", "data"].includes(p)),
});
fs.writeFileSync(path.join(solution, ".relay-model"), slug);

fs.writeFileSync(
  path.join(powDir, "run.json"),
  JSON.stringify(
    {
      model,
      reasoningEffort: env.LLM_REASONING_EFFORT,
      harness: "OpenHands (headless, single pass)",
      maxIterations: OPENHANDS_MAX_ITERATIONS,
      started,
      finished: new Date().toISOString(),
      exitCode: res.status,
    },
    null,
    2,
  ) + "\n",
);
console.log(`generate: OpenHands exited with ${res.status}; solution copied to ./solution; log at ${path.relative(ROOT, logFile)}`);
console.log("next: npm run score");
