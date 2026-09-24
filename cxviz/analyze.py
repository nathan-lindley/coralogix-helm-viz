"""Turn a collector config into a graph model with provenance and lint results."""

from typing import Any, Dict, Iterable, List, Optional, Set

import yaml

from .manifest import RenderedCollector

SECTIONS = ("receivers", "processors", "exporters", "connectors", "extensions")
SIGNALS = ("traces", "metrics", "logs", "profiles")

ORIGIN_CHART = "chart"        # comes from chart defaults / presets
ORIGIN_USER = "user"          # only exists because of the values file
ORIGIN_OVERRIDE = "override"  # chart defines it, values file changes it


def _dump(value: Any) -> str:
    if value is None:
        return "# (no settings — component defaults)\n"
    return yaml.safe_dump(value, sort_keys=False, width=10_000, allow_unicode=True)


def _keys(mapping: Any) -> Set[str]:
    return set(mapping.keys()) if isinstance(mapping, dict) else set()


def _user_config(user_values: Dict[str, Any], alias: str) -> Dict[str, Any]:
    section = user_values.get(alias) if isinstance(user_values, dict) else None
    config = section.get("config") if isinstance(section, dict) else None
    return config if isinstance(config, dict) else {}


def _origin(in_user: bool, in_baseline: bool) -> str:
    if in_user and in_baseline:
        return ORIGIN_OVERRIDE
    return ORIGIN_USER if in_user else ORIGIN_CHART


def _pipelines(config: Dict[str, Any]) -> Dict[str, Dict[str, List[str]]]:
    raw = ((config.get("service") or {}).get("pipelines")) or {}
    return {
        pid: {k: list((spec or {}).get(k) or []) for k in ("receivers", "processors", "exporters")}
        for pid, spec in raw.items()
    }


def _usage(pipelines) -> Dict[str, Dict[str, List[str]]]:
    """section -> component id -> pipelines using it."""
    usage: Dict[str, Dict[str, List[str]]] = {s: {} for s in ("receivers", "processors", "exporters")}
    for pid, spec in pipelines.items():
        for section, ids in spec.items():
            for cid in ids:
                usage[section].setdefault(cid, []).append(pid)
    return usage


def _signal(pipeline_id: str) -> str:
    return pipeline_id.split("/", 1)[0]


def _component_table(config, user_cfg, baseline_cfg, usage) -> Dict[str, Dict[str, Any]]:
    table: Dict[str, Dict[str, Any]] = {}
    for section in SECTIONS:
        defined = config.get(section) or {}
        user_ids = _keys(user_cfg.get(section))
        base_ids = _keys(baseline_cfg.get(section))
        entries = {}
        for cid, settings in (defined.items() if isinstance(defined, dict) else []):
            if section == "connectors":
                used_in = sorted(set(usage["receivers"].get(cid, []) + usage["exporters"].get(cid, [])))
            elif section == "extensions":
                used_in = []
            else:
                used_in = usage[section].get(cid, [])
            entries[cid] = {
                "type": cid.split("/", 1)[0],
                "origin": _origin(cid in user_ids, cid in base_ids),
                "yaml": _dump(settings),
                "usedIn": used_in,
            }
        table[section] = entries
    return table


def _pipeline_model(pipelines, user_cfg, baseline_cfg, connectors: Set[str]):
    user_pipes = _pipelines(user_cfg)
    base_pipes = _pipelines(baseline_cfg)
    model = []
    for pid, spec in pipelines.items():
        user_spec = user_pipes.get(pid, {})
        item_lists = {}
        for kind, ids in spec.items():
            listed = set(user_spec.get(kind, []))
            item_lists[kind] = [
                {"id": cid,
                 "origin": ORIGIN_USER if cid in listed else ORIGIN_CHART,
                 "connector": cid in connectors and kind != "processors"}
                for cid in ids
            ]
        model.append({
            "id": pid,
            "signal": _signal(pid),
            "origin": _origin(pid in user_pipes, pid in base_pipes),
            **item_lists,
        })
    return model


def _warn(level: str, message: str, pipeline: Optional[str] = None,
          component: Optional[str] = None) -> Dict[str, Any]:
    return {"level": level, "message": message, "pipeline": pipeline, "component": component}


