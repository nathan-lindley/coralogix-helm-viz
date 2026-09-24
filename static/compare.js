"use strict";

/*
 * Compare view: diff the active tab against another workspace tab.
 *
 * Direction is always "other tab → this tab": things only in this tab are
 * "added", things only in the other tab are "removed".
 *   - summary:  structural diff of the selected collector (pipelines, components, problems)
 *   - rendered: unified line diff of the selected collector's rendered config
 *   - values:   unified line diff of the two values.yaml files
 */

const COMPARE_MODES = [["summary", "Summary"], ["rendered", "Rendered config"], ["values", "values.yaml"]];
const DIFF_CONTEXT_LINES = 3;
const COMPONENT_SECTIONS = ["receivers", "processors", "exporters", "connectors", "extensions"];
const PIPELINE_LISTS = ["receivers", "processors", "exporters"];

/* ------------------------------------------------------------------ structural diff (pure) */
function listDiff(before, after) {
  const a = new Set(before);
  const b = new Set(after);
  const common = (xs, other) => xs.filter((x) => other.has(x));
  const reordered = common(before, b).join("\u0000") !== common(after, a).join("\u0000");
  return { added: after.filter((x) => !a.has(x)), removed: before.filter((x) => !b.has(x)), reordered };
}

const listChanged = (d) => d.added.length || d.removed.length || d.reordered;

function diffPipelines(basePipes, targetPipes) {
  const base = new Map(basePipes.map((p) => [p.id, p]));
  const target = new Map(targetPipes.map((p) => [p.id, p]));
  const ids = (list) => list.map((x) => x.id);
  const changed = [];
  for (const [id, t] of target) {
    const b = base.get(id);
    if (!b) continue;
    const lists = Object.fromEntries(PIPELINE_LISTS.map((k) => [k, listDiff(ids(b[k]), ids(t[k]))]));
    if (PIPELINE_LISTS.some((k) => listChanged(lists[k]))) changed.push({ id, lists });
  }
  return {
    added: [...target.keys()].filter((id) => !base.has(id)),
    removed: [...base.keys()].filter((id) => !target.has(id)),
    changed,
  };
}

function diffComponents(baseComps, targetComps) {
  const out = {};
  for (const section of COMPONENT_SECTIONS) {
    const b = baseComps[section] || {};
    const t = targetComps[section] || {};
    out[section] = {
      added: Object.keys(t).filter((id) => !(id in b)),
      removed: Object.keys(b).filter((id) => !(id in t)),
      changed: Object.keys(t).filter((id) => id in b && b[id].yaml !== t[id].yaml)
        .map((id) => ({ id, before: b[id].yaml, after: t[id].yaml })),
    };
  }
  return out;
}

function diffProblems(baseWarnings, targetWarnings) {
  const key = (w) => `${w.level}\u0000${w.message}`;
  const b = new Set(baseWarnings.map(key));
  const t = new Set(targetWarnings.map(key));
  return {
    introduced: targetWarnings.filter((w) => !b.has(key(w))),
    resolved: baseWarnings.filter((w) => !t.has(key(w))),
  };
}

/** Structural diff of one collector; either side may be missing. */
function diffCollector(base, target) {
  const empty = { pipelines: [], components: {}, warnings: [] };
  const b = base || empty;
  const t = target || empty;
  return {
    pipelines: diffPipelines(b.pipelines, t.pipelines),
    components: diffComponents(b.components, t.components),
    problems: diffProblems(b.warnings, t.warnings),
  };
}

function diffIsEmpty(d) {
  const p = d.pipelines;
  const componentChanges = Object.values(d.components).some((c) => c.added.length || c.removed.length || c.changed.length);
  return !p.added.length && !p.removed.length && !p.changed.length && !componentChanges
    && !d.problems.introduced.length && !d.problems.resolved.length;
}

