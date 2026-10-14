# Relay RL Gym task — notes for Claude Code

This repo is an RL Gym task. Read README.md for the layout. Key rules:

- `task/` is model-facing. `reference/` and `evaluation/` are private and must never be
  copied into `task/` or the Docker image.
- Do not weaken or delete verifier checks to make something pass. If the reference fails a
  check, fix the reference (or the spec in task/instruction.md if they disagree), then rerun.

## How to test (run in this order, report results)

1. `npm install` — once.
2. `npm run check:reference` — must print `100% on every run; deterministic`. ~1 min.
3. `npm run check:mutants` — must print `20/20 mutants killed`. ~5 min.
4. Baseline: `npm run score -- --solution task/public --label starter` — expect 0%.
5. Single check while debugging: `npm run score -- --solution reference --only SCH-03`.

Requires Linux/macOS/WSL with bash, patch and diff. Each check starts the solution via
`app-setup/start.sh` on its own port; on failure, the error names the check ID — the test
lives in `evaluation/tests/<category>.mjs`.

## Manual smoke test

`bash app-setup/build.sh reference` then
`PORT=8080 DATA_DIR=/tmp/relay-data bash app-setup/start.sh reference`, and send the requests
in `requests.http`.

## Model runs (need API key + Docker; ask the user before running — they cost money)

`cp .env.example .env` → `npm run env:build` → `npm run generate` → `npm run score`.
Results land in `evaluation/proof-of-work/models/<model>/`.
