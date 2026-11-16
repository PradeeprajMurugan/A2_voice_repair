"""Compose storyboard panels: the cook's action (sketch + words) above a real screenshot of the prototype.

    py docs/storyboards/build_storyboards.py        # writes docs/storyboards/storyboard_*.html

Screenshots in raw/ are captured from the running app with headless Chrome (?play=N, virtual time);
see the README. Render each HTML to PNG with the same headless Chrome (--screenshot).
"""
import html
import os

HERE = os.path.dirname(os.path.abspath(__file__))

BOARDS = {
    "A": ("Storyboard A — a clean interruption", [
        ("A1", "Hands in dough: “Set a ten-minute timer.”", "Heard “call mom”. Announces the call; 3 s before it connects."),
        ("A2", "Cuts in: “No, wait, stop! A ten-minute timer.”", "Stops talking, cancels the call, sets the timer, says both in one line."),
        ("A3", "Back to kneading.", "Timer runs on screen; the call never connected."),
    ]),
    "B": ("Storyboard B — a correction lost to noise", [
        ("B1", "“No, wait—” [pan crashes] “…imer.”", "Cancels the call anyway; offers its best guess: a timer?"),
        ("B2", "“Yes.”", "Asks for the one missing detail, with buttons."),
        ("B3", "“Ten.”", "Timer set. No silent failure, no restart."),
    ]),
    "C": ("Storyboard C — confirm before an irreversible action", [
        ("C1", "Muffled: “Set a timer for five minutes.”", "Heard “call mom” at 0.70: a call cannot be undone, so it asks."),
        ("C2", "“No, set a timer for five minutes.”", "Takes the no and the real request in one turn. Nothing was dialled."),
    ]),
}

# Simple cook sketch: head, body, arms reaching to a bowl. Colours are fixed (rendered to PNG).
COOK = """<svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
<circle cx="34" cy="22" r="12" fill="none" stroke="#3d3d3d" stroke-width="2.5"/>
<path d="M34 34 L34 66 M34 66 L24 90 M34 66 L44 90 M34 44 L58 58 M34 44 L54 66" fill="none" stroke="#3d3d3d" stroke-width="2.5" stroke-linecap="round"/>
<path d="M50 62 Q66 82 84 62 Z" fill="#e9dcc6" stroke="#3d3d3d" stroke-width="2"/>
</svg>"""

CROP_X, CROP_Y, CROP_W, CROP_H = 20, 75, 865, 480
PANEL_W = 470
SCALE = PANEL_W / CROP_W

CSS = f"""
body {{ margin: 0; background: #ffffff; font: 15px/1.4 'Segoe UI', system-ui, sans-serif; color: #1f2328; }}
.board {{ padding: 20px 24px 24px; display: inline-block; }}
h1 {{ font-size: 20px; margin: 0 0 14px; }}
.row {{ display: flex; gap: 18px; align-items: stretch; }}
.panel {{ width: {PANEL_W}px; border: 1px solid #d8d6d0; border-radius: 10px; overflow: hidden; background: #faf9f6; }}
.num {{ font-weight: 700; color: #2f5bd3; margin-right: 6px; }}
.cook {{ display: flex; gap: 10px; align-items: center; padding: 10px 12px; min-height: 96px; }}
.bubble {{ background: #e8eefc; border-radius: 12px; padding: 10px 12px; font-size: 16px; flex: 1; }}
.label {{ font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #6b6f76; margin: 0 12px 4px; }}
.shot {{ width: {PANEL_W}px; height: {round(CROP_H * SCALE)}px; overflow: hidden; position: relative; border-top: 1px solid #e3e1dc; border-bottom: 1px solid #e3e1dc; }}
.shot img {{ position: absolute; left: {-round(CROP_X * SCALE)}px; top: {-round(CROP_Y * SCALE)}px; width: {round(1280 * SCALE)}px; }}
.sys {{ padding: 10px 12px; font-size: 15px; }}
.sys b {{ color: #1d7f45; }}
.arrow {{ align-self: center; font-size: 28px; color: #8a8f98; }}
"""


def panel(i, shot, does, responds):
    return f"""<div class="panel">
<div class="cook">{COOK}<div class="bubble"><span class="num">{i}</span>{html.escape(does)}</div></div>
<div class="label">Prototype screen</div>
<div class="shot"><img src="raw/{shot}.png" alt="Screenshot {shot}"></div>
<div class="sys"><b>Sous:</b> {html.escape(responds)}</div>
</div>"""


for key, (title, panels) in BOARDS.items():
    parts = []
    for n, (shot, does, responds) in enumerate(panels, 1):
        if n > 1:
            parts.append('<div class="arrow">→</div>')
        parts.append(panel(n, shot, does, responds))
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>{CSS}</style></head><body><div class="board"><h1>{html.escape(title)}</h1><div class="row">{''.join(parts)}</div></div></body></html>"""
    with open(os.path.join(HERE, f"storyboard_{key}.html"), "w", encoding="utf-8") as f:
        f.write(page)
    print("wrote", f"storyboard_{key}.html")
