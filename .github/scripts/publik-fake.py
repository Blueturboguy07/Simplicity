# CI only (see .github/workflows/clean-mac-check.yml). Not part of the app.
#
# A fake publik on the runner, for the gate of the BUILT app. Nothing here talks to publikhq.com.
#   POST /api/v1/installs  -> 201 {key, install_id, claim_url, claim_state}
#   GET  /api/v1/wallet    -> 200 {claim_state: <arg>, plan, balance_micros, ...}
#   POST /api/v1/telemetry -> 204
#   POST /ready            -> 204 (the shell waits for it)
# Every request is one JSON line in the log: {method, url, authorization: present|absent, body}.
#
# usage: python3 publik-fake.py <port> <log.jsonl> <claim_state: claimed|anonymous>
import http.server, json, sys

PORT, LOG, CLAIM = int(sys.argv[1]), sys.argv[2], sys.argv[3]
KEY = "pk_live_cleanrunner0000_00000000000000000000000000000000"  # a fake key for this fake publik


class H(http.server.BaseHTTPRequestHandler):
    def _log(self, body):
        with open(LOG, "a") as h:
            h.write(json.dumps({"method": self.command, "url": self.path, "authorization": "present" if self.headers.get("authorization") else "absent", "body": body}) + "\n")

    def _json(self, status, data):
        out = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace")
        if self.path == "/ready":
            self.send_response(204); self.end_headers(); return
        self._log(body)
        if self.path == "/api/v1/installs":
            try: install_id = json.loads(body).get("install_id", "")
            except Exception: install_id = ""
            return self._json(201, {"key": KEY, "install_id": install_id, "claim_url": f"http://127.0.0.1:{PORT}/claim/x", "claim_state": CLAIM})
        if self.path == "/api/v1/telemetry":
            self.send_response(204); self.end_headers(); return
        self._json(404, {})

    def do_GET(self):
        self._log("")
        if self.path == "/api/v1/wallet":
            if CLAIM == "claimed":
                return self._json(200, {"claim_state": "claimed", "claim_url": None, "account": {"handle": "cleanrunner"}, "plan": {"kind": "plan", "label": "Clean runner"}, "balance_micros": 0, "top_up_url": "", "linked_at": None})
            return self._json(200, {"claim_state": "anonymous", "claim_url": f"http://127.0.0.1:{PORT}/claim/x", "account": None, "plan": {"kind": "none", "label": None}, "balance_micros": 0, "top_up_url": "", "linked_at": None})
        self._json(404, {})

    def log_message(self, *a): pass


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
