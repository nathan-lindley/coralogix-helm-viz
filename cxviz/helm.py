"""Thin wrapper around the helm CLI: resolve chart versions, pull, render."""

import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import List, Optional

REPO_URL = "https://cgx.jfrog.io/artifactory/coralogix-charts-virtual"
CHART_NAME = "otel-integration"
CACHE_DIR = Path(os.environ.get("CX_HELM_VIZ_CACHE", Path.home() / ".cache" / "cx-helm-viz"))
RENDER_TIMEOUT_S = 60
PULL_TIMEOUT_S = 120

_pull_lock = threading.Lock()


class HelmError(RuntimeError):
    """helm exited non-zero; message is helm's stderr, safe to show the user."""


def helm_binary() -> str:
    path = os.environ.get("HELM_BIN") or shutil.which("helm")
    if not path:
        raise HelmError("helm not found on PATH (set HELM_BIN to override)")
    return path


def _run(args: List[str], timeout: int) -> str:
    try:
        proc = subprocess.run(
            [helm_binary(), *args], capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired as exc:
        raise HelmError(f"helm {args[0]} timed out after {timeout}s") from exc
    if proc.returncode != 0:
        raise HelmError(proc.stderr.strip() or f"helm {args[0]} failed")
    return proc.stdout


def list_versions(limit: int = 40) -> List[str]:
    """Chart versions, newest first. Falls back to just 'latest' if unavailable."""
    try:
        out = _run(
            ["search", "repo", f"coralogix/{CHART_NAME}", "--versions", "-o", "json"], 30
        )
        versions = [row["version"] for row in json.loads(out)]
        if versions:
            return versions[:limit]
    except (HelmError, ValueError, KeyError):
        pass
    try:
        chart = _run(["show", "chart", CHART_NAME, "--repo", REPO_URL], 30)
        for line in chart.splitlines():
            if line.startswith("version:"):
                return [line.split(":", 1)[1].strip()]
    except HelmError:
        pass
    return []


def _valid_version(version: str) -> bool:
    return bool(version) and all(c.isalnum() or c in ".-+" for c in version)


def ensure_chart(version: str) -> Path:
    """Return a local path to the untarred chart, pulling it on first use."""
    if not _valid_version(version):
        raise HelmError(f"invalid chart version: {version!r}")
    target = CACHE_DIR / "charts" / version / CHART_NAME
    if (target / "Chart.yaml").exists():
        return target
    with _pull_lock:
        if (target / "Chart.yaml").exists():
            return target
        staging = Path(tempfile.mkdtemp(prefix="pull-", dir=_ensure_dir(CACHE_DIR)))
        try:
            _run(
                ["pull", CHART_NAME, "--repo", REPO_URL, "--version", version,
                 "--untar", "-d", str(staging)],
                PULL_TIMEOUT_S,
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging / CHART_NAME, target)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    return target


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def render(chart_path: Path, values_yaml: str, release: str = "coralogix",
           namespace: Optional[str] = None) -> str:
    """Run `helm template` and return the multi-document manifest."""
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as fh:
        fh.write(values_yaml)
        values_file = fh.name
    try:
        args = ["template", release, str(chart_path), "-f", values_file]
        if namespace:
            args += ["--namespace", namespace]
        return _run(args, RENDER_TIMEOUT_S)
    finally:
        os.unlink(values_file)
