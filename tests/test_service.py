import pytest
from pathlib import Path
from cxviz.service import InputError, analyse

AGENT = """
apiVersion: v1
kind: ConfigMap
metadata:
  name: agent
  labels: {app.kubernetes.io/name: opentelemetry-agent}
data:
  relay: |
    receivers: {otlp: {}, filelog: {}}
    exporters: {coralogix: {}}
    service:
      pipelines:
        logs: {receivers: [filelog], exporters: [coralogix]}
        traces: {receivers: [otlp], exporters: [coralogix]}
"""
BASE = AGENT.replace("filelog: {}", "").replace("logs: {receivers: [filelog], exporters: [coralogix]}", "")


def fake_renderer(chart, values_text):
    return AGENT if "filelog" in values_text else BASE


def test_analyse_end_to_end_with_fake_helm():
    values = ("arn: {{ exec \"x\" }}\n"
              "opentelemetry-agent:\n  config:\n    receivers:\n      filelog: {}\n")
    out = analyse(values, Path("."), renderer=fake_renderer)
    agent = out["collectors"][0]
    assert agent["components"]["receivers"]["filelog"]["origin"] == "user"
    assert agent["components"]["receivers"]["otlp"]["origin"] == "chart"
    assert out["placeholders"][0]["replacement"] == "TEMPLATED_0"
    assert out["provenance"] is True


def test_invalid_yaml_reports_line():
    with pytest.raises(InputError, match=r"line 3, column 1"):
        analyse("a: 1\nb: [\n", Path("."), renderer=fake_renderer)


def test_non_mapping_rejected():
    with pytest.raises(InputError, match="mapping"):
        analyse("- a\n", Path("."), renderer=fake_renderer)


def test_chart_default_pipelines_reads_order(tmp_path):
    from cxviz.service import chart_default_pipelines
    (tmp_path / "values.yaml").write_text(
        "opentelemetry-agent:\n  config:\n    service:\n      pipelines:\n"
        "        metrics: {}\n        traces: {}\n        logs: {}\nglobal: {domain: x}\n")
    assert chart_default_pipelines(tmp_path) == {"opentelemetry-agent": ["metrics", "traces", "logs"]}
    assert chart_default_pipelines(tmp_path / "missing") == {}
