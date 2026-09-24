"use strict";

/*
 * Workspace tabs: each tab is an independent values.yaml + chart version with
 * its own render, collector selection, filters and pan/zoom. Duplicating a tab
 * and switching its chart version is the quick way to compare chart releases;
 * opening files into tabs compares values files.
 *
 * Tabs persist in localStorage (values, name, version, which one is active).
 */

const WORKSPACE_KEY = "cx-helm-viz:workspace";
const LEGACY_VALUES_KEY = "cx-helm-viz:values";
const SAVE_DEBOUNCE_MS = 400;
const MAX_TAB_NAME = 60;

let tabs = [];
let knownVersions = [];
let saveTimer = null;
let starterCache = null;

/* ------------------------------------------------------------------ persistence */
function saveWorkspace() {
  clearTimeout(saveTimer);
  if (tabs.includes(state)) state.values = editor.get();
  storage.set(WORKSPACE_KEY, JSON.stringify({
    active: state.id,
    tabs: tabs.map(({ id, name, values, version }) => ({ id, name, values, version })),
  }));
}

function saveWorkspaceSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWorkspace, SAVE_DEBOUNCE_MS);
}

/** Parse saved tabs defensively — storage is user-controlled and may be stale. */
function loadSavedTabs() {
  let saved = null;
  try { saved = JSON.parse(storage.get(WORKSPACE_KEY) || "null"); } catch { saved = null; }
  const valid = (t) => t && typeof t.id === "string" && typeof t.name === "string" && typeof t.values === "string";
  const list = saved && Array.isArray(saved.tabs) ? saved.tabs.filter(valid) : [];
  if (list.length) {
    return {
      tabs: list.map((t) => newTabState({ ...t, version: typeof t.version === "string" ? t.version : "" })),
      active: saved.active,
    };
  }
  const legacy = storage.get(LEGACY_VALUES_KEY);   // single-document format from earlier versions
  if (legacy && legacy.trim()) {
    try { localStorage.removeItem(LEGACY_VALUES_KEY); } catch { /* storage blocked */ }
    return { tabs: [newTabState({ id: newTabId(), name: "values.yaml", values: legacy })], active: null };
  }
  return { tabs: [], active: null };
}

/* ------------------------------------------------------------------ tab operations */
function newTabId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function uniqueName(base) {
  const names = new Set(tabs.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

function defaultVersion() {
  return knownVersions[0] || "";
}

function addTab({ name, values, version }) {
  const tab = newTabState({ id: newTabId(), name: uniqueName(name), values, version: version || defaultVersion() });
  const at = tabs.indexOf(state);
  tabs = at >= 0 ? [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)] : [...tabs, tab];
  activate(tab);
  return tab;
}

function activate(tab) {
  if (tabs.includes(state) && state !== tab) {
    state.values = editor.get();
    clearTimeout(state.liveTimer);
  }
  $("#drawer").hidden = true;   // the new tab re-opens its own selection, if any
  state = tab;
  editor.show(tab);
  syncVersionSelect();
  setStatus(tab.status.text, tab.status.isError);
  renderTabBar();
  renderNotices();
  renderAll();
  saveWorkspace();
  if (!tab.result && !tab.error && !tab.inflight && tab.values.trim()) renderNow();
}

function closeTab(tab) {
  const hasContent = tab.values.trim() && tab.values !== starterCache;
  if (hasContent && !window.confirm(`Close "${tab.name}"? Its values will be discarded.`)) return;
  const index = tabs.indexOf(tab);
  tabs = tabs.filter((t) => t !== tab);
  PipelineGraph.forget(`${tab.id}:`);
  if (!tabs.length) { newStarterTab(); return; }
  if (tab === state) activate(tabs[Math.min(index, tabs.length - 1)]);
  else { renderTabBar(); saveWorkspace(); }
}

function duplicateTab() {
  addTab({ name: `${state.name} copy`, values: editor.get(), version: state.version });
}

function renameTab(tab, name) {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, MAX_TAB_NAME);
  if (clean) tab.name = clean;
  renderTabBar();
  saveWorkspace();
}

async function starterValues() {
  if (starterCache !== null) return starterCache;
  const res = await fetch("starter-values.yaml");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  starterCache = await res.text();
  return starterCache;
}

async function newStarterTab() {
  try {
    addTab({ name: "Untitled", values: await starterValues() });
  } catch (err) {
    addTab({ name: "Untitled", values: "" });
    setStatus(`Could not load starter values: ${err.message}`, true);
  }
}

