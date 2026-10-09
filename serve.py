"""Local dev server with caching disabled, so edited JS modules are always reloaded.

Usage (from the repo root):  python serve.py   → http://localhost:8000
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving on http://localhost:{port}  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