/* ------------------------------------------------------------------ line diff rendering */
function renderPatch(beforeText, afterText, beforeName, afterName) {
  if (!window.Diff || typeof Diff.structuredPatch !== "function") {
    return el("div", { class: "notice error" }, "Diff library failed to load (offline?) — line diffs are unavailable.");
  }
  const patch = Diff.structuredPatch(beforeName, afterName, beforeText, afterText, "", "", { context: DIFF_CONTEXT_LINES });
  if (!patch.hunks.length) return el("div", { class: "diff-same" }, "Identical.");
  let added = 0;
  let removed = 0;
  const rows = [];
  for (const hunk of patch.hunks) {
    rows.push(el("div", { class: "diff-row hunk" },
      el("span", { class: "ln" }), el("span", { class: "ln" }),
      el("span", { class: "txt" }, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)));
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const sign = line[0];
      if (sign === "\\") continue;   // "\ No newline at end of file"
      const kind = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
      if (kind === "add") added++;
      if (kind === "del") removed++;
      rows.push(el("div", { class: `diff-row ${kind}` },
        el("span", { class: "ln" }, kind === "add" ? "" : oldLine),
        el("span", { class: "ln" }, kind === "del" ? "" : newLine),
        el("span", { class: "txt" }, `${sign === " " ? " " : sign} ${line.slice(1)}`)));
      if (kind !== "add") oldLine++;
      if (kind !== "del") newLine++;
    }
  }
  return el("div", { class: "diff" },
    el("div", { class: "diff-head" },
      el("span", { class: "del-count" }, `−${removed}`), el("span", { class: "add-count" }, `+${added}`),
      el("span", { class: "muted" }, `${beforeName} → ${afterName}`)),
    el("div", { class: "diff-body" }, rows));
}

/* ------------------------------------------------------------------ summary rendering */
const idCode = (id) => el("code", {}, id);
const joinCodes = (ids) => ids.flatMap((id, i) => [i ? ", " : "", idCode(id)]);

function summarySection(title, items) {
  return items.length ? el("section", { class: "cmp-section" }, el("h4", {}, title), el("ul", { class: "cmp-list" }, items)) : null;
}

function pipelineItems(p) {
  const items = [
    ...p.added.map((id) => el("li", { class: "add" }, "+ pipeline ", idCode(id))),
    ...p.removed.map((id) => el("li", { class: "del" }, "− pipeline ", idCode(id))),
  ];
  for (const change of p.changed) {
    const parts = PIPELINE_LISTS.flatMap((k) => {
      const d = change.lists[k];
      if (!listChanged(d)) return [];
      return [el("div", { class: "cmp-detail" },
        el("span", { class: "muted" }, `${k}: `),
        d.added.length ? el("span", { class: "add" }, "+ ", ...joinCodes(d.added), " ") : null,
        d.removed.length ? el("span", { class: "del" }, "− ", ...joinCodes(d.removed), " ") : null,
        d.reordered ? el("span", { class: "chg" }, "order changed") : null)];
    });
    items.push(el("li", { class: "chg" }, "~ pipeline ", idCode(change.id), ...parts));
  }
  return items;
}

function componentItems(components, baseTab, targetTab) {
  const items = [];
  for (const section of COMPONENT_SECTIONS) {
    const c = components[section];
    if (!c) continue;
    const kind = singular(section);
    items.push(...c.added.map((id) => el("li", { class: "add" }, `+ ${kind} `, idCode(id))));
    items.push(...c.removed.map((id) => el("li", { class: "del" }, `− ${kind} `, idCode(id))));
    for (const ch of c.changed) {
      const body = el("div", { class: "cmp-inline-diff", hidden: true });
      const toggle = el("button", {
        class: "link-btn", type: "button", "aria-expanded": "false",
        onclick: () => {
          const open = body.hidden;
          if (open && !body.childNodes.length) body.append(renderPatch(ch.before, ch.after, baseTab.name, targetTab.name));
          body.hidden = !open;
          toggle.setAttribute("aria-expanded", String(open));
          toggle.textContent = open ? "hide diff" : "show diff";
        },
      }, "show diff");
      items.push(el("li", { class: "chg" }, `~ ${kind} `, idCode(ch.id), " ", toggle, body));
    }
  }
  return items;
}

function problemItems(problems) {
  const row = (w, cls, sign) => el("li", { class: cls }, `${sign} `, el("span", { class: `lvl ${w.level}` }, w.level), " ", formatMessage(w.message));
  return [
    ...problems.introduced.map((w) => row(w, "del", "new")),
    ...problems.resolved.map((w) => row(w, "add", "fixed")),
  ];
}

