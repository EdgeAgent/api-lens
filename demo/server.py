#!/usr/bin/env python3
"""API Lens demo server — serves demo.html plus a tiny fake JSON API.

Run:  python3 server.py   →   http://localhost:8077/
Then load the API Lens extension, press Record on the demo tab, and click
the demo buttons. Watch the calls group into endpoints in the workbench.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))

USERS = {
    42: {"id": 42, "name": "Kevin Doherty", "role": "admin", "active": True, "score": 9.5},
    7: {"id": 7, "name": "Ana Silva", "role": "member", "active": False, "score": 7},
}


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"null")
        except Exception:
            return None

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        parts = [p for p in u.path.split("/") if p]
        if u.path == "/" or u.path == "/demo.html":
            path = os.path.join(HERE, "demo.html")
            with open(path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif len(parts) == 3 and parts[0] == "api" and parts[1] == "users" and parts[2].isdigit():
            user = USERS.get(int(parts[2]))
            if user is None:
                self._json({"error": "user not found"}, 404)
            elif q.get("full") == "true":
                self._json({**user, "email": f"user{user['id']}@example.com", "tags": ["beta", "early"]})
            else:
                self._json(user)
        elif u.path == "/api/search":
            self._json({
                "query": q.get("q", ""),
                "page": int(q.get("page", "1")),
                "results": [{"id": 1, "title": "Lens", "price": 19.99}, {"id": 2, "title": "Tripod", "price": 49.5}],
                "total": 2,
            })
        else:
            self._json({"error": "not found", "path": u.path}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        body = self._body()
        if u.path == "/api/orders":
            self._json({"orderId": 1001, "status": "created", "item": (body or {}).get("item"),
                        "qty": (body or {}).get("qty"), "total": 39.98}, 201)
        elif u.path == "/api/login":
            # Demo credentials on purpose: watch API Lens redact them in exports.
            if (body or {}).get("password"):
                self._json({"tokenType": "Bearer", "expiresIn": 3600, "user": (body or {}).get("user")})
            else:
                self._json({"error": "password required"}, 400)
        else:
            self._json({"error": "not found", "path": u.path}, 404)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("API Lens demo → http://localhost:8077/")
    HTTPServer(("127.0.0.1", 8077), Handler).serve_forever()
