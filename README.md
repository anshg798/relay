# Relay — RL Gym task: durable workflow orchestrator

Coding agents must build **Relay**, an HTTP service that runs DAG workflows. External workers
claim tasks through time-limited leases; Relay handles dependencies, retries with capped
exponential backoff, cancellation, idempotent run creation, a gapless per-run event log, and
must survive `SIGKILL` restarts with no lost or duplicated work. All time comes from a logical
clock the verifier controls, so every check is deterministic.

## Layout

```
task/
  instruction.md            model-facing spec (behaviour only, no architecture)
  public/                   TypeScript starter (only /health implemented)
environment/Dockerfile      sandbox image; copies only task/ (see .dockerignore)
reference/                  reference solution (TypeScript, zero runtime deps)
evaluation/
  tests/*.mjs               65 black-box HTTP checks in 7 categories
  lib/                      harness (process per check, SIGKILL restarts) + scorer
  acceptance-criteria.yml   20 requirements → check IDs (every check is linked)
  scoring.yml               category weights (sum = 1.0)
  mutants/                  20 mutant patches + definitions (mutants.mjs)
  proof-of-work/            reference runs, mutant outputs, model runs
app-setup/                  build.sh, start.sh, reset.sh
scripts/generate.mjs        single-pass OpenHands run
package.json                generate / score / check:reference / check:mutants
```

## Commands

| Command | What it does |
|---|---|
| `npm install` | installs the scorer's only dependency (`yaml`) |
| `npm run check:reference [-- --repeat N]` | builds `reference/`, runs the verifier N times (default 2), requires 100% and identical results |
| `npm run check:mutants` | applies each patch in `evaluation/mutants/` to a copy of the reference, requires ≥1 failing check per mutant |
| `npm run generate` | one OpenHands pass for `LLM_MODEL` (see `.env.example`), result copied to `./solution` |
| `npm run score [-- --solution DIR]` | builds and scores a solution (default `./solution`) |
| `npm run env:build` | builds the `relay-env` sandbox image |
| `npm run reset` | `app-setup/reset.sh` — removes build output and state |

Requires Node.js 20+ and `bash`, `patch`, `diff`. Each check starts the solution with
`app-setup/start.sh` on its own port and empty `DATA_DIR`; recovery checks kill the whole
process group with `SIGKILL` and start it again on the same `DATA_DIR`.

## Scoring

Score = Σ category weight × (passed / total checks in category).

| Category | Weight | Checks |
|---|---|---|
| validation | 0.10 | 10 |
| scheduling | 0.20 | 12 |
| retries | 0.15 | 9 |
| leases | 0.15 | 11 |
| idempotency | 0.10 | 6 |
| cancellation | 0.10 | 6 |
| recovery | 0.20 | 11 |

## Lifecycle contract for solutions

- `app-setup/build.sh [DIR]` — `npm ci`/`npm install`, then `npm run build --if-present`.
- `app-setup/start.sh` — `npm start` in `SOLUTION_DIR` with `PORT` and `DATA_DIR` set.
- `app-setup/reset.sh [DIR]` — deletes `dist/`, `data/`, `node_modules/` and scorer temp files.

## Privacy

The agent's workspace is built only from `task/public` and `task/instruction.md`.
`reference/` and `evaluation/` are excluded from the Docker build context by `.dockerignore`
and are never mounted into the agent sandbox by `npm run generate`.
