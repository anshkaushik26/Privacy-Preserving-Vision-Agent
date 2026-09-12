"""Trivial static file server for the mock demo site.

Run with: python3 serve.py [port]
Serves demo-site/ at http://localhost:<port>/ (default 8000).
"""
import http.server
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))

handler = http.server.SimpleHTTPRequestHandler
with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
    print(f"Demo site running at http://127.0.0.1:{PORT}/")
    httpd.serve_forever()
