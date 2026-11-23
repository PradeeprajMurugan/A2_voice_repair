"""Compose storyboards: each row pairs the cook's action with a real screenshot of the guided demo.

    py docs/storyboards/build_storyboards.py        # writes docs/storyboards/storyboard_*.html

Screenshots in raw/ are captured from the running demo with headless Chrome
(index.html?story=N&auto=1&quiet, virtual time; see the README). Each board HTML is then
rendered to PNG with the same headless Chrome (--screenshot, window size printed below).
"""
import html
import os

HERE = os.path.dirname(os.path.abspath(__file__))

BOARDS = {
    "A": ("Storyboard A — it mishears, the cook interrupts", [
        ("A1", "Hands in dough: “Set a ten-minute timer.”",
         "Hears “call mom”. Starts dialling, with 3 s before the call connects; shows what it heard."),
        ("A2", "Talks over it: “No, wait — a ten-minute timer!”",
         "Stops speaking, cancels the call (2 ms), sets the timer and says both in one line."),
        ("A3", "Back to kneading.",
         "Timer running; the call never connected. The demo explains what happened and why."),
    ]),
    "B": ("Storyboard B — noise swallows the correction", [
        ("B1", "“No, wait —” 💥 a pan crashes “…imer!”",
         "Hears only “no wait … imer”. Cancels the call anyway and guesses: “Did you want a timer?”"),
        ("B2", "“Yes.”",
         "Asks only for the missing detail, with buttons as well as speech."),
        ("B3", "“Ten minutes.”",
         "Timer set. No silent failure and no starting over."),
    ]),
    "C": ("Storyboard C — it asks before an action it cannot undo", [
        ("C1", "Over the extractor fan: “Set a timer for five minutes.”",
         "Half-hears “call mom” (70% sure). A call cannot be undone, so it asks: “Call Mom?”"),
        ("C2", "“No — set a timer for five minutes.”",
         "Takes the “no” and the real request in one turn. Nothing was dialled."),
    ]),
}

COOK = """<svg width="72" height="72" viewBox="0 0 96 96" aria-hidden="true">
<circle cx="34" cy="22" r="12" fill="none" stroke="#3d3d3d" stroke-width="2.5"/>
<path d="M34 34 L34 66 M34 66 L24 90 M34 66 L44 90 M34 44 L58 58 M34 44 L54 66" fill="none" stroke="#3d3d3d" stroke-width="2.5" stroke-linecap="round"/>
<path d="M50 62 Q66 82 84 62 Z" fill="#e9dcc6" stroke="#3d3d3d" stroke-width="2"/>
</svg>"""

# Crop of the 1280x900 screenshot: the demo's kitchen (left) and instructions (right).
CROP_X, CROP_Y, CROP_W, CROP_H = 74, 270, 1132, 490
SCALE = 0.6
SHOT_W, SHOT_H = round(CROP_W * SCALE), round(CROP_H * SCALE)
SIDE_W = 330
ROW_GAP = 16

CSS = f"""
body {{ margin: 0; background: #ffffff; font: 15px/1.4 'Segoe UI', system-ui, sans-serif; color: #1f2328; }}
.board {{ padding: 18px 22px 22px; width: {SIDE_W + SHOT_W + 18 + 2}px; }}
h1 {{ font-size: 20px; margin: 0 0 12px; }}
.row {{ display: flex; gap: 18px; margin-bottom: {ROW_GAP}px; border: 1px solid #d8d6d0; border-radius: 12px; overflow: hidden; background: #faf9f6; }}
.side {{ box-sizing: border-box; width: {SIDE_W}px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }}
.cook {{ display: flex; gap: 8px; align-items: center; }}
.bubble {{ background: #e8eefc; border-radius: 12px; padding: 8px 10px; font-size: 16px; flex: 1; }}
.num {{ font-weight: 700; color: #2f5bd3; margin-right: 6px; }}
.sys {{ font-size: 15px; }}
.sys b {{ color: #1d7f45; }}
.shot {{ width: {SHOT_W}px; height: {SHOT_H}px; overflow: hidden; position: relative; border-left: 1px solid #e3e1dc; }}
.shot img {{ position: absolute; left: {-round(CROP_X * SCALE)}px; top: {-round(CROP_Y * SCALE)}px; width: {round(1280 * SCALE)}px; }}
"""


def row(i, shot, does, responds):
    return f"""<div class="row">
<div class="side"><div class="cook">{COOK}<div class="bubble"><span class="num">{i}</span>{html.escape(does)}</div></div>
<div class="sys"><b>Sous:</b> {html.escape(responds)}</div></div>
<div class="shot"><img src="raw/{shot}.png" alt="Screenshot {shot}"></div>
</div>"""


for key, (title, rows) in BOARDS.items():
    body = "".join(row(n, *r) for n, r in enumerate(rows, 1))
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>{CSS}</style></head><body><div class="board"><h1>{html.escape(title)}</h1>{body}</div></body></html>"""
    with open(os.path.join(HERE, f"storyboard_{key}.html"), "w", encoding="utf-8") as f:
        f.write(page)
    w = SIDE_W + SHOT_W + 18 + 2 + 44
    h = 18 + 40 + len(rows) * (SHOT_H + 2 + ROW_GAP) + 6
    print(f"storyboard_{key}.html  window {w}x{h}")
