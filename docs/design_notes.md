# Design notes (working document)

Working notes behind the report's design rationale; they are not the report.

## Problem

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

## Early failure that shaped the design

- A clean interruption (scenario A) is the easy case: undo the wrong action, run the correction.
- The hard case is an interruption masked by noise (scenario B: a dropped pan). A system that stops the call and
  then goes silent leaves the user unsure whether it stopped, and they have to start again.
- Design response: after an undo with no usable new request, enter a CLARIFICATION state, say what was undone,
  offer the best guesses, and keep the microphone open.

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

## Sources checked before citing

Each source was looked up before use. Corrections made: Cuadra et al. (2021) appeared at CSCW, not CHI;
Myers et al. is CHI 2018 ("Patterns for how users overcome obstacles in voice user interfaces"); Jiang et al. is
SIGIR 2013 ("How do users respond to voice input errors?"); the DOI for Wenzel & Kaufman (CHI 2024) was corrected.
Avila et al. (2022) could not be found and is not cited.
