# Model runs — status

Status as of **2026-10-14 11:30 UTC**: both single-pass OpenHands runs are **in progress**.
Final scores will be recorded here and in `../README.md` as soon as the runs complete.

## Task readiness (complete)

| Item | Result |
|---|---|
| Reference solution | **100%** (65/65) on 5 repeated runs, identical per-check results (`../reference/`) |
| Mutants | **20/20 killed**, every mutant builds (`../mutants/`) |
| Starter baseline (`task/public`) | **0%** (0/65) |
| Scoring weights | sum to 1.0 across 7 categories (`../../scoring.yml`) |
| Privacy | `reference/` and `evaluation/` excluded by `.dockerignore`; the sandbox image copies only `task/public` and `task/instruction.md` |
| Generation pipeline | verified end to end with a smoke task (agent seeded, tools executed, log captured, workspace exported) |

## Run configuration

| Setting | Value |
|---|---|
| Harness | OpenHands CLI 1.16.0 (SDK 1.21.0), headless, single pass |
| Sandbox | `relay-env` image built from `environment/Dockerfile` |
| Models | `gemini/gemini-3.8-flash`, `gemini/gemini-3.7-flash` (two different models, run in parallel) |
| Reasoning effort | `medium` (seeded into the agent settings; recorded in each `run.json`) |
| Iteration cap | 500 (OpenHands SDK default; the CLI exposes no override) |
| Prompt caching | off (the Gemini free tier has no context-cache quota) |
| LLM retries | 15, backoff capped at 120 s (rides out provider overload; does not change model behaviour) |

## Progress at time of writing

| Model | Started (UTC) | Agent actions | Code written | Fatal errors |
|---|---|---|---|---|
| `gemini/gemini-3.8-flash` | 10:52 | 13 | 6 files, ~1,900 lines | 0 |
| `gemini/gemini-3.7-flash` | 10:53 | 15 | 5 files, ~1,675 lines | 0 |

Both runs are pacing slowly because the Gemini API is returning intermittent
`503 UNAVAILABLE` ("model is experiencing high demand") and `429` per-minute limits; the
retry settings above absorb these, and neither run has hit a fatal error.

An earlier attempt for each model ended on its first LLM call (503 after the default 4
retries) before the agent took any action; those workspaces were discarded and each model
was restarted from a clean copy of `task/public`. The runs above are each model's single
complete pass.

## Harness fixes made in `scripts/generate.mjs`

While preparing the runs, the generation script was corrected so the recorded settings match
what actually runs:

- added `--override-with-envs` (without it the OpenHands CLI ignores `LLM_MODEL`/`LLM_API_KEY`);
- reasoning effort is now seeded into the agent settings (the CLI otherwise defaults to `high`);
- `run.json` records the real iteration cap (500) instead of an unused 150;
- new options `LLM_CACHING_PROMPT` and `LLM_NUM_RETRIES` (documented in `.env.example`).

## When the runs finish

Each `models/<model>/` folder will contain `run.json`, `openhands.jsonl`,
`openhands.stderr.log`, and `score.json` / `score.txt` from `npm run score`, and the results
table in `../README.md` will be filled in with scores and main failure categories.