def _lint_references(pipelines, defined: Dict[str, Set[str]]) -> Iterable[Dict[str, Any]]:
    connectors = defined["connectors"]
    for pid, spec in pipelines.items():
        if _signal(pid) not in SIGNALS:
            yield _warn("error", f"pipeline '{pid}' has unknown signal type '{_signal(pid)}'", pid)
        for kind in ("receivers", "exporters"):
            if not spec[kind]:
                yield _warn("error", f"pipeline '{pid}' has no {kind}", pid)
        for kind, ids in spec.items():
            available = defined[kind] | (connectors if kind != "processors" else set())
            for cid in ids:
                if cid not in available:
                    yield _warn("error", f"pipeline '{pid}' references undefined {kind[:-1]} '{cid}'",
                                pid, cid)
            dupes = sorted({c for c in ids if ids.count(c) > 1})
            for cid in dupes:
                yield _warn("error", f"pipeline '{pid}' lists {kind[:-1]} '{cid}' more than once",
                            pid, cid)


def _lint_unused(pipelines, defined, usage) -> Iterable[Dict[str, Any]]:
    for section in ("receivers", "processors", "exporters"):
        for cid in sorted(defined[section] - set(usage[section])):
            yield _warn("warning", f"{section[:-1]} '{cid}' is defined but not used in any pipeline",
                        component=cid)
    for cid in sorted(defined["connectors"]):
        as_exporter = cid in usage["exporters"]
        as_receiver = cid in usage["receivers"]
        if as_exporter and not as_receiver:
            yield _warn("error", f"connector '{cid}' is used as an exporter but no pipeline receives from it",
                        component=cid)
        elif as_receiver and not as_exporter:
            yield _warn("error", f"connector '{cid}' is used as a receiver but no pipeline exports to it",
                        component=cid)
        elif not as_exporter and not as_receiver:
            yield _warn("warning", f"connector '{cid}' is defined but not used", component=cid)


def _lint_extensions(config, defined) -> Iterable[Dict[str, Any]]:
    enabled = list(((config.get("service") or {}).get("extensions")) or [])
    for ext in enabled:
        if ext not in defined["extensions"]:
            yield _warn("error", f"service.extensions references undefined extension '{ext}'",
                        component=ext)
    for ext in sorted(defined["extensions"] - set(enabled)):
        yield _warn("info", f"extension '{ext}' is defined but not enabled in service.extensions",
                    component=ext)


def _lint_ordering(pipelines) -> Iterable[Dict[str, Any]]:
    for pid, spec in pipelines.items():
        procs = spec["processors"]
        if "memory_limiter" in procs and procs[0] != "memory_limiter":
            yield _warn("warning", f"pipeline '{pid}': memory_limiter should be the first processor",
                        pid, "memory_limiter")
        batches = [i for i, p in enumerate(procs) if p.split("/", 1)[0] == "batch"]
        if batches and batches[-1] != len(procs) - 1:
            yield _warn("info", f"pipeline '{pid}': batch is usually the last processor "
                                f"(followed here by '{procs[-1]}')", pid, procs[batches[-1]])


def lint(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    pipelines = _pipelines(config)
    defined = {s: _keys(config.get(s)) for s in SECTIONS}
    usage = _usage(pipelines)
    order = {"error": 0, "warning": 1, "info": 2}
    findings = [
        *_lint_references(pipelines, defined),
        *_lint_unused(pipelines, defined, usage),
        *_lint_extensions(config, defined),
        *_lint_ordering(pipelines),
    ]
    return sorted(findings, key=lambda f: order[f["level"]])


def build_model(collector: RenderedCollector, user_values: Dict[str, Any],
                baseline: Optional[RenderedCollector]) -> Dict[str, Any]:
    config = collector.config
    user_cfg = _user_config(user_values, collector.alias)
    baseline_cfg = baseline.config if baseline else {}
    pipelines = _pipelines(config)
    usage = _usage(pipelines)
    components = _component_table(config, user_cfg, baseline_cfg, usage)
    enabled_ext = list(((config.get("service") or {}).get("extensions")) or [])
    for ext_id, entry in components["extensions"].items():
        entry["enabled"] = ext_id in enabled_ext
    return {
        "id": collector.alias,
        "name": collector.name,
        "workload": collector.workload,
        "pipelines": _pipeline_model(pipelines, user_cfg, baseline_cfg, _keys(config.get("connectors"))),
        "components": components,
        "extensions": enabled_ext,
        "warnings": lint(config),
        "relay": collector.relay,
    }