async function loadStarter() {
  try {
    editor.set(await starterValues());
    renderNow();
  } catch (err) { setStatus(`Could not load starter values: ${err.message}`, true); }
}

/** Opened / dropped files get their own tab, named after the file. */
function loadFile(file) {
  if (!file) return;
  file.text()
    .then((text) => addTab({ name: file.name, values: text, version: state.version }))
    .catch((err) => setStatus(`Could not read file: ${err.message}`, true));
}

/* ------------------------------------------------------------------ chart version */
function syncVersionSelect() {
  const select = $("#version");
  if (!state.version) state.version = defaultVersion();
  if (state.version && ![...select.options].some((o) => o.value === state.version)) {
    select.append(el("option", { value: state.version }, state.version));
  }
  select.value = state.version;
}

function onVersionChange(e) {
  state.version = e.target.value;
  state.result = null;
  renderTabBar();
  saveWorkspace();
  renderNow();
}

/* ------------------------------------------------------------------ tab bar */
function tabIndicator(tab) {
  if (tab.inflight) return el("span", { class: "ws-dot busy", title: "Rendering…" });
  if (tab.error) return el("span", { class: "ws-dot error", title: tab.error.message });
  const problems = tab.result ? tab.result.collectors.reduce((n, c) => n + c.warnings.filter((w) => w.level === "error").length, 0) : 0;
  return problems ? el("span", { class: "ws-dot warn", title: `${problems} config error(s)` }) : null;
}

function startRename(tab, label) {
  const input = el("input", { class: "ws-rename", value: tab.name, maxlength: String(MAX_TAB_NAME), "aria-label": "Tab name" });
  let done = false;
  const commit = (save) => { if (done) return; done = true; save ? renameTab(tab, input.value) : renderTabBar(); };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(true);
    if (e.key === "Escape") commit(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => commit(true));
  label.replaceWith(input);
  input.focus();
  input.select();
}

function renderTabBar() {
  const bar = $("#workspace-tabs");
  if (!bar) return;
  const items = tabs.map((tab) => {
    const node = el("div", {
      class: "ws-tab" + (tab === state ? " active" : ""), role: "tab", tabindex: "0",
      "aria-selected": String(tab === state), title: `${tab.name} — chart ${tab.version || "latest"} (double-click to rename)`,
      onclick: () => { if (tab !== state) activate(tab); },
      // The first click of a double-click may have re-rendered the bar; use the live label.
      ondblclick: () => {
        const live = $("#workspace-tabs .ws-tab.active .ws-name");
        if (tab === state && live) startRename(tab, live);
      },
      onkeydown: (e) => { if (e.key === "Enter" && tab !== state) activate(tab); },
    },
    tabIndicator(tab), el("span", { class: "ws-name" }, tab.name),
    el("span", { class: "ws-version" }, tab.version || "latest"),
    el("button", {
      class: "ws-close", type: "button", title: `Close ${tab.name}`, "aria-label": `Close ${tab.name}`,
      onclick: (e) => { e.stopPropagation(); closeTab(tab); },
    }, "×"));
    return node;
  });
  bar.replaceChildren(...items,
    el("button", { class: "ws-action", type: "button", title: "New tab with starter values", onclick: newStarterTab }, "+"),
    el("button", { class: "ws-action", type: "button", title: "Duplicate this tab (e.g. to try another chart version)", onclick: duplicateTab }, "Duplicate"));
}

/* ------------------------------------------------------------------ boot */
function init() {
  initSplitter();
  editor.onChange(scheduleLive);
  $("#render").addEventListener("click", renderNow);
  $("#load-starter").addEventListener("click", loadStarter);
  $("#file-input").addEventListener("change", (e) => { [...e.target.files].forEach(loadFile); e.target.value = ""; });
  $("#version").addEventListener("change", onVersionChange);
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
  host.addEventListener("drop", (e) => { e.preventDefault(); [...e.dataTransfer.files].forEach(loadFile); });
  window.addEventListener("beforeunload", saveWorkspace);

  loadVersions().then(() => {
    const saved = loadSavedTabs();
    tabs = saved.tabs;
    if (!tabs.length) { newStarterTab(); return; }
    activate(tabs.find((t) => t.id === saved.active) || tabs[0]);
  });
}

init();
