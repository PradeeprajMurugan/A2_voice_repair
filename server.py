"""Local server for the Sous prototype (Python standard library only).

    py server.py            # then open http://localhost:8000

Serves the static files. JavaScript is served with an explicit MIME type because some Windows
registries map .js to text/plain, which makes browsers refuse ES modules.
"""

import http.server
import os
import sys

PORT = int(os.environ.get("PORT", "8000"))
ROOT = os.path.dirname(os.path.abspath(__file__))


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

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Sous prototype on http://localhost:{PORT}  (tests: /tests.html)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
