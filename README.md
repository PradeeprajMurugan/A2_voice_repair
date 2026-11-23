# Sous — barge-in repair for a hands-busy kitchen voice assistant

Assignment 2 prototype · Intelligent Interactive Systems · University of Birmingham

**README prose word count: 966** (code blocks and commands not counted; `py tools/wordcount.py README.md`)

When a voice assistant mishears ("Calling Mom…" instead of a timer), Sous lets the cook cut in with
"No, wait — a timer". It stops talking, undoes the wrong action first, says in one sentence what it undid,
then does the right thing — or asks one short question if noise swallowed the correction.

## Project status

| Part | Status |
|---|---|
| Dialogue manager: yield the floor, undo first, clarify, explicit timeouts | Implemented |
| Rule-based parser: repair markers, fuzzy fragments ("…imer"), slots | Implemented |
| Policy: act / confirm / ask from confidence × cost; cost-dependent barge-in threshold | Implemented |
| Five pre-action checks; replies built from tool results | Implemented |
| Browser UI: turn indicator, kitchen state, option chips, "Why it did that" log | Implemented |
| Speech in/out (Web Speech API, Chrome/Edge) | Implemented |
| LLM interpreter (Claude API) for requests the rules are unsure about | Implemented, optional; tested with a fake model only |
| Calls, timers, music, shopping list | Simulated in the browser |
| Kitchen noise and pan drops | Simulated (typed input degraded on purpose) |
| Acoustic echo cancellation | Placeholder: text-level echo filter; use headphones |
| Real smart speaker, phone line, learning the user's own correction words | Planned |

## Run it

Needs Python 3.10+ and Chrome or Edge. No other dependencies.

```bash
py server.py
```

Open http://localhost:8000 for the **guided demo**: three short stories in which Sous gets something
wrong and you fix it, plus a free-play tab with the microphone. The buttons speak for you, so no
microphone is needed. **Behind the scenes** (`lab.html`) has the noise controls, scenario replays and
the full decision log.

Tests (no microphone, speaker or key needed): open http://localhost:8000/tests.html.
It replays five scenarios on a simulated clock and runs 16 unit tests.

### Optional: the LLM interpreter

```bash
py -m pip install -r requirements.txt
```

```bash
$env:ANTHROPIC_API_KEY = "<your own key>"; py server.py
```

The key stays in your shell and in `server.py`; the browser never sees it and it is never committed.
Without a key the server prints `LLM interpreter: off` and everything else works. When on, the typed or
spoken utterance is sent to the Claude API. Model: `claude-opus-5-5` at low effort; override with
`SOUS_MODEL`, e.g. a Haiku model for lower latency.

## How to inspect it

| Where | What |
|---|---|
| [src/dialogue.js](src/dialogue.js) | States, barge-in handling, undo-first repair, clarification |
| [src/policy.js](src/policy.js) | The two decision rules and their thresholds |
| [src/tools.js](src/tools.js) | Simulated actions, risk profiles, checks, result wording |
| [src/parser.js](src/parser.js) | Repair markers, fuzzy matching, slot extraction |
| [scenarios/](scenarios/) | Recorded runs A–E with expected outcomes |
| [tests/runner.js](tests/runner.js) | Replay engine and unit tests |
| Export log button | Full JSON event log of a live session |

## Technology stack

- **Browser JavaScript (ES modules), no build step.** Easy for a marker to run and read.
- **Web Speech API** for recognition and synthesis; interim results let the assistant stop talking before
  the final transcript arrives.
- **Python standard-library server.** Serves files and proxies the optional model call.
- **Claude API** via the `anthropic` Python SDK, structured JSON output. Undecided: whether a smaller
  model's lower latency is worth its accuracy for this task; not measured yet.

## Development record

**Stage 1 — problem and concepts** ([a4868a3](../../commit/a4868a3)). Stated the problem and mapped
Weeks 1–4 concepts to planned choices in [docs/design_notes.md](docs/design_notes.md). Listed every source
to check before citing.

**Stage 2 — core logic** ([86f9024](../../commit/86f9024), [3573671](../../commit/3573671),
[6fc4230](../../commit/6fc4230), [b9c1b8e](../../commit/b9c1b8e)). Built tools, parser, policy and dialogue
manager as separate modules so each decision can be tested alone. Calls got a 3-second grace window
because a connected call cannot be undone.

**Stage 3 — "stop" versus "correct"** ([642b003](../../commit/642b003)). While writing scenario D,
"stop the music" undid the music and then asked "What did you want instead?". Repairs are now split:
stop words just report; correction words or noise-masked speech open a question.

**Stage 4 — replay tests** ([5b1bdb4](../../commit/5b1bdb4), [aa29d9e](../../commit/aa29d9e)). First run:
2 of 5 scenarios failed. One was a real bug: the undo report and the question were joined without a space,
which speech synthesis would run together. One was a test that did not overlap the assistant's speech as
its story said. After fixes: 5/5.

**Stage 5 — UI and a latency bug** ([0682abb](../../commit/0682abb), [8a48d4c](../../commit/8a48d4c)).
Measured in the live UI, barge-in to undo took 146 ms, over the ~0.1 s "instant" threshold. Parsing and
speech cancel were each under 1 ms; creating the audio context for the stop sound was the cause. Undo now
runs first: 2 ms.

**Stage 6 — optional model** ([39bbbad](../../commit/39bbbad)). The model is asked only when the rules are
unsure about the request, never before the undo. Its test exposed a risk: a model-only guess ("get my old
man on the line" → call Dad, 0.84) would have dialled unasked. High-cost actions supported only by the
model are now always confirmed. Not yet checked against the real API.

**Stage 7 — storyboards and sources** ([d2f93fc](../../commit/d2f93fc), [43e296f](../../commit/43e296f)).
Capturing storyboard screenshots showed the turn indicator wrongly reading "Stopped" for 0.7 s after every
page load, hiding the call countdown; fixed. Checking the sources corrected the venue of
Cuadra et al. (CSCW 2021, not CHI), the years of Myers et al. (2018) and Jiang et al. (2013) and the DOI of
Wenzel & Kaufman; Avila et al. (2022) could not be found and was dropped.

## AI assistance

- **Tool:** Claude Code (Claude Opus 5.5) in the Claude desktop app.
- **Asked for:** turning my problem statement and test plan into a prototype plan; mapping lecture concepts to
  design choices; writing the code, tests and scenarios; drafting this README.
- **How results were checked:** every scenario and unit test run in the browser and recorded above with
  pass counts; the latency figure measured in the running app; the no-key path checked by starting the server
  without the `anthropic` package.
- **What changed because of checking:** the four fixes in stages 3–6 came from tests or measurement, not
  from the first version of the code.
- TODO (student): add the design decisions you changed or rejected, and what you checked yourself.

## Additional files

- [docs/design_notes.md](docs/design_notes.md) — concept map and literature to verify.
- No ZIP: everything is in this repository.
