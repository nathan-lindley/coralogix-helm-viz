"use strict";

/* ------------------------------------------------------------------ constants */
const SIGNALS = ["traces", "metrics", "logs", "profiles"];
const SIGNAL_COLOR = { traces: "var(--sig-traces)", metrics: "var(--sig-metrics)", logs: "var(--sig-logs)", profiles: "var(--sig-profiles)" };
const STORAGE_KEY = "cx-helm-viz:values";
const LIVE_DEBOUNCE_MS = 900;
const CORE_COMPONENTS = {
  receivers: ["otlp"], processors: ["batch", "memory_limiter"],
  exporters: ["otlp", "otlphttp", "debug", "nop"], connectors: ["forward"], extensions: ["zpages", "memory_limiter"],
};
const ORIGIN_LABEL = { chart: "chart preset", user: "your values", override: "overridden by your values" };

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};
const singular = (section) => section.replace(/s$/, "");
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

/* ------------------------------------------------------------------ state */
const state = {
  result: null,
  collector: 0,
  view: "graph",
  signalsOff: new Set(),
  selected: null,          // {section, id}
  inflight: null,
  liveTimer: null,
};

/* ------------------------------------------------------------------ editor */
const editor = (() => {
  const textarea = $("#editor");
  if (!window.CodeMirror) {
    return {
      get: () => textarea.value, set: (v) => { textarea.value = v; },
      onChange: (fn) => textarea.addEventListener("input", fn),
      jumpToLine: (line) => {
        const lines = textarea.value.split("\n");
        const start = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
        textarea.focus(); textarea.setSelectionRange(start, start + (lines[line] || "").length);
      },
      lines: () => textarea.value.split("\n"),
    };
  }
  const cm = CodeMirror.fromTextArea(textarea, {
    mode: "yaml", lineNumbers: true, indentUnit: 2, tabSize: 2, lineWrapping: false,
    extraKeys: { Tab: (c) => c.replaceSelection("  "), "Cmd-Enter": () => renderNow(), "Ctrl-Enter": () => renderNow() },
  });
  return {
    get: () => cm.getValue(), set: (v) => cm.setValue(v),
    onChange: (fn) => cm.on("change", fn),
    jumpToLine: (line) => {
      cm.focus();
      cm.setCursor({ line, ch: 0 });
      cm.scrollIntoView({ line, ch: 0 }, 120);
      const mark = cm.markText({ line, ch: 0 }, { line, ch: cm.getLine(line).length }, { className: "cm-flash" });
      setTimeout(() => mark.clear(), 1600);
    },
    lines: () => cm.getValue().split("\n"),
  };
})();

/* ------------------------------------------------------------------ api */
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let payload;
  try { payload = await res.json(); } catch { payload = { error: `HTTP ${res.status}` }; }
  if (!res.ok) throw Object.assign(new Error(payload.error || `HTTP ${res.status}`), { kind: payload.kind });
  return payload;
}

async function loadVersions() {
  const select = $("#version");
  try {
    const { versions, local } = await api("/api/versions");
    select.replaceChildren(...versions.map((v, i) => el("option", { value: v }, local ? `local: ${local}` : (i === 0 ? `${v} (latest)` : v))));
    if (!versions.length) select.append(el("option", { value: "" }, "latest"));
  } catch (err) {
    select.replaceChildren(el("option", { value: "" }, "latest"));
    setStatus(`Could not list chart versions: ${err.message}`, true);
  }
}

function setStatus(text, isError = false) {
  const status = $("#status");
  status.textContent = text;
  status.classList.toggle("error", isError);
}

async function renderNow() {
  clearTimeout(state.liveTimer);
  const values = editor.get();
  storage.set(STORAGE_KEY, values);
  if (!values.trim()) return;
  const token = Symbol("render");
  state.inflight = token;
  setStatus("Rendering…");
  const started = performance.now();
  try {
    const result = await api("/api/render", { values, version: $("#version").value });
    if (state.inflight !== token) return;   // a newer render superseded this one
    state.result = result;
    state.collector = Math.min(state.collector, Math.max(result.collectors.length - 1, 0));
    setStatus(`Rendered in ${Math.round(performance.now() - started)} ms`);
    renderNotices(null);
    renderAll();
  } catch (err) {
    if (state.inflight !== token) return;
    setStatus(err.kind === "helm" ? "helm template failed" : "Render failed", true);
    renderNotices(err);
  }
}

