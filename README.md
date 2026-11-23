# Sous — barge-in repair for a hands-busy kitchen voice assistant

Intelligent Interactive Systems · University of Birmingham

**README prose word count: 1403** (code blocks and commands not counted; `py tools/wordcount.py README.md`)

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
| Guided demo (front page): three stories where Sous errs on purpose and the user repairs it; free play | Implemented |
| Behind-the-scenes page: noise controls, scenario replay, full decision log | Implemented |
| Speech in/out (Web Speech API, Chrome/Edge) | Implemented |
| LLM interpreter (Claude API) for requests the rules are unsure about | Implemented, optional; tested with a fake model only |
| Calls, timers, music, shopping list | Simulated in the browser |
| Kitchen noise and pan drops | Simulated (typed input degraded on purpose) |
| Acoustic echo cancellation | Placeholder: removes the assistant's own recent words from the transcript; headphones still best |
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
It replays five scenarios on a simulated clock and runs 19 unit tests.

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
| [src/demo.js](src/demo.js) | Guided demo: the three stories and their plain-language explanations |
| [src/dialogue.js](src/dialogue.js) | States, barge-in handling, undo-first repair, clarification |
| [src/policy.js](src/policy.js) | The two decision rules and their thresholds |
| [src/tools.js](src/tools.js) | Simulated actions, risk profiles, checks, result wording |
| [src/parser.js](src/parser.js) | Repair markers, fuzzy matching, slot extraction |
| [scenarios/](scenarios/) | Recorded runs A–E with expected outcomes |
| [tests/runner.js](tests/runner.js) | Replay engine and unit tests |
| [lab.html](lab.html) → Export log | Full JSON event log of a live session |
| [docs/storyboards/](docs/storyboards/) | Storyboards built from real screenshots of the demo |

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

**Stage 8 — Sous heard itself** ([7156c4b](../../commit/7156c4b)). In a live microphone session on
laptop speakers, Sous answered its own voice: the recogniser handed back its question glued to my
"no no stop", so it asked "Timer for how many minutes?" three times. The old filter only checked while
Sous was still speaking, but transcripts arrive after the audio ends. Sous now removes its own recent
words from what it hears, and "stop" anywhere in an answer ends a question. "Hello" also got a list of
features instead of a greeting; fixed. The session became three regression tests (19/19 pass).

**Stage 9 — a demo people understand** ([4889821](../../commit/4889821), [627597d](../../commit/627597d)).
Friends shown the first interface did not know what to do with it: the assistant, noise controls and
logs shared one screen, and nothing went wrong unless you knew how to cause it, so there was nothing to
repair. The front page is now a guided demo that makes Sous mishear on purpose and walks the user through
the fix, showing "You said" beside "Sous heard". The technical screen moved to `lab.html`. Capturing the
new storyboards showed that the interrupt button stayed active after use, so a second press undid the
correction itself; it is now hidden once used.

## AI assistance

- **Tool:** Claude Code (Claude Opus 5.5) in the Claude desktop app.
- **Asked for:** turning my problem statement and test plan into a prototype plan; mapping lecture concepts to
  design choices; writing the code, tests and scenarios; drafting this README and the report.
- **How results were checked:** every scenario and unit test run in the browser and recorded above with
  pass counts; the latency figure measured in the running app; the no-key path checked by starting the server
  without the `anthropic` package.
- **What changed because of checking:** the fixes in stages 3–9 came from tests, measurement or my own
  use of the prototype, not from the first version of the code.
- **What I decided, changed or rejected:**
  - Kept the kitchen interrupt-and-repair idea after weighing a switch to a different project: the
    problem was how the prototype was presented, not the idea.
  - Rejected the first three-panel interface as the front page after friends could not tell how to use
    it, and asked for a guided demo that makes the mistake happen so the repair can be seen.
  - Asked for the project to stand on its own, citing the literature directly rather than earlier
    coursework.
  - Kept the scope to one interaction, interrupting and repairing a wrong action, instead of adding features.
- **What I checked myself:** I tested the microphone on laptop speakers and reported the transcript in
  which Sous answered its own voice (stage 8), then re-ran five spoken checks after the fix; clicked
  through the guided demo; read the exported Word report; and confirmed in a private browser window that
  this repository is public.
- **Also drafted with Claude:** the report text, including its reflection section, which I read and checked
  against what happened.

## Additional files

- [docs/design_notes.md](docs/design_notes.md) — concept map and the sources checked.
- Storyboard screenshots: `index.html?story=N&auto=1&quiet` captured with headless Chrome in virtual time
  (so on-screen undo times read 0 ms; the live figure is 2 ms); `docs/storyboards/build_storyboards.py`
  composes them.
- No ZIP: everything is in this repository.
