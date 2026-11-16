"""Local server for the Sous prototype.

    py server.py            # then open http://localhost:8000

Serves the static files. Optionally exposes an LLM interpreter at POST /api/parse that calls the
Claude API, so the browser never holds an API key. The LLM is OFF unless both are true:
  * the `anthropic` package is installed   (py -m pip install -r requirements.txt)
  * credentials are available              (set ANTHROPIC_API_KEY in your own shell; never commit it)
Without them the prototype runs on the rule parser alone.

JavaScript is served with an explicit MIME type because some Windows registries map .js to
text/plain, which makes browsers refuse ES modules.
"""

import http.server
import json
import os
import sys

PORT = int(os.environ.get("PORT", "8000"))
ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get("SOUS_MODEL", "claude-opus-5-5")

TOOLS = ["set_timer", "call_contact", "play_music", "add_to_list"]
CONTACTS = ["mom", "dad", "alex", "sam"]
GENRES = ["jazz", "pop", "classical", "lofi"]

SYSTEM_PROMPT = f"""You interpret one noisy speech-recognition transcript for a kitchen voice assistant.
The user is cooking with busy hands. Words lost to noise appear as [noise] or [crash], and words may be
clipped ("imer" may be "timer"). The user may begin with a correction such as "no, wait"; ignore it and
interpret only what they want done now.

Available actions:
- set_timer: needs minutes (whole number)
- call_contact: needs name, one of {", ".join(CONTACTS)}
- play_music: optional genre, one of {", ".join(GENRES)}
- add_to_list: needs item (a grocery item)

Return the single most likely action as `tool`, or "none" if the transcript does not support one.
Fill only arguments the transcript actually supports; use 0, "none" or "" for anything not said.
Do not guess a contact name or a number that is not in the transcript.
`confidence` is your probability (0 to 1) that `tool` is what the user meant.
`alternatives` lists up to two other plausible actions, most likely first."""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "tool": {"type": "string", "enum": TOOLS + ["none"]},
        "minutes": {"type": "integer"},
        "name": {"type": "string", "enum": CONTACTS + ["none"]},
        "genre": {"type": "string", "enum": GENRES + ["none"]},
        "item": {"type": "string"},
        "confidence": {"type": "number"},
        "alternatives": {"type": "array", "items": {"type": "string", "enum": TOOLS}},
    },
    "required": ["tool", "minutes", "name", "genre", "item", "confidence", "alternatives"],
    "additionalProperties": False,
}

try:
    import anthropic  # optional dependency
except ImportError:  # pragma: no cover - depends on the reviewer's machine
    anthropic = None


def llm_enabled():
    if anthropic is None:
        return False, "anthropic package not installed"
    if os.environ.get("SOUS_LLM", "").lower() == "off":
        return False, "disabled by SOUS_LLM=off"
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("SOUS_LLM") == "on"):
        return False, "no ANTHROPIC_API_KEY in the environment"
    return True, "ok"


_client = None


def interpret(text, context):
    """Call the model and convert its JSON into a tool proposal. Raises on API errors."""
    global _client
    _client = _client or anthropic.Anthropic(timeout=8.0, max_retries=1)
    prompt = json.dumps({"transcript": text, "assistant_state": context.get("state"),
                         "action_being_corrected": context.get("lastAction")})
    response = _client.beta.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if response.stop_reason == "refusal":
        return None, "refusal"
    raw = next((b.text for b in response.content if b.type == "text"), "")
    data = json.loads(raw)
    tool = data.get("tool")
    args = {}
    if tool == "set_timer" and data.get("minutes", 0) > 0:
        args["minutes"] = data["minutes"]
    if tool == "call_contact" and data.get("name") in CONTACTS:
        args["name"] = data["name"]
    if tool == "play_music" and data.get("genre") in GENRES:
        args["genre"] = data["genre"]
    if tool == "add_to_list" and data.get("item"):
        args["item"] = data["item"].strip().lower()
    proposal = {
        "tool": tool if tool in TOOLS else None,
        "args": args,
        "confidence": max(0.0, min(1.0, float(data.get("confidence", 0.5)))),
        "alternatives": [t for t in data.get("alternatives", []) if t in TOOLS and t != tool][:2],
    }
    return proposal, "ok"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always serve the latest edit
        super().end_headers()

    def send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/llm/status":
            ok, reason = llm_enabled()
            return self.send_json(200, {"enabled": ok, "reason": reason, "model": MODEL if ok else None})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/parse":
            return self.send_json(404, {"error": "not found"})
        ok, reason = llm_enabled()
        if not ok:
            return self.send_json(503, {"error": reason})
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 10_000)
            req = json.loads(self.rfile.read(length) or b"{}")
            text = str(req.get("text", ""))[:500]
            proposal, why = interpret(text, req.get("context") or {})
            return self.send_json(200, {"proposal": proposal, "status": why, "model": MODEL})
        except Exception as e:  # report, never crash the demo; the browser falls back to rules
            sys.stderr.write(f"/api/parse failed: {type(e).__name__}: {e}\n")
            return self.send_json(502, {"error": type(e).__name__})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    ok, reason = llm_enabled()
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Sous prototype on http://localhost:{PORT}  (tests: /tests.html)")
        print(f"LLM interpreter: {'ON (' + MODEL + ')' if ok else 'off - ' + reason}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
