#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = ["pyyaml>=6"]
# ///
"""Local otelbin-style visualiser for the Coralogix otel-integration Helm chart.

    uv run server.py                 # http://127.0.0.1:8765
    uv run server.py --chart ./otel-integration   # use a local chart checkout
"""

import argparse
import json
import logging
import sys
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from cxviz import helm  # noqa: E402
from cxviz.service import InputError, analyse  # noqa: E402

STATIC_DIR = ROOT / "static"
MAX_BODY_BYTES = 4 * 1024 * 1024

log = logging.getLogger("cx-helm-viz")


class Handler(SimpleHTTPRequestHandler):
    local_chart: Optional[Path] = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt, *args):  # route through logging, quieter
        log.debug(fmt, *args)

    def _json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/versions":
            if self.local_chart:
                return self._json(200, {"versions": ["local"], "local": str(self.local_chart)})
            return self._json(200, {"versions": helm.list_versions()})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/render":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return self._json(413, {"error": "request too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            values = body.get("values", "")
            version = str(body.get("version") or "")
            if not isinstance(values, str):
                raise InputError("'values' must be a string")
            chart = self.local_chart or helm.ensure_chart(version or _latest())
            return self._json(200, analyse(values, chart))
        except (InputError, json.JSONDecodeError) as exc:
            return self._json(400, {"error": str(exc), "kind": "input"})
        except helm.HelmError as exc:
            return self._json(422, {"error": str(exc), "kind": "helm"})
        except Exception:  # keep the server alive; details go to the log only
            log.exception("render failed")
            return self._json(500, {"error": "internal error — see server log", "kind": "internal"})


def _latest() -> str:
    versions = helm.list_versions(limit=1)
    if not versions:
        raise helm.HelmError("could not determine the latest otel-integration chart version")
    return versions[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: localhost only)")
    parser.add_argument("--chart", type=Path, help="path to a local otel-integration chart directory")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s")

    if args.chart:
        if not (args.chart / "Chart.yaml").exists():
            parser.error(f"{args.chart} has no Chart.yaml")
        Handler.local_chart = args.chart.resolve()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    log.info("cx-helm-viz listening on %s", url)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