function renderCompareSummary(baseTab, targetTab, collectorId) {
  const findCollector = (tab) => tab.result.collectors.find((c) => c.id === collectorId);
  const base = findCollector(baseTab);
  const target = findCollector(targetTab);
  const notes = [];
  if (!base) notes.push(el("div", { class: "notice" }, idCode(collectorId), ` is not rendered in "${baseTab.name}" (disabled there?) — everything below is new.`));
  const onlyInBase = baseTab.result.collectors.filter((c) => !targetTab.result.collectors.some((t) => t.id === c.id));
  if (onlyInBase.length) notes.push(el("div", { class: "notice" }, `Only in "${baseTab.name}": `, ...joinCodes(onlyInBase.map((c) => c.id))));
  if (baseTab.version !== targetTab.version) {
    notes.push(el("div", { class: "notice" }, `Chart versions differ: ${baseTab.version || "latest"} → ${targetTab.version || "latest"}.`));
  }

  const d = diffCollector(base, target);
  if (diffIsEmpty(d)) {
    return el("div", {}, ...notes, el("div", { class: "empty" }, `No differences in ${collectorId}.`));
  }
  return el("div", { class: "cmp-summary" }, ...notes,
    summarySection("Pipelines", pipelineItems(d.pipelines)),
    summarySection("Components", componentItems(d.components, baseTab, targetTab)),
    summarySection("Problems", problemItems(d.problems)));
}

/* ------------------------------------------------------------------ view */
function compareState() {
  if (!state.compare) state.compare = { withId: null, mode: "summary" };
  const others = tabs.filter((t) => t !== state);
  if (!others.some((t) => t.id === state.compare.withId)) {
    const index = tabs.indexOf(state);
    state.compare.withId = (tabs[index - 1] || others[0] || {}).id || null;   // default: the tab to the left
  }
  return state.compare;
}

function compareToolbar(cmp, others) {
  const select = el("select", {
    "aria-label": "Tab to compare against",
    onchange: (e) => { cmp.withId = e.target.value; renderView(); },
  }, others.map((t) => el("option", { value: t.id, selected: t.id === cmp.withId }, `${t.name} (${t.version || "latest"})`)));
  const modes = el("div", { class: "view-switch", role: "tablist" }, COMPARE_MODES.map(([mode, label]) =>
    el("button", { type: "button", class: mode === cmp.mode ? "active" : "", onclick: () => { cmp.mode = mode; renderView(); } }, label)));
  const swap = el("button", {
    class: "ghost", type: "button", title: "Switch to the other tab, comparing back against this one",
    onclick: () => {
      const other = tabs.find((t) => t.id === cmp.withId);
      if (!other) return;
      other.compare = { withId: state.id, mode: cmp.mode };
      other.view = "compare";
      activate(other);
    },
  }, "⇄ Swap");
  return el("div", { class: "cmp-toolbar" },
    el("span", { class: "muted" }, "From"), select,
    el("span", { class: "muted" }, "→"), el("b", {}, `${state.name} (${state.version || "latest"})`),
    swap, modes);
}

function renderCompare() {
  const host = $("#view-compare");
  const others = tabs.filter((t) => t !== state);
  if (!others.length) {
    host.replaceChildren(el("div", { class: "empty" },
      "Compare needs a second tab. ",
      el("button", { class: "ghost", type: "button", onclick: duplicateTab }, "Duplicate this tab"),
      " and change its values or chart version, or open another values file."));
    return;
  }
  const cmp = compareState();
  const other = tabs.find((t) => t.id === cmp.withId);
  const toolbar = compareToolbar(cmp, others);
  const collectorId = currentCollector().id;

  if (cmp.mode === "values") {
    host.replaceChildren(toolbar, renderPatch(other.values, editor.get(), other.name, state.name));
    return;
  }
  if (!other.result) {
    if (!other.inflight && !other.error && other.values.trim()) renderNow(other);
    const message = other.error ? `"${other.name}" failed to render: ${other.error.message}` : `Rendering "${other.name}"…`;
    host.replaceChildren(toolbar, el("div", { class: other.error ? "notice error" : "empty" }, message));
    return;
  }
  if (cmp.mode === "rendered") {
    const before = (other.result.collectors.find((c) => c.id === collectorId) || {}).relay || "";
    host.replaceChildren(toolbar,
      el("div", { class: "muted small cmp-hint" }, `Rendered config of ${collectorId}. Pick another collector with the tabs above.`),
      renderPatch(before, currentCollector().relay, other.name, state.name));
    return;
  }
  host.replaceChildren(toolbar, renderCompareSummary(other, state, collectorId));
}
