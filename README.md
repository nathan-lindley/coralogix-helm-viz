# cx-helm-viz

An otelbin.io-style visualiser for the Coralogix `otel-integration` Helm chart.
Paste or open a `values.yaml`. The tool runs `helm template` against the real chart,
so the graph shows the **effective** collector config after the chart's presets have merged in.

```bash
uv run server.py            # or: python3 server.py   (needs pyyaml + helm on PATH)
# → http://127.0.0.1:8765
```

Options: `--chart ./path/to/otel-integration` renders a local chart checkout. `--port`, `--no-browser` and `-v` also work.

## What you get

- **One tab per collector** (agent DaemonSet, cluster-collector Deployment, gateway, and so on), with error and warning badges.
- **One pan/zoom graph** (like otelbin). Each pipeline is a lane, grouped by signal: receivers → numbered processor chain → exporters. Connectors (`spanmetrics`, `forward/*`) are dashed, with a link from the exporting lane to every receiving lane. Drag to pan, scroll to move, and pinch or ⌘-scroll to zoom. Hovering a component highlights it and its edges in every pipeline.
- **Provenance colouring.** The chart is rendered a second time with every `config:` block removed. Comparing the two renders tags each component as a *chart preset*, *your values* or *overridden*. This makes it obvious when presets add processors (for example `k8sattributes` and `batch`) around the ones you listed.
- **Details drawer**: the merged YAML for the component, which pipelines use it, a docs link and "Show in values.yaml".
- **Problems**: references to undefined components, defined but unused components, connectors wired on only one side, duplicate entries, unknown signal types, undefined or disabled extensions, and ordering hints for `memory_limiter` and `batch`.
- **Rendered config**: the final collector YAML, with copy and download buttons.

## Templated values files

Expressions such as `{{ exec "secret-tool" ... }}` (helmfile or gomplate) are swapped for `TEMPLATED_n` placeholders so the file still parses. The tool lists each substitution. `${var}` and `${env:VAR}` are kept as literal text.

## Layout

```
server.py            stdlib HTTP server (localhost only)
cxviz/templating.py  neutralise non-Helm templating
cxviz/helm.py        chart version lookup, pull + cache (~/.cache/cx-helm-viz), render
cxviz/manifest.py    extract collector configs (ConfigMaps + OpenTelemetryCollector CRs)
cxviz/analyze.py     graph model, provenance, lint
cxviz/service.py     end-to-end pipeline
static/graph.js      single-canvas lane layout, edges, pan/zoom
static/              UI (CodeMirror from cdnjs with SRI; falls back to a textarea offline)
tests/               python3 -m pytest
```
