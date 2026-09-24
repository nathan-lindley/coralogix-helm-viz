from cxviz.analyze import build_model, lint
from cxviz.manifest import RenderedCollector, strip_config_overrides


def cfg(**over):
    base = {
        "receivers": {"otlp": {}, "filelog": {"include": ["/x"]}},
        "processors": {"memory_limiter": {}, "batch": {}},
        "exporters": {"coralogix": {}},
        "connectors": {},
        "extensions": {"health_check": {}},
        "service": {
            "extensions": ["health_check"],
            "pipelines": {
                "logs": {"receivers": ["filelog"], "processors": ["memory_limiter", "batch"],
                         "exporters": ["coralogix"]},
                "traces": {"receivers": ["otlp"], "processors": ["memory_limiter", "batch"],
                           "exporters": ["coralogix"]},
            },
        },
    }
    base.update(over)
    return base


def messages(findings, level=None):
    return [f["message"] for f in findings if level is None or f["level"] == level]


def test_clean_config_has_no_findings():
    assert lint(cfg()) == []


def test_undefined_reference_is_error():
    c = cfg()
    c["service"]["pipelines"]["logs"]["processors"].insert(1, "filter/nope")
    assert any("undefined processor 'filter/nope'" in m for m in messages(lint(c), "error"))


def test_unused_component_is_warning():
    c = cfg(receivers={"otlp": {}, "filelog": {}, "prometheus/extra": {}})
    assert messages(lint(c), "warning") == [
        "receiver 'prometheus/extra' is defined but not used in any pipeline"]


def test_connector_half_wired_is_error():
    c = cfg(connectors={"spanmetrics": {}})
    c["service"]["pipelines"]["traces"]["exporters"].append("spanmetrics")
    assert any("no pipeline receives from it" in m for m in messages(lint(c), "error"))
    c["service"]["pipelines"]["metrics"] = {
        "receivers": ["spanmetrics"], "processors": [], "exporters": ["coralogix"]}
    assert not any("spanmetrics" in m for m in messages(lint(c), "error"))


def test_ordering_hints():
    c = cfg()
    c["service"]["pipelines"]["logs"]["processors"] = ["batch", "memory_limiter"]
    found = lint(c)
    assert any("memory_limiter should be the first" in m for m in messages(found, "warning"))
    assert any("batch is usually the last" in m for m in messages(found, "info"))


def test_extension_checks():
    c = cfg(extensions={"health_check": {}, "pprof": {}})
    c["service"]["extensions"] = ["health_check", "zpages"]
    found = lint(c)
    assert "service.extensions references undefined extension 'zpages'" in messages(found, "error")
    assert any("'pprof' is defined but not enabled" in m for m in messages(found, "info"))


def test_missing_receivers_and_bad_signal():
    c = cfg()
    c["service"]["pipelines"]["bogus/x"] = {"receivers": [], "processors": [], "exporters": ["coralogix"]}
    errs = messages(lint(c), "error")
    assert "pipeline 'bogus/x' has unknown signal type 'bogus'" in errs
    assert "pipeline 'bogus/x' has no receivers" in errs


def test_provenance_chart_user_override():
    rendered = cfg(processors={"memory_limiter": {}, "batch": {}, "filter/mine": {}})
    rendered["service"]["pipelines"]["logs"]["processors"] = ["memory_limiter", "filter/mine", "batch"]
    baseline = cfg()
    user_values = {"opentelemetry-agent": {"config": {
        "processors": {"filter/mine": {}, "batch": {"timeout": "1s"}},
        "service": {"pipelines": {"logs": {"processors": ["filter/mine"]}}},
    }}}
    model = build_model(
        RenderedCollector("opentelemetry-agent", "agent", "DaemonSet", rendered, ""),
        user_values,
        RenderedCollector("opentelemetry-agent", "agent", "DaemonSet", baseline, ""),
    )
    procs = model["components"]["processors"]
    assert procs["filter/mine"]["origin"] == "user"
    assert procs["batch"]["origin"] == "override"
    assert procs["memory_limiter"]["origin"] == "chart"
    logs = next(p for p in model["pipelines"] if p["id"] == "logs")
    assert [(p["id"], p["origin"]) for p in logs["processors"]] == [
        ("memory_limiter", "chart"), ("filter/mine", "user"), ("batch", "chart")]
    assert logs["origin"] == "override"
    assert procs["filter/mine"]["usedIn"] == ["logs"]


def test_strip_config_overrides_keeps_presets_and_does_not_mutate():
    values = {"global": {"domain": "x"},
              "opentelemetry-agent": {"presets": {"a": 1}, "config": {"receivers": {}}}}
    out = strip_config_overrides(values)
    assert out == {"global": {"domain": "x"}, "opentelemetry-agent": {"presets": {"a": 1}}}
    assert "config" in values["opentelemetry-agent"]


def test_pipeline_order_follows_chart_defaults_then_user_then_rendered():
    rendered = cfg()
    rendered["service"]["pipelines"] = {
        name: {"receivers": ["otlp"], "processors": [], "exporters": ["coralogix"]}
        for name in ["logs", "metrics", "profiles", "traces", "traces/lvt", "traces/db"]
    }
    chart_pipelines = ["metrics", "traces", "logs"]
    user_values = {"opentelemetry-agent": {"config": {"service": {"pipelines": {
        "traces/lvt": {}, "traces/db": {}, "logs": {}}}}}}
    model = build_model(
        RenderedCollector("opentelemetry-agent", "agent", "DaemonSet", rendered, ""),
        user_values, None, chart_pipelines)
    order = {p["id"]: p["order"] for p in model["pipelines"]}
    assert sorted(order, key=order.get) == [
        "metrics", "traces", "logs", "traces/lvt", "traces/db", "profiles"]
