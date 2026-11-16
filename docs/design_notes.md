# Design notes (working document)

Carried forward from Assignment 1 and Labs 1–3. These notes feed the A2 report's rationale; they are not the report.

## Problem (A1, revised)

People cooking with busy hands and eyes rely on a voice assistant. When it mishears and starts the wrong action
(for example "Calling Mom" instead of "set a timer"), current assistants make recovery slow: the user must wait for the
assistant to finish speaking, hear a generic error, and restate the whole command. Recovery pulls attention from the
physical task.

## Contribution: "seamless co-op recovery"

The user interrupts the assistant mid-action ("No, wait — a timer"). The system:

1. yields the turn immediately (stops speaking),
2. halts or undoes the wrong action first,
3. gives one short self-repair line built from the action's real result,
4. carries out the correction, or asks a narrow clarification question if the correction was lost in noise.

## Lab 3 findings that shaped the design

- Test A (clean barge-in): undo + new action works as specified.
- Test B (barge-in masked by a dropped pan): the system stopped the call but went silent. The user could not tell
  whether the call had stopped and had to start again.
- Revision: after an undo with no usable new intent, enter a CLARIFICATION state, say what was undone, ask what was
  wanted instead, keep the microphone open.

## Lecture concepts mapped to design choices

| Design choice | Concept (lecture) |
|---|---|
| Stop speaking the moment a barge-in is detected | Turn-taking, "holding the floor" failure (Sacks et al., 1974; L07); self-repair preference (Schegloff et al., 1977; L07) |
| Undo first, acknowledge within ~0.1–1 s | Response-time thresholds (Miller, 1968; Nielsen, 1993; L04); feedback (Norman, 2013); fast decay of working memory (Peterson & Peterson, 1959; L05) |
| Act / confirm / ask from confidence × cost | Mixed initiative (Horvitz, 1999; L03); reversible/visible matrix (L12) |
| Barge-in criterion depends on the running action's cost | Signal detection, criterion vs sensitivity (Green & Swets, 1966; L04); cry-wolf effect (Breznitz, 1984; L04) |
| Clarify with at most three options, never "try again" | Clarify repair turn (L07); ~4 chunks (Cowan, 2001; L05); G9 efficient correction (Amershi et al., 2019; L03) |
| One-sentence repair line | Grice's quantity maxim (Grice, 1975; L07) |
| Speech for I/O, glanceable screen for state | Multiple resources (Wickens, 2002; L04); hybrid interface (L07); system carries state (L05) |
| Model proposes an intent, code validates and executes; reply built from tool return value | "The model proposes, your system disposes", five checks, process hallucination (L12) |
| Session-only event log, no long-term memory | Store less; inspectable / editable / forgettable memory (L10) |

## Literature to re-verify before citing (A1 marking flagged a suspect citation)

- Cuadra et al. (2021), CHI '21, doi:10.1145/3411764.3445778 — checked in Lab 1.
- Wenzel & Kaufman (2024), CHI '24, doi:10.1145/3613904.3642398 — checked in Lab 1.
- Myers et al. — A1 says 2020; likely CHI 2018 ("Patterns for how users overcome obstacles in voice user interfaces"). Verify.
- Avila et al. (2022) — not yet verified. Verify or drop.
- Jiang et al. — A1 says 2023; likely SIGIR 2013 ("How do users respond to voice input errors?"). Verify.
