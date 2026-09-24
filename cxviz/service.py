"""End-to-end: values text -> neutralise -> helm render x2 -> graph model."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import yaml

from . import helm
from .analyze import build_model
from .manifest import extract_collectors, strip_config_overrides
from .templating import neutralise

MAX_VALUES_BYTES = 2 * 1024 * 1024


class InputError(ValueError):
    """The supplied values file is unusable; message is shown to the user."""


def _parse_values(text: str) -> Dict[str, Any]:
    try:
        values = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark else ""
        problem = getattr(exc, "problem", None) or str(exc)
        raise InputError(f"values file is not valid YAML{where}: {problem}") from exc
    if values is None:
        return {}
    if not isinstance(values, dict):
        raise InputError("values file must be a YAML mapping at the top level")
    return values


def analyse(values_text: str, chart_path: Path,
            renderer: Callable[[Path, str], str] = helm.render) -> Dict[str, Any]:
    if len(values_text.encode()) > MAX_VALUES_BYTES:
        raise InputError("values file is larger than 2 MiB")
    prepared = neutralise(values_text)
    values = _parse_values(prepared.text)
    baseline_text = yaml.safe_dump(strip_config_overrides(values), sort_keys=False)

    with ThreadPoolExecutor(max_workers=2) as pool:
        real = pool.submit(renderer, chart_path, prepared.text)
        base = pool.submit(renderer, chart_path, baseline_text)
        manifest = real.result()
        try:
            baseline_manifest: Optional[str] = base.result()
        except helm.HelmError:
            baseline_manifest = None  # provenance degrades to "user vs unknown"

    baseline_by_alias = {
        c.alias: c for c in (extract_collectors(baseline_manifest) if baseline_manifest else [])
    }
    collectors = [
        build_model(c, values, baseline_by_alias.get(c.alias))
        for c in extract_collectors(manifest)
    ]
    return {
        "collectors": collectors,
        "placeholders": [p.__dict__ for p in prepared.placeholders],
        "variables": prepared.variables,
        "provenance": baseline_manifest is not None,
    }
