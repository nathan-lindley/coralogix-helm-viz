from cxviz.manifest import extract_collectors

MANIFEST = """
apiVersion: v1
kind: ConfigMap
metadata:
  name: coralogix-opentelemetry-agent
  labels: {app.kubernetes.io/name: opentelemetry-agent}
data:
  relay: |
    receivers: {otlp: {}}
    service: {pipelines: {traces: {receivers: [otlp], exporters: [debug]}}}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: unrelated}
data: {foo: bar}
---
apiVersion: apps/v1
kind: DaemonSet
metadata: {name: coralogix-opentelemetry-agent}
spec:
  template:
    spec:
      volumes:
        - name: cfg
          configMap: {name: coralogix-opentelemetry-agent}
---
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: gw
  labels: {app.kubernetes.io/name: opentelemetry-gateway}
spec:
  mode: statefulset
  config:
    receivers: {otlp: {}}
"""


def test_extracts_configmap_and_operator_collectors():
    found = {c.alias: c for c in extract_collectors(MANIFEST)}
    assert set(found) == {"opentelemetry-agent", "opentelemetry-gateway"}
    assert found["opentelemetry-agent"].workload == "DaemonSet"
    assert found["opentelemetry-agent"].config["receivers"] == {"otlp": {}}
    assert found["opentelemetry-gateway"].workload == "OpenTelemetryCollector (statefulset)"
