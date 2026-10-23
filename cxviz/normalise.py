"""Reshape a values file into what the otel-integration chart expects.

Two common shapes don't render as-is:

* Umbrella-chart values, where everything sits under an ``otel-integration:``
  key. We render the chart directly, so that key would be silently ignored.
* Values without ``global.domain`` / ``global.clusterName``. The chart refuses
  to render without them, but in a real cluster they're often supplied
  elsewhere; for visualising, a placeholder is good enough.
"""

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

UMBRELLA_KEY = "otel-integration"
GLOBAL_PLACEHOLDERS = {"domain": "DOMAIN_UNSET", "clusterName": "CLUSTER_UNSET"}


@dataclass(frozen=True)
class Normalised:
    values: Dict[str, Any]
    unwrapped: Optional[Dict[str, Any]] = None   # {"key": ..., "dropped": [...]}
    filled_globals: List[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return self.unwrapped is not None or bool(self.filled_globals)


def _unwrap(values: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    inner = values.get(UMBRELLA_KEY)
    if not isinstance(inner, dict):
        return None
    out = copy.deepcopy(inner)
    outer_global = values.get("global")
    if isinstance(outer_global, dict):
        # Helm copies the parent's globals over the subchart's own.
        out["global"] = {**(out.get("global") or {}), **copy.deepcopy(outer_global)}
    return out


def normalise_values(values: Dict[str, Any]) -> Normalised:
    unwrapped_values = _unwrap(values)
    unwrapped = None
    if unwrapped_values is not None:
        dropped = [k for k in values if k not in (UMBRELLA_KEY, "global")]
        unwrapped = {"key": UMBRELLA_KEY, "dropped": dropped}
    base = unwrapped_values if unwrapped_values is not None else values

    current_global = base.get("global") if isinstance(base.get("global"), dict) else {}
    missing = [k for k in GLOBAL_PLACEHOLDERS if not current_global.get(k)]
    if not missing and unwrapped is None:
        return Normalised(values)

    filled = {**current_global, **{k: GLOBAL_PLACEHOLDERS[k] for k in missing}}
    return Normalised({**base, "global": filled}, unwrapped, missing)
