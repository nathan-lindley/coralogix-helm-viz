"use strict";

/*
 * Single-canvas pipeline graph (otelbin-style).
 *
 * Every pipeline is a horizontal lane: receivers stacked on the left, the
 * processor chain left-to-right, exporters stacked on the right. Lanes share
 * one pan/zoom surface. A lane fed by a connector starts to the right of every
 * lane exporting to it, so all edges — including the dashed connector links —
 * point rightwards and nothing loops back.
 */
const PipelineGraph = (() => {
  const L = {
    nodeH: 24, vGap: 6, procGap: 30, colGap: 56, gridGap: 12,
    lanePad: 10, laneHeader: 24, rowGap: 12,
    maxStack: 4,   // receivers/exporters wrap into another column beyond this
    charW: 7.25, nodePadX: 22, stepW: 16, minW: 96, maxW: 340,
    laneHGap: 90,
  };
  const MIN_SCALE = 0.15;
  const MAX_SCALE = 2.5;
  const MIN_FIT_SCALE = 0.6;
  const WHEEL_ZOOM_SPEED = 0.0025;
  const DRAG_THRESHOLD_PX = 4;
  const SVG_NS = "http://www.w3.org/2000/svg";

  let viewport = null;   // element receiving pointer events
  let world = null;      // transformed element holding lanes/nodes/edges
  let view = { x: 0, y: 0, k: 1 };
  let layout = null;     // last computed layout (for focus / fit)
  let lastCollectorId = null;

  const svg = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const nodeWidth = (label, numbered) =>
    Math.min(L.maxW, Math.max(L.minW, Math.ceil(label.length * L.charW) + L.nodePadX + (numbered ? L.stepW : 0)));

  /* ------------------------------------------------------------ layout */
  function stackY(count, laneContentTop, contentH) {
    const h = count * L.nodeH + Math.max(count - 1, 0) * L.vGap;
    const top = laneContentTop + (contentH - h) / 2;
    return (i) => top + i * (L.nodeH + L.vGap);
  }

  /**
   * Place items in a column-major grid of at most L.maxStack rows, vertically
   * centred in the lane content. Returns the nodes and the grid's width.
   */
  function grid(items, kind, x0, top, contentH, colW) {
    const rows = Math.min(Math.max(items.length, 1), L.maxStack);
    const cols = Math.ceil(items.length / rows);
    const y = stackY(rows, top, contentH);
    const nodes = items.map((item, i) => ({
      item, kind, x: x0 + Math.floor(i / rows) * (colW + L.gridGap), y: y(i % rows), w: colW,
    }));
    return { nodes, width: cols ? cols * colW + (cols - 1) * L.gridGap : 0 };
  }

  /** Lane geometry with the lane's own top-left at (0, 0). */
  function laneGeometry(p) {
    const stacked = (n) => Math.min(Math.max(n, 1), L.maxStack);
    const rows = Math.max(stacked(p.receivers.length), stacked(p.exporters.length));
    const contentH = rows * L.nodeH + (rows - 1) * L.vGap;
    const top = L.laneHeader;
    const midY = top + contentH / 2 - L.nodeH / 2;

    const recvW = Math.max(L.minW, ...p.receivers.map((r) => nodeWidth(r.id)));
    const recv = grid(p.receivers, "receivers", L.lanePad, top, contentH, recvW);
    const nodes = [...recv.nodes];

    let x = L.lanePad + Math.max(recv.width, L.minW) + L.colGap;
    p.processors.forEach((item, i) => {
      const w = nodeWidth(item.id, true);
      nodes.push({ item, kind: "processors", step: i + 1, x, y: midY, w });
      x += w + L.procGap;
    });
    const expX = p.processors.length ? x - L.procGap + L.colGap : x;
    const expW = Math.max(L.minW, ...p.exporters.map((e) => nodeWidth(e.id)));
    const exp = grid(p.exporters, "exporters", expX, top, contentH, expW);
    nodes.push(...exp.nodes);

    return { nodes, w: expX + Math.max(exp.width, L.minW) + L.lanePad, h: L.laneHeader + contentH + L.lanePad };
  }

  /**
   * pipeline id -> ids of pipelines that feed it through a connector
   * (they list the connector as an exporter; it lists it as a receiver).
   */
  function upstreamMap(pipelines) {
    const exportersOf = {};
    for (const p of pipelines) {
      for (const e of p.exporters) if (e.connector) (exportersOf[e.id] = exportersOf[e.id] || new Set()).add(p.id);
    }
    const upstream = {};
    for (const p of pipelines) {
      const feeders = new Set();
      for (const r of p.receivers) {
        if (!r.connector) continue;
        for (const q of exportersOf[r.id] || []) if (q !== p.id) feeders.add(q);
      }
      upstream[p.id] = feeders;
    }
    return upstream;
  }

  /** Topological order (Kahn). Pipelines caught in a cycle are appended as-is. */
  function topoOrder(pipelines, upstream) {
    const pending = new Map(pipelines.map((p) => [p.id, new Set(upstream[p.id])]));
    const order = [];
    while (pending.size) {
      const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([id]) => id);
      const batch = ready.length ? ready : [pending.keys().next().value];
      for (const id of batch) {
        order.push(id);
        pending.delete(id);
        for (const deps of pending.values()) deps.delete(id);
      }
    }
    return order;
  }

  /**
   * Lanes are placed so data only ever flows left-to-right: a pipeline fed by a
   * connector starts to the right of every pipeline that exports to it. Lanes
   * that don't overlap horizontally share a row to keep the graph compact.
   */
  function computeLayout(pipelines) {
    const upstream = upstreamMap(pipelines);
    const byId = new Map(pipelines.map((p, i) => [p.id, { p, index: i, geo: laneGeometry(p) }]));
    const place = {};
    for (const id of topoOrder(pipelines, upstream)) {
      const feeders = [...upstream[id]].filter((q) => place[q]);
      const x = feeders.length ? Math.max(...feeders.map((q) => place[q].x + byId.get(q).geo.w)) + L.laneHGap : 0;
      const depth = feeders.length ? Math.max(...feeders.map((q) => place[q].depth)) + 1 : 0;
      place[id] = { x, depth };
    }

    // First-fit row packing: a lane joins the first row where it doesn't
    // overlap horizontally. x never changes, so flow stays left-to-right.
    const ordered = [...byId.values()].sort((a, b) =>
      place[a.p.id].depth - place[b.p.id].depth || a.index - b.index);
    const rows = [];
    for (const entry of ordered) {
      const x = place[entry.p.id].x;
      const span = [x, x + entry.geo.w];
      const fits = (row) => row.spans.every(([l, r]) => span[0] >= r + L.laneHGap || span[1] + L.laneHGap <= l);
      let row = rows.find(fits);
      if (!row) { row = { spans: [], entries: [], h: 0 }; rows.push(row); }
      row.spans.push(span);
      row.entries.push(entry);
      row.h = Math.max(row.h, entry.geo.h);
    }

    const lanes = [];
    let y = 0;
    for (const row of rows) {
      for (const { p, geo } of row.entries) {
        const { x } = place[p.id];
        const nodes = geo.nodes.map((n) => ({ ...n, x: n.x + x, y: n.y + y }));
        lanes.push({ pipeline: p, x, y, w: geo.w, h: geo.h, right: x + geo.w, nodes });
      }
      y += row.h + L.rowGap;
    }
    const width = Math.max(600, ...lanes.map((l) => l.right));
    return { lanes, width, height: Math.max(y - L.rowGap, 0) };
  }

  /* ------------------------------------------------------------ edges */
  const right = (n) => ({ x: n.x + n.w, y: n.y + L.nodeH / 2 });
  const left = (n) => ({ x: n.x, y: n.y + L.nodeH / 2 });

  function curve(a, b, bend) {
    const dx = bend !== undefined ? bend : Math.max(20, (b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }

  function laneEdges(lane) {
    const by = (kind) => lane.nodes.filter((n) => n.kind === kind);
    const [recv, procs, exps] = [by("receivers"), by("processors"), by("exporters")];
    const edges = [];
    const add = (from, to) => edges.push({ d: curve(right(from), left(to)), from, to });
    if (procs.length) {
      recv.forEach((r) => add(r, procs[0]));
      procs.slice(1).forEach((p, i) => add(procs[i], p));
      exps.forEach((e) => add(procs[procs.length - 1], e));
    } else {
      recv.forEach((r) => exps.forEach((e) => add(r, e)));
    }
    return edges;
  }

  function connectorEdges(lanes) {
    const sources = {};
    const sinks = {};
    for (const lane of lanes) {
      for (const n of lane.nodes) {
        if (!n.item.connector) continue;
        const bucket = n.kind === "exporters" ? sources : n.kind === "receivers" ? sinks : null;
        if (bucket) (bucket[n.item.id] = bucket[n.item.id] || []).push(n);
      }
    }
    const edges = [];
    for (const [id, outs] of Object.entries(sources)) {
      for (const from of outs) {
        for (const to of sinks[id] || []) {
          edges.push({ d: curve(right(from), left(to)), from, to, connector: id });
        }
      }
    }
    return edges;
  }

  /* ------------------------------------------------------------ pan / zoom */
  function apply() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    const label = viewport.parentElement.querySelector(".zoom-level");
    if (label) label.textContent = `${Math.round(view.k * 100)}%`;
  }

  function zoomAt(factor, cx, cy) {
    const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.k * factor));
    view = { k, x: cx - (cx - view.x) * (k / view.k), y: cy - (cy - view.y) * (k / view.k) };
    apply();
  }

  /**
   * whole=false (initial load): fit the width but stay legible; the rest pans.
   * whole=true (Fit button): show the entire graph, however small.
   */
  function fit(whole = false) {
    if (!layout || !viewport) return;
    const pad = 24;
    const vw = viewport.clientWidth - pad * 2;
    const vh = viewport.clientHeight - pad * 2;
    if (vw <= 0 || vh <= 0) return;
    const scale = whole
      ? Math.max(MIN_SCALE, Math.min(1, vw / layout.width, vh / Math.max(layout.height, 1)))
      : Math.min(1, Math.max(MIN_FIT_SCALE, vw / layout.width));
    view = { k: scale, x: pad + Math.max(0, (vw - layout.width * scale) / 2), y: pad };
    apply();
  }

  function attachPanZoom() {
    // Drag anywhere (nodes included) to pan; a drag longer than a few pixels
    // swallows the click that would otherwise open the node's details.
    let drag = null;
    viewport.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { startX: e.clientX, startY: e.clientY, x: e.clientX - view.x, y: e.clientY - view.y, moved: false };
    });
    viewport.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setPointerCapture(e.pointerId);
        viewport.classList.add("panning");
      }
      view = { ...view, x: e.clientX - drag.x, y: e.clientY - drag.y };
      apply();
    });
    const end = () => {
      if (drag && drag.moved) {
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        viewport.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => viewport.removeEventListener("click", swallow, { capture: true }), 0);
      }
      drag = null;
      viewport.classList.remove("panning");
    };
    viewport.addEventListener("pointerup", end);
    viewport.addEventListener("pointercancel", end);
    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      // Scroll zooms around the cursor; line-mode deltas (mouse wheels) are much coarser.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-delta * WHEEL_ZOOM_SPEED), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
  }

  function centerOn(lane) {
    const vh = viewport.clientHeight;
    view = { ...view, x: 24 - lane.x * view.k, y: vh / 2 - (lane.y + lane.h / 2) * view.k };
    apply();
  }

  /* ------------------------------------------------------------ render */
  function laneBox(lane, helpers) {
    const p = lane.pipeline;
    const box = helpers.el("div", {
      class: "lane", id: `lane-${helpers.cssId(p.id)}`,
      style: `left:${lane.x}px;top:${lane.y}px;height:${lane.h}px;width:${lane.w}px;--sig:${helpers.signalColor(p.signal)}`,
      dataset: { pipeline: p.id },
    });
    const errors = helpers.errorsFor(p.id);
    box.append(helpers.el("div", { class: "lane-head" },
      helpers.el("span", { class: "dot" }),
      helpers.el("span", { class: "name" }, p.id),
      helpers.el("span", { class: `origin-tag origin-${p.origin}`, title: helpers.originLabel(p.origin) },
        p.origin === "chart" ? "preset" : p.origin === "user" ? "yours" : "extended"),
      errors ? helpers.el("span", { class: "warn-dot", title: `${errors} error(s)` }, `● ${errors}`) : null,
      helpers.el("span", { class: "counts" }, `${p.receivers.length} → ${p.processors.length} → ${p.exporters.length}`)));
    return box;
  }

  function edgeLayer(width, height, edges, klass) {
    const layer = svg("svg", { class: `edges ${klass}`, width, height, viewBox: `0 0 ${width} ${height}` });
    const id = `arrow-${klass}`;
    const defs = svg("defs");
    const marker = svg("marker", { id, viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    marker.append(svg("path", { d: "M0,0 L8,4 L0,8 z", class: "arrowhead" }));
    defs.append(marker);
    layer.append(defs);
    for (const e of edges) {
      layer.append(svg("path", {
        d: e.d, "marker-end": `url(#${id})`,
        "data-from": e.from.key, "data-to": e.to.key,
        class: e.connector ? "connector" : "",
      }));
    }
    return layer;
  }

  /**
   * helpers: { el, cssId, signalColor, originLabel, errorsFor(pipelineId), makeNode(item, kind, step) }
   */
  function render(host, collectorId, pipelines, helpers) {
    layout = computeLayout(pipelines);
    const keepView = lastCollectorId === collectorId && world;
    lastCollectorId = collectorId;

    for (const lane of layout.lanes) for (const n of lane.nodes) n.key = helpers.keyFor(n.item, n.kind);

    world = helpers.el("div", { class: "world", style: `width:${layout.width}px;height:${layout.height}px` });
    const laneEdgeList = layout.lanes.flatMap(laneEdges);
    const connEdges = connectorEdges(layout.lanes);
    world.append(...layout.lanes.map((lane) => laneBox(lane, helpers)));
    world.append(edgeLayer(layout.width, layout.height, laneEdgeList, "flow"));
    world.append(edgeLayer(layout.width, layout.height, connEdges, "links"));
    for (const lane of layout.lanes) {
      for (const n of lane.nodes) {
        const btn = helpers.makeNode(n.item, n.kind, n.step);
        btn.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${L.nodeH}px`;
        world.append(btn);
      }
    }

    viewport = helpers.el("div", { class: "viewport", tabindex: "0", "aria-label": "Pipeline graph — drag to pan, scroll to zoom" }, world);
    const controls = helpers.el("div", { class: "zoom-controls" },
      helpers.el("button", { type: "button", title: "Zoom out", onclick: () => zoomAt(1 / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2) }, "−"),
      helpers.el("span", { class: "zoom-level" }),
      helpers.el("button", { type: "button", title: "Zoom in", onclick: () => zoomAt(1.2, viewport.clientWidth / 2, viewport.clientHeight / 2) }, "+"),
      helpers.el("button", { type: "button", title: "Show the whole graph", onclick: () => fit(true) }, "Fit"));
    const hint = helpers.el("div", { class: "graph-hint" }, "drag to pan · scroll to zoom");
    host.replaceChildren(helpers.el("div", { class: "graph-frame" }, viewport, controls, hint));
    attachPanZoom();
    if (keepView) apply(); else requestAnimationFrame(() => fit(false));
  }

  function focusPipeline(id) {
    const lane = layout && layout.lanes.find((l) => l.pipeline.id === id);
    if (!lane || !viewport) return null;
    centerOn(lane);
    return world.querySelector(`[data-pipeline="${CSS.escape(id)}"]`);
  }

  function highlightEdges(key, on) {
    if (!world) return;
    world.querySelectorAll(`path[data-from="${CSS.escape(key)}"], path[data-to="${CSS.escape(key)}"]`)
      .forEach((p) => p.classList.toggle("hl", on));
  }

  return { render, focusPipeline, highlightEdges, fit, _computeLayout: computeLayout };
})();
