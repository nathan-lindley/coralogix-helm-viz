"""Pull collector configs out of a rendered otel-integration manifest."""

import copy
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import yaml

WORKLOAD_KINDS = ("DaemonSet", "Deployment", "StatefulSet")


@dataclass(frozen=True)
class RenderedCollector:
    alias: str            # values.yaml key, e.g. "opentelemetry-agent"
    name: str             # k8s resource name
    workload: str         # DaemonSet / Deployment / StatefulSet / CR mode
    config: Dict[str, Any]
    relay: str            # raw collector config text


def parse_documents(manifest: str) -> List[Dict[str, Any]]:
    return [doc for doc in yaml.safe_load_all(manifest) if isinstance(doc, dict)]


def _configmaps_to_workloads(docs: List[Dict[str, Any]]) -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    for doc in docs:
        if doc.get("kind") not in WORKLOAD_KINDS:
            continue
        pod_spec = (doc.get("spec") or {}).get("template", {}).get("spec", {}) or {}
        for volume in pod_spec.get("volumes") or []:
            cm = (volume.get("configMap") or {}).get("name")
            if cm:
                mapping[cm] = doc["kind"]
    return mapping


def _alias(meta: Dict[str, Any]) -> str:
    labels = meta.get("labels") or {}
    return labels.get("app.kubernetes.io/name") or meta.get("name", "collector")


def _from_configmap(doc, workloads) -> Optional[RenderedCollector]:
    relay = (doc.get("data") or {}).get("relay")
    if not relay:
        return None
    meta = doc.get("metadata") or {}
    return RenderedCollector(
        alias=_alias(meta),
        name=meta.get("name", ""),
        workload=workloads.get(meta.get("name", ""), "ConfigMap"),
        config=yaml.safe_load(relay) or {},
        relay=relay,
    )


def _from_operator_cr(doc) -> Optional[RenderedCollector]:
    spec = doc.get("spec") or {}
    raw = spec.get("config")
    if raw is None:
        return None
    if isinstance(raw, str):
        relay, config = raw, yaml.safe_load(raw) or {}
    else:
        config = copy.deepcopy(raw)
        relay = yaml.safe_dump(config, sort_keys=False, width=10_000)
    meta = doc.get("metadata") or {}
    mode = spec.get("mode", "deployment")
    return RenderedCollector(
        alias=_alias(meta),
        name=meta.get("name", ""),
        workload=f"OpenTelemetryCollector ({mode})",
        config=config,
        relay=relay,
    )


def extract_collectors(manifest: str) -> List[RenderedCollector]:
    docs = parse_documents(manifest)
    workloads = _configmaps_to_workloads(docs)
    collectors = []
    for doc in docs:
        kind = doc.get("kind")
        found = None
        if kind == "ConfigMap":
            found = _from_configmap(doc, workloads)
        elif kind == "OpenTelemetryCollector":
            found = _from_operator_cr(doc)
        if found:
            collectors.append(found)
    return collectors


def strip_config_overrides(values: Dict[str, Any]) -> Dict[str, Any]:
    """Values with every collector's `config:` removed, keeping presets.

    Rendering this gives the chart's own contribution, which we diff against
    the real render to tell user-authored components from preset ones.
    """
    baseline = copy.deepcopy(values)
    for section in baseline.values():
        if isinstance(section, dict):
            section.pop("config", None)
    return baseline