function scheduleLive() {
  if (!$("#auto").checked) return;
  clearTimeout(state.liveTimer);
  state.liveTimer = setTimeout(renderNow, LIVE_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ notices */
function renderNotices(err) {
  const host = $("#notices");
  const items = [];
  if (err) items.push(el("div", { class: "notice error" }, err.message));
  const r = state.result;
  if (r && !err) {
    for (const p of r.placeholders) {
      items.push(el("div", { class: "notice" },
        `Line ${p.line}: template expression replaced with `, el("code", {}, p.replacement), " — ",
        el("code", {}, p.expression.length > 90 ? p.expression.slice(0, 90) + "…" : p.expression)));
    }
    if (r.variables.length) {
      items.push(el("div", { class: "notice" }, "Unresolved variables kept literally: ",
        ...r.variables.flatMap((v, i) => [i ? ", " : "", el("code", {}, "${" + v + "}")])));
    }
    if (!r.provenance) items.push(el("div", { class: "notice" }, "Baseline render failed — chart/user colouring may be incomplete."));
  }
  host.replaceChildren(...items);
}

/* ------------------------------------------------------------------ top-level render */
function currentCollector() {
  return state.result ? state.result.collectors[state.collector] : null;
}

function renderAll() {
  const collectors = state.result ? state.result.collectors : [];
  $("#empty").hidden = collectors.length > 0;
  $("#empty").textContent = state.result && !collectors.length
    ? "The chart rendered, but no collector configs were found (are all collectors disabled?)."
    : "Render a values file to see the collector pipelines.";
  renderTabs(collectors);
  renderSignalFilters();
  renderSummary();
  renderView();
  if (state.selected) openDrawer(state.selected.section, state.selected.id);
}

function renderTabs(collectors) {
  $("#collector-tabs").replaceChildren(...collectors.map((c, i) => {
    const errors = c.warnings.filter((w) => w.level === "error").length;
    const warns = c.warnings.filter((w) => w.level === "warning").length;
    return el("button", {
      class: "tab" + (i === state.collector ? " active" : ""), role: "tab", type: "button",
      "aria-selected": String(i === state.collector),
      onclick: () => { state.collector = i; closeDrawer(); renderAll(); },
    }, c.id, el("span", { class: "workload" }, c.workload),
      errors ? el("span", { class: "badge error", title: `${errors} errors` }, errors) : null,
      warns ? el("span", { class: "badge warning", title: `${warns} warnings` }, warns) : null);
  }));
}

function renderSignalFilters() {
  const c = currentCollector();
  const present = c ? SIGNALS.filter((s) => c.pipelines.some((p) => p.signal === s)) : [];
  $("#signal-filters").replaceChildren(...present.map((s) => {
    const n = c.pipelines.filter((p) => p.signal === s).length;
    return el("button", {
      class: "chip" + (state.signalsOff.has(s) ? " off" : ""), type: "button",
      "aria-pressed": String(!state.signalsOff.has(s)),
      onclick: () => { state.signalsOff.has(s) ? state.signalsOff.delete(s) : state.signalsOff.add(s); renderSignalFilters(); renderView(); },
    }, el("span", { class: "dot", style: `background:${SIGNAL_COLOR[s]}` }), `${s} (${n})`);
  }));
}

function renderSummary() {
  const c = currentCollector();
  const host = $("#summary");
  if (!c) return host.replaceChildren();
  const count = (section) => Object.keys(c.components[section] || {}).length;
  const userCount = Object.values(c.components).reduce((n, sec) => n + Object.values(sec).filter((x) => x.origin !== "chart").length, 0);
  host.replaceChildren(
    el("span", {}, el("b", {}, c.name)),
    el("span", {}, el("b", {}, c.pipelines.length), " pipelines"),
    ...["receivers", "processors", "exporters", "connectors"].map((s) => el("span", {}, el("b", {}, count(s)), ` ${s}`)),
    el("span", {}, el("b", {}, userCount), " components from your values"),
  );
  const problems = c.warnings.filter((w) => w.level !== "info").length;
  $("#problem-count").textContent = c.warnings.length ? `(${problems || c.warnings.length})` : "";
}

function renderView() {
  for (const v of ["graph", "problems", "yaml"]) $(`#view-${v}`).hidden = state.view !== v || !currentCollector();
  document.querySelectorAll(".view-switch button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  if (!currentCollector()) return;
  if (state.view === "graph") renderGraph();
  if (state.view === "problems") renderProblems();
  if (state.view === "yaml") renderYaml();
}

/* ------------------------------------------------------------------ graph */
function componentFor(c, section, id, isConnector) {
  const sec = isConnector ? "connectors" : section;
  return { section: sec, entry: (c.components[sec] || {})[id] };
}

function nodeKey(item, section) {
  return `${item.connector ? "connectors" : section}:${item.id}`;
}

function nodeButton(c, section, item, step) {
  const { section: sec, entry } = componentFor(c, section, item.id, item.connector);
  const origin = entry ? entry.origin : "chart";
  const key = nodeKey(item, section);
  const cls = ["node", item.connector ? "connector" : `origin-${origin}`, entry ? "" : "missing"];
  if (state.selected && `${state.selected.section}:${state.selected.id}` === key) cls.push("selected");
  const title = entry
    ? `${item.id}\n${singular(sec)} · ${ORIGIN_LABEL[origin]}${item.origin === "user" && origin === "chart" ? " (listed in your pipeline)" : ""}`
    : `${singular(section)} '${item.id}' is not defined`;
  return el("button", {
    class: cls.filter(Boolean).join(" "), type: "button", title,
    dataset: { key },
    onclick: () => openDrawer(sec, item.id),
    onmouseenter: () => highlight(key, true),
    onmouseleave: () => highlight(key, false),
  }, step !== undefined ? el("span", { class: "step" }, step) : null, el("span", { class: "label" }, item.id));
}

function extensionsStrip(c) {
  const extIds = Object.keys(c.components.extensions || {});
  if (!extIds.length) return null;
  return el("div", { class: "extensions" },
    el("span", { class: "label" }, "extensions"),
    ...extIds.map((id) => {
      const btn = nodeButton(c, "extensions", { id, origin: "chart", connector: false });
      if (!c.components.extensions[id].enabled) { btn.classList.add("disabled"); btn.title += " · not enabled"; }
      return btn;
    }));
}

function visiblePipelines(c) {
  const rank = (s) => { const i = SIGNALS.indexOf(s); return i < 0 ? SIGNALS.length : i; };
  return c.pipelines
    .filter((p) => !state.signalsOff.has(p.signal))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p.signal) - rank(b.p.signal) || a.i - b.i)
    .map(({ p }) => p);
}

function renderGraph() {
  const c = currentCollector();
  const host = $("#view-graph");
  const pipelines = visiblePipelines(c);
  const graphHost = el("div", { class: "graph-host" });
  host.replaceChildren(extensionsStrip(c), graphHost);
  if (!pipelines.length) {
    graphHost.append(el("div", { class: "empty" }, "All signals are filtered out."));
    return;
  }
  PipelineGraph.render(graphHost, c.id, pipelines, {
    el, cssId,
    signalColor: (s) => SIGNAL_COLOR[s] || "var(--muted)",
    originLabel: (o) => ORIGIN_LABEL[o],
    errorsFor: (pid) => c.warnings.filter((w) => w.pipeline === pid && w.level === "error").length,
    keyFor: nodeKey,
    makeNode: (item, kind, step) => nodeButton(c, kind, item, step),
  });
}

function highlight(key, on) {
  document.querySelectorAll(`#view-graph .node[data-key="${CSS.escape(key)}"]`).forEach((n) => n.classList.toggle("hl", on));
  PipelineGraph.highlightEdges(key, on);
}

function cssId(s) { return s.replace(/[^a-zA-Z0-9_-]/g, "_"); }

function focusPipeline(id) {
  if (state.view !== "graph") { state.view = "graph"; renderView(); }
  if (state.signalsOff.has(id.split("/")[0])) {
    state.signalsOff.delete(id.split("/")[0]);
    renderSignalFilters(); renderView();
  }
  const lane = PipelineGraph.focusPipeline(id);
  if (!lane) return;
  lane.classList.add("focus");
  setTimeout(() => lane.classList.remove("focus"), 1500);
}

/* ------------------------------------------------------------------ problems */
function renderProblems() {
  const c = currentCollector();
  const host = $("#view-problems");
  if (!c.warnings.length) return host.replaceChildren(el("div", { class: "empty" }, "No problems found in this collector's rendered config."));
  host.replaceChildren(...c.warnings.map((w) => el("div", {
    class: "problem", role: "button", tabindex: "0",
    onclick: () => w.component ? openDrawerForId(c, w.component) : w.pipeline && focusPipeline(w.pipeline),
    onkeydown: (e) => { if (e.key === "Enter") e.currentTarget.click(); },
  }, el("span", { class: `lvl ${w.level}` }, w.level), el("span", {}, formatMessage(w.message)))));
}

function formatMessage(msg) {
  // Render 'quoted' identifiers as code.
  return msg.split(/('[^']+')/g).map((part) => /^'.*'$/.test(part) ? el("code", {}, part.slice(1, -1)) : part);
}

function openDrawerForId(c, id) {
  const section = ["receivers", "processors", "exporters", "connectors", "extensions"].find((s) => (c.components[s] || {})[id]);
  if (section) openDrawer(section, id);
  else {
    const w = c.warnings.find((x) => x.component === id && x.pipeline);
    if (w) focusPipeline(w.pipeline);
  }
}

/* ------------------------------------------------------------------ rendered yaml */
function renderYaml() {
  $("#rendered-yaml").replaceChildren(...highlightYaml(currentCollector().relay));
}

function highlightYaml(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const comment = line.match(/^(\s*)(#.*)$/);
    const key = line.match(/^(\s*(?:- )?)([^\s:#'"][^:#]*?|"[^"]*"|'[^']*'):(\s|$)(.*)$/);
    if (comment) out.push(comment[1], el("span", { class: "c" }, comment[2]));
    else if (key) out.push(key[1], el("span", { class: "k" }, key[2]), ":" + key[3], key[4] ? el("span", { class: "s" }, key[4]) : "");
    else out.push(line);
    out.push("\n");
  }
  return out;
}

/* ------------------------------------------------------------------ drawer */
function docsUrl(section, type) {
  const kind = singular(section);
  const core = (CORE_COMPONENTS[section] || []).includes(type);
  const repo = core ? "opentelemetry-collector" : "opentelemetry-collector-contrib";
  const pkg = type.replace(/_/g, "") + kind;
  const path = kind === "extension" && type.endsWith("_observer") ? `extension/observer/${pkg.replace("extension", "")}` : `${kind}/${pkg}`;
  return `https://github.com/open-telemetry/${repo}/tree/main/${path}`;
}

function findInValues(alias, section, id) {
  const lines = editor.lines();
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((l) => new RegExp(`^["']?${alias.replace(/-/g, "\\-")}["']?:`).test(l));
  if (start < 0) return -1;
  let end = lines.findIndex((l, i) => i > start && /^[^\s#]/.test(l));
  if (end < 0) end = lines.length;
  let inSection = false;
  for (let i = start + 1; i < end; i++) {
    if (new RegExp(`^\\s+${section}:\\s*$`).test(lines[i])) inSection = true;
    else if (inSection && new RegExp(`^\\s+["']?${esc}["']?:`).test(lines[i])) return i;
  }
  return -1;
}

function openDrawer(section, id) {
  const c = currentCollector();
  const entry = (c.components[section] || {})[id];
  state.selected = { section, id };
  document.querySelectorAll("#view-graph .node.selected").forEach((n) => n.classList.remove("selected"));
  document.querySelectorAll(`#view-graph .node[data-key="${CSS.escape(`${section}:${id}`)}"]`).forEach((n) => n.classList.add("selected"));
  $("#drawer").hidden = false;
  $("#drawer-kind").textContent = singular(section) + (entry ? ` · type ${entry.type}` : "");
  $("#drawer-title").textContent = id;

  const meta = [];
  if (!entry) {
    meta.push(el("div", { class: "row" }, el("span", { class: "lvl error problem-inline" }, "not defined"),
      `No ${singular(section)} named '${id}' exists in the rendered config.`));
    $("#drawer-meta").replaceChildren(...meta);
    $("#drawer-yaml").replaceChildren();
    return;
  }
  meta.push(el("div", { class: "row" }, el("span", { class: "muted" }, "Source"),
    el("span", { class: `origin-tag origin-${entry.origin}` }, ORIGIN_LABEL[entry.origin])));
  if (section === "extensions") {
    meta.push(el("div", { class: "row" }, el("span", { class: "muted" }, "Enabled"), entry.enabled ? "yes (in service.extensions)" : "no — not listed in service.extensions"));
  } else {
    meta.push(el("div", { class: "row" }, el("span", { class: "muted" }, "Used in"),
      entry.usedIn.length ? entry.usedIn.flatMap((p, i) => [i ? " " : "", el("button", { class: "link-btn", type: "button", onclick: () => focusPipeline(p) }, p)]) : el("span", { class: "muted" }, "no pipelines")));
  }
  const issues = c.warnings.filter((w) => w.component === id);
  for (const w of issues) meta.push(el("div", { class: "row" }, el("span", { class: `lvl ${w.level} problem-inline` }, w.level), formatMessage(w.message)));
  const line = entry.origin !== "chart" ? findInValues(c.id, section, id) : -1;
  meta.push(el("div", { class: "row" },
    el("a", { href: docsUrl(section, entry.type), target: "_blank", rel: "noopener noreferrer" }, "Component docs ↗"),
    line >= 0 ? el("button", { class: "link-btn", type: "button", onclick: () => editor.jumpToLine(line) }, `Show in values.yaml (line ${line + 1})`) : null));
  $("#drawer-meta").replaceChildren(...meta);
  $("#drawer-yaml").replaceChildren(...highlightYaml(entry.yaml));
}

function closeDrawer() {
  state.selected = null;
  $("#drawer").hidden = true;
  document.querySelectorAll("#view-graph .node.selected").forEach((n) => n.classList.remove("selected"));
}

/* ------------------------------------------------------------------ misc UI */
function initSplitter() {
  const splitter = $("#splitter");
  const pane = $(".editor-pane");
  let dragging = false;
  splitter.addEventListener("pointerdown", (e) => { dragging = true; splitter.classList.add("dragging"); splitter.setPointerCapture(e.pointerId); });
  splitter.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const pct = Math.min(75, Math.max(18, (e.clientX / window.innerWidth) * 100));
    pane.style.width = `${pct}%`;
  });
  splitter.addEventListener("pointerup", () => { dragging = false; splitter.classList.remove("dragging"); });
}

function loadFile(file) {
  if (!file) return;
  file.text().then((text) => { editor.set(text); renderNow(); })
    .catch((err) => setStatus(`Could not read file: ${err.message}`, true));
}

async function loadStarter() {
  try {
    const res = await fetch("starter-values.yaml");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    editor.set(await res.text());
    renderNow();
  } catch (err) { setStatus(`Could not load starter values: ${err.message}`, true); }
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function init() {
  initSplitter();
  editor.onChange(scheduleLive);
  $("#render").addEventListener("click", renderNow);
  $("#load-starter").addEventListener("click", loadStarter);
  $("#file-input").addEventListener("change", (e) => loadFile(e.target.files[0]));
  $("#version").addEventListener("change", renderNow);
  $("#drawer-close").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") renderNow();
  });
  document.querySelectorAll(".view-switch button").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.view; renderView(); }));
  $("#copy-yaml").addEventListener("click", () => navigator.clipboard.writeText(currentCollector().relay).then(() => setStatus("Copied rendered config")));
  $("#download-yaml").addEventListener("click", () => { const c = currentCollector(); download(`${c.id}-config.yaml`, c.relay); });
  const host = $("#editor-host");
  host.addEventListener("dragover", (e) => e.preventDefault());
  host.addEventListener("drop", (e) => { e.preventDefault(); loadFile(e.dataTransfer.files[0]); });
  
  loadVersions().then(() => {
    const saved = storage.get(STORAGE_KEY);
    if (saved && saved.trim()) { editor.set(saved); renderNow(); } else loadStarter();
  });
}

init();
