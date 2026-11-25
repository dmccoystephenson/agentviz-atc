"""Serves the fixture feed next to web/ and checks the page, its assets and
the feed. Run: python3 -m unittest discover -s tests"""
import json
import os
import socket
import subprocess
import sys
import time
import unittest
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ATC_TEST_PORT", "8944"))
BASE = "http://127.0.0.1:%d" % PORT
ASSETS = ["/", "/index.html", "/atc.js", "/atc-engine.js", "/atc-engine.wasm", "/strata-kit.js", "/strata-loader.js"]


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()


class ServeFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.Popen(
            [sys.executable, "-m", "vendor.agentfeed", "serve", "--web", "web", "--port", str(PORT), "--fixture"],
            cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)

    def test_page_and_assets(self):
        for path in ASSETS:
            status, ctype, body = get(path)
            self.assertEqual(status, 200, path)
            self.assertTrue(body, path)
        self.assertIn("application/wasm", get("/atc-engine.wasm")[1])
        page = get("/")[2].decode()
        for script in ("strata-loader.js", "strata-kit.js", "atc.js"):
            self.assertIn(script, page)

    def test_page_uses_engine_exports(self):
        js = get("/atc.js")[2].decode()
        engine = get("/atc-engine.js")[2].decode()
        for name in ("_atc_set_airports", "_atc_update_airports", "_atc_set_planes", "_atc_set_lines",
                     "_atc_set_waiting", "_atc_set_time"):
            self.assertIn(name, js)
            self.assertIn(name.lstrip("_"), engine)

    def test_feed_parses(self):
        status, ctype, body = get("/api/agents")
        self.assertEqual(status, 200)
        doc = json.loads(body)
        self.assertEqual(doc["version"], 1)
        self.assertTrue(doc["fixture"])
        states = {s["state"] for s in doc["sessions"]}
        self.assertTrue({"busy", "idle", "waiting", "offline"} <= states)
        self.assertTrue(any(s["followers"] for s in doc["sessions"]))
        self.assertEqual(json.loads(get("/api/agents?fixture=1")[2])["fixture"], True)

    def test_outside_web_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            get("/../vendor/agentfeed/feed.py")
        self.assertEqual(e.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
