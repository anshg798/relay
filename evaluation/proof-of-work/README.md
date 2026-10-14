# Proof of work

| Item | Location | Status |
|---|---|---|
| Reference solution run (5 repeated runs, determinism) | `reference/` | 100% on every run, identical per-check results |
| Mutant outputs (20 mutants) | `mutants/` | 20/20 killed — see `mutants/README.md` |
| Frontier model runs (OpenHands, single pass, medium reasoning) | `models/<model>/` | **In progress** — Gemini 3.8 Flash and Gemini 3.7 Flash, see `models/README.md` |

## Reference

`npm run check:reference -- --repeat 5` → `reference/run-1.json … run-5.json`, `reference/summary.json`.
All 65 score-bearing checks pass on every run, with the same per-check outcome each time.

Baseline: the unmodified starter in `task/public` scores **0%** (0/65).

## Model evaluation

For each model:

```bash
cp .env.example .env            # set LLM_MODEL, LLM_API_KEY (reasoning effort: medium)
npm run env:build               # sandbox image from environment/Dockerfile
npm run generate                # one OpenHands pass → ./solution + models/<model>/openhands.jsonl
npm run score                   # → models/<model>/score.json and score.txt
```

Each `models/<model>/` folder then contains:

- `run.json` — model id, reasoning effort, harness, iteration cap, timestamps, exit code
- `openhands.jsonl` / `openhands.stderr.log` — the full OpenHands event log
- `score.json` / `score.txt` — per-check and per-category results

Fill in the table once both runs are done (requirement: both below 30%).

| Model | Score | Passed checks | Main failure categories |
|---|---|---|---|
| `gemini/gemini-3.8-flash` | in progress | /65 | — |
| `gemini/gemini-3.7-flash` | in progress | /65 | — |

Failure categories to use when describing results (map to `scoring.yml`):
`validation`, `scheduling` (readiness/order/events), `retries` (attempt counting, backoff
math, skip propagation), `leases` (expiry boundary, heartbeat, idempotent reports, logical
clock), `idempotency`, `cancellation` (late reports, timers), `recovery` (durability after
SIGKILL), plus `build/startup` if the solution never became healthy.
