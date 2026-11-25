"use strict";
/* agentviz-atc page: polls /api/agents, lays the field out (tower in the
   middle, one airport per place on a ring), eases every aircraft toward
   where its state puts it, and writes rows into atc-engine.wasm each frame
   (scene/main.cpp draws them). Labels and the panel are HTML. */

const AIRPORT_STRIDE = 8, PLANE_STRIDE = 14, LINE_STRIDE = 10;
const STATE_CODE = {offline: 0, dim: 1, idle: 2, busy: 3, waiting: 4};
const ACTION_CODE = {none: 0, edit: 1, run: 2, read: 3, web: 4, delegate: 5, think: 6, other: 7};
const ACTION_ICON = {edit: "📦", run: "🔥", read: "📡", web: "📻", delegate: "🛫", think: "⏸️", other: "✳️", none: "·"};
const ACTION_WORD = {edit: "loading cargo (edit)", run: "engines running (run)", read: "radar sweep (read)",
  web: "radio beacon (web)", delegate: "launching flights (delegate)", think: "holding at gate (think)",
  other: "busy (other)", none: "parked"};
const STATE_WORD = {busy: "working", idle: "parked, idle", waiting: "HOLDING: needs you", offline: "in the hangar (offline)",
  dim: "dim", active: "in flight", resting: "landed"};
const STACK_R = 7.5, STACK_Y0 = 12.5, STACK_DY = 1.7;

const params = new URLSearchParams(location.search);
const FIXTURE = params.get("fixture") === "1";
const FEED_URL = "/api/agents" + (FIXTURE ? "?fixture=1" : "");

function hueRgb(h, s, v) {  // as hueColor in main.cpp, sRGB-ish for the page
  const ch = (o) => { const k = (h * 6 + o) % 6; return v * (1 - s * Math.min(Math.max(Math.min(k, 4 - k), 0), 1)); };
  return [ch(5), ch(3), ch(1)];
}
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const angDiff = (a, b) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };
function fmtAge(sec) {
  if (sec == null) return "";
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  return Math.floor(sec / 3600) + "h" + String(Math.floor(sec % 3600 / 60)).padStart(2, "0");
}

class Atc {
  constructor(mod) {
    this.mod = mod;
    this.doc = null; this.snapT = 0;
    this.airports = []; this.airportById = new Map();
    this.layoutKey = "";
    this.extent = 40;
    this.agents = new Map();      // id -> {id, kind: 'session'|'follower', data, lead, disp:{x,y,z,h}, target}
    this.ptr = {};
    this.selected = null;
  }

  buf(name, floats) {
    const cap = this.ptr[name + "Cap"] || 0;
    if (floats > cap) {
      if (this.ptr[name]) this.mod._free(this.ptr[name]);
      this.ptr[name + "Cap"] = floats + 256;
      this.ptr[name] = this.mod._malloc((floats + 256) * 4);
    }
    return this.ptr[name];
  }

  /* ------------------------------------------------------------ layout */
  setDoc(doc, t) {
    this.doc = doc; this.snapT = t;
    const sessions = doc.sessions || [];
    const byPlace = new Map();
    for (const p of doc.places || []) byPlace.set(p.id, {place: p, sessions: []});
    for (const s of sessions) {
      if (!byPlace.has(s.place)) byPlace.set(s.place, {place: {id: s.place, label: s.placeLabel || s.place, seed: s.seed}, sessions: []});
      byPlace.get(s.place).sessions.push(s);
    }
    const groups = [...byPlace.values()];
    // Gate widths: a session's resting subagents park in a row behind it.
    for (const gp of groups) {
      gp.gated = gp.sessions.filter((s) => s.state !== "offline");
      gp.hangared = gp.sessions.filter((s) => s.state === "offline");
      gp.widths = gp.gated.map((s) => Math.max(5, (s.followers || []).length * 1.45 + 1.6));
      const W = gp.widths.reduce((a, b) => a + b, 0);
      gp.hw = Math.max(W / 2, 4);
      gp.foot = 2 * (gp.hw + 8.5) + 5;
    }
    const total = groups.reduce((a, g) => a + g.foot, 0);
    const R = Math.max(26, total / (2 * Math.PI));
    this.extent = R + 24;
    let acc = 0;
    const key = JSON.stringify(groups.map((g) => [g.place.id, Math.round(g.hw * 10)]));
    const waitingAt = new Map();
    for (const s of sessions) if (s.state === "waiting") waitingAt.set(s.place, (waitingAt.get(s.place) || 0) + 1);
    this.airports = groups.map((gp) => {
      const a = -Math.PI / 2 + (acc + gp.foot / 2) / total * 2 * Math.PI;
      acc += gp.foot;
      const ux = Math.cos(a), uz = Math.sin(a);
      const ap = {id: gp.place.id, label: gp.place.label || gp.place.id, seed: gp.place.seed || 0,
        cx: ux * R, cz: uz * R, ux, uz, vx: -uz, vz: ux, hw: gp.hw, waiting: waitingAt.get(gp.place.id) || 0,
        sessions: gp.sessions.length, gp};
      ap.P = (al, b) => ({x: ap.cx + ux * al + ap.vx * b, z: ap.cz + uz * al + ap.vz * b});
      return ap;
    });
    this.airportById = new Map(this.airports.map((a) => [a.id, a]));
    this.writeAirports(key !== this.layoutKey);
    this.layoutKey = key;

    // Agents: sessions and their followers, keyed by id; slots on the field.
    const seen = new Set();
    const waiting = sessions.filter((s) => s.state === "waiting")
      .sort((a, b) => (a.statusAgeSec || 0) - (b.statusAgeSec || 0));
    this.waitingOrder = waiting.map((s) => s.id);
    for (const ap of this.airports) {
      const gp = ap.gp;
      let b0 = -gp.widths.reduce((a, b) => a + b, 0) / 2;
      gp.gated.forEach((s, i) => {
        const gb = b0 + gp.widths[i] / 2; b0 += gp.widths[i];
        const slot = {kind: "gate", ap, b: gb, rank: waiting.indexOf(s)};
        if (s.state === "waiting") slot.kind = "stack";
        const lead = this.upsert(s.id, "session", s, null, slot, t);
        seen.add(s.id);
        const fl = s.followers || [];
        const resting = fl.filter((f) => f.state !== "active"), active = fl.filter((f) => f.state === "active");
        resting.forEach((f, j) => {
          const fid = s.id + "/" + f.id; seen.add(fid);
          this.upsert(fid, "follower", f, lead, {kind: "stand", ap, b: gb + (j - (resting.length - 1) / 2) * 1.45}, t);
        });
        active.forEach((f, j) => {
          const fid = s.id + "/" + f.id; seen.add(fid);
          this.upsert(fid, "follower", f, lead, {kind: "route", ap, b: gb, j, m: active.length, seed: f.seed || 0}, t);
        });
      });
      gp.hangared.forEach((s, k) => {
        seen.add(s.id);
        this.upsert(s.id, "session", s, null, {kind: "hangar", ap, b: -(gp.hw + 4.5) + (k - (gp.hangared.length - 1) / 2) * 2.0}, t);
      });
    }
    for (const id of [...this.agents.keys()]) if (!seen.has(id)) this.agents.delete(id);
    if (this.selected && !this.agents.has(this.selected)) this.selected = null;
  }

  upsert(id, kind, data, lead, slot, t) {
    let a = this.agents.get(id);
    if (!a) {
      a = {id, kind, data, lead, slot, disp: null};
      this.agents.set(id, a);
    }
    a.data = data; a.lead = lead; a.slot = slot; a.kind = kind;
    if (!a.disp) {
      const tg = this.targetOf(a, t);
      a.disp = lead && lead.disp ? Object.assign({}, lead.disp) : Object.assign({}, tg);
    }
    return a;
  }

  /* Where an agent's state puts it at scene time t. */
  targetOf(a, t) {
    const s = a.slot, ap = s.ap, toTower = Math.atan2(-ap.uz, -ap.ux);
    if (s.kind === "gate") { const p = ap.P(-0.3, s.b); return {x: p.x, y: 0.78, z: p.z, h: toTower}; }
    if (s.kind === "hangar") { const p = ap.P(-1.3, s.b); return {x: p.x, y: 0.42, z: p.z, h: toTower, scale: 0.55}; }
    if (s.kind === "stand") { const p = ap.P(2.6, s.b); return {x: p.x, y: 0.4, z: p.z, h: toTower}; }
    if (s.kind === "stack") {
      const ang = t * 0.25 + s.rank * 2.3;
      return {x: Math.cos(ang) * STACK_R, y: STACK_Y0 + s.rank * STACK_DY, z: Math.sin(ang) * STACK_R, h: ang + Math.PI / 2};
    }
    // route: out from behind the lead's gate, round a waypoint past the runway, and back.
    return this.routeAt(s, (t / (15 + s.seed * 6) + s.seed) % 1);
  }

  routePoint(s, u) {
    const ap = s.ap, spread = (s.j - (s.m - 1) / 2) * 3.4;
    const S = ap.P(4.4, s.b + spread * 0.25), O = ap.P(13 + 2.6 * (s.j % 3), s.b + spread), Hh = 3 + 0.7 * s.j;
    const mid = {x: (S.x + O.x) / 2, z: (S.z + O.z) / 2};
    const out = u < 0.5, q = out ? u * 2 : (u - 0.5) * 2;
    const side = out ? 3 : -3;
    const C = {x: mid.x + ap.vx * side, z: mid.z + ap.vz * side};
    const A = out ? S : O, B = out ? O : S;
    const x = (1 - q) * (1 - q) * A.x + 2 * (1 - q) * q * C.x + q * q * B.x;
    const z = (1 - q) * (1 - q) * A.z + 2 * (1 - q) * q * C.z + q * q * B.z;
    const y = 0.4 + Hh * (out ? Math.sin(q * Math.PI / 2) : Math.cos(q * Math.PI / 2));
    return {x, y, z};
  }

  routeAt(s, u) {
    const p = this.routePoint(s, u), n = this.routePoint(s, (u + 0.004) % 1);
    return {x: p.x, y: p.y, z: p.z, h: Math.atan2(n.z - p.z, n.x - p.x)};
  }

  /* ------------------------------------------------------------ frame */
  /* Put every aircraft where its state puts it at t (captures and tests). */
  settle(t) {
    for (const a of this.agents.values()) a.disp = Object.assign({}, this.targetOf(a, t));
  }

  step(t, dt) {
    for (const a of this.agents.values()) {
      const tg = this.targetOf(a, t);
      a.target = tg;
      const d = a.disp;
      const dx = tg.x - d.x, dy = tg.y - d.y, dz = tg.z - d.z, dist = Math.hypot(dx, dy, dz);
      if (dist > 2.5) {  // in transit (a state change moved it): fly there
        const v = clamp(dist * 1.1, 5, 18) * dt;
        d.x += dx / dist * v; d.y += dy / dist * v; d.z += dz / dist * v;
        if (Math.hypot(dx, dz) > 0.5) d.h += angDiff(d.h, Math.atan2(dz, dx)) * (1 - Math.exp(-6 * dt));
      } else {
        const k = 1 - Math.exp(-7 * dt);
        d.x += dx * k; d.y += dy * k; d.z += dz * k;
        d.h += angDiff(d.h, tg.h) * k;
      }
    }
  }

  write(t) {
    const mod = this.mod, now = t - this.snapT;
    const list = [...this.agents.values()];
    const p = this.buf("planes", list.length * PLANE_STRIDE), heap = mod.HEAPF32, base = p >> 2;
    let waitingN = 0;
    list.forEach((a, i) => {
      const d = a.data, o = base + i * PLANE_STRIDE, lead = a.lead ? a.lead.data : d;
      let state, action;
      if (a.kind === "follower") { state = d.state === "active" ? STATE_CODE.busy : STATE_CODE.idle; action = d.action; }
      else { state = STATE_CODE[d.state] != null ? STATE_CODE[d.state] : 1; action = d.action; if (d.state === "waiting") waitingN++; }
      const sel = this.selected === a.id ? 2 : (this.selected && a.lead && this.selected === a.lead.id ? 1 : 0);
      heap[o] = a.disp.x; heap[o + 1] = a.disp.y; heap[o + 2] = a.disp.z; heap[o + 3] = a.disp.h;
      heap[o + 4] = a.kind === "follower" ? 0.62 : (a.slot.kind === "hangar" ? 0.7 : (a.slot.kind === "stack" ? 1.7 : 1.3));
      heap[o + 5] = state; heap[o + 6] = ACTION_CODE[action] || 0;
      heap[o + 7] = lead.seed || 0; heap[o + 8] = sel; heap[o + 9] = d.stalled ? 1 : 0;
      heap[o + 10] = a.disp.y > 1.2 ? 1 : 0; heap[o + 11] = d.seed || 0;
      heap[o + 12] = a.slot.kind === "stack" ? a.slot.rank : -1;
      heap[o + 13] = (d.statusAgeSec || 0) + now;
    });
    mod._atc_set_planes(p, list.length);
    mod._atc_set_waiting(waitingN);
    this.writeLines(t, list);
    mod._atc_set_time(t);
  }

  writeLines(t, list) {
    const L = [];
    const seg = (a, b, c, al) => L.push(a.x, a.y, a.z, b.x, b.y, b.z, c[0], c[1], c[2], al);
    const red = [1, 0.15, 0.08];
    for (const a of list) {
      if (a.kind === "follower" && a.slot.kind === "route") {
        const c = hueRgb(a.lead.data.seed || 0, 0.6, 1);
        const hl = this.selected && (this.selected === a.id || this.selected === a.lead.id);
        const n = 40;
        for (let k = 0; k < n; k += 2) seg(this.routePoint(a.slot, k / n), this.routePoint(a.slot, (k + 1) / n), c, hl ? 0.9 : 0.35);
      }
      if (a.slot.kind === "stack") {
        // Its orbit round the tower, and a dashed line home to its empty gate.
        const y = STACK_Y0 + a.slot.rank * STACK_DY, n = 48;
        for (let k = 0; k < n; k++) {
          const a0 = k / n * 2 * Math.PI, a1 = (k + 1) / n * 2 * Math.PI;
          seg({x: Math.cos(a0) * STACK_R, y, z: Math.sin(a0) * STACK_R}, {x: Math.cos(a1) * STACK_R, y, z: Math.sin(a1) * STACK_R}, red, 0.35);
        }
        const g = a.slot.ap.P(-0.3, a.slot.b), from = a.disp, n2 = 16;
        for (let k = 0; k < n2; k += 2) {
          const u0 = k / n2, u1 = (k + 1) / n2;
          seg({x: from.x + (g.x - from.x) * u0, y: from.y + (0.1 - from.y) * u0, z: from.z + (g.z - from.z) * u0},
              {x: from.x + (g.x - from.x) * u1, y: from.y + (0.1 - from.y) * u1, z: from.z + (g.z - from.z) * u1}, red, 0.6);
        }
        const pulse = 1.2 + 0.4 * Math.sin(t * 5);
        for (let k = 0; k < 24; k++) {
          const a0 = k / 24 * 2 * Math.PI, a1 = (k + 1) / 24 * 2 * Math.PI;
          seg({x: g.x + Math.cos(a0) * pulse, y: 0.08, z: g.z + Math.sin(a0) * pulse},
              {x: g.x + Math.cos(a1) * pulse, y: 0.08, z: g.z + Math.sin(a1) * pulse}, red, 0.9);
        }
      }
    }
    const n = L.length / LINE_STRIDE, p = this.buf("lines", L.length);
    this.mod.HEAPF32.set(L, p >> 2);
    this.mod._atc_set_lines(p, n);
  }

  writeAirports(rebuild) {
    const rows = [];
    for (const ap of this.airports) rows.push(ap.cx, ap.cz, ap.ux, ap.uz, ap.hw, ap.seed, ap.waiting, ap.sessions);
    const p = this.buf("airports", rows.length);
    this.mod.HEAPF32.set(rows, p >> 2);
    if (rebuild) this.mod._atc_set_airports(p, this.airports.length, this.extent);
    else this.mod._atc_update_airports(p, this.airports.length);
  }

  pick(sx, sy, radius, project) {
    let best = null, bestD = radius * radius;
    for (const a of this.agents.values()) {
      const s = a.kind === "follower" ? 0.62 : 1.3;
      for (const f of [-1, 0, 1]) {
        const q = project(a.disp.x + Math.cos(a.disp.h) * f * s, a.disp.y, a.disp.z + Math.sin(a.disp.h) * f * s);
        if (!q) continue;
        const d = (q.x - sx) ** 2 + (q.y - sy) ** 2;
        if (d < bestD) { bestD = d; best = a; }
      }
    }
    return best;
  }
}

/* ================================================================ page */
const $ = (id) => document.getElementById(id);
const labelsEl = $("labels");
let atc = null, kit = null, lastT = 0;
const labelEls = new Map();
let camGoal = null;

function labelFor(key, cls) {
  let el = labelEls.get(key);
  if (!el) {
    el = document.createElement("div");
    el.className = "label " + (cls || "");
    labelsEl.appendChild(el);
    labelEls.set(key, el);
  }
  if (cls != null && el._cls !== cls) {  // keep the kit's sk-label-off
    const off = el.classList.contains("sk-label-off");
    el.className = "label " + cls + (off ? " sk-label-off" : "");
    el._cls = cls;
  }
  el._used = true;
  return el;
}

function placeLabels() {
  const items = [];
  for (const el of labelEls.values()) el._used = false;
  for (const ap of atc.airports) {
    const el = labelFor("ap:" + ap.id, "airport" + (ap.waiting ? " alert" : ""));
    const txt = "🛬 " + ap.label;
    if (el.textContent !== txt) el.textContent = txt;
    const p = ap.P(-4.8, 0);
    items.push({el, q: kit.project(p.x, 3.8, p.z), rank: 1});
  }
  const now = lastT - atc.snapT;
  for (const a of atc.agents.values()) {
    const d = a.data;
    const sel = atc.selected === a.id;
    const leadSel = a.lead && atc.selected === a.lead.id;
    if (a.kind === "follower" && !sel && !leadSel) continue;
    let cls = a.kind === "follower" ? "follower" : "session", txt;
    if (a.kind === "follower") txt = (ACTION_ICON[d.action] || "") + " " + (d.label || "subagent");
    else if (d.state === "waiting") { cls += " wait"; txt = "⏱ " + (d.name || "session") + " · " + fmtAge((d.statusAgeSec || 0) + now); }
    else txt = (d.name || "session") + (d.stalled ? " ⚠" : "");
    if (d.state === "offline") cls += " off";
    if (sel) cls += " sel";
    const el = labelFor("a:" + a.id, cls);
    if (el.textContent !== txt) el.textContent = txt;
    const s = a.kind === "follower" ? 0.62 : 1.3;
    const rank = sel || d.state === "waiting" ? 0 : (a.kind === "follower" ? (d.state === "active" ? 3 : 2) : 2);
    items.push({el, q: kit.project(a.disp.x, a.disp.y + 1.5 * s, a.disp.z), rank});
  }
  for (const [k, el] of labelEls) if (!el._used) { el.remove(); labelEls.delete(k); }
  StrataKit.placeLabels(items);
}

function select(id, focus) {
  atc.selected = id && atc.agents.has(id) ? id : null;
  kit.selected = atc.selected;
  if (focus && atc.selected) camGoal = atc.selected;
  renderPanel();
}

function renderPanel() {
  const panel = $("panel");
  const a = atc.selected && atc.agents.get(atc.selected);
  if (!a) { panel.hidden = true; document.body.classList.remove("sheet-open"); return; }
  panel.hidden = false; document.body.classList.add("sheet-open");
  const d = a.data, now = lastT - atc.snapT;
  const lead = a.lead ? a.lead.data : null;
  const state = a.kind === "follower" ? d.state : d.state;
  $("p-name").textContent = a.kind === "follower" ? (d.label || "subagent") : (d.name || "session");
  $("p-icon").textContent = a.kind === "follower" ? "🛩️" : (d.state === "waiting" ? "🛬" : (d.state === "offline" ? "🏚️" : "✈️"));
  const chip = $("p-state");
  chip.textContent = (STATE_WORD[state] || state) + (d.stalled ? " · STALLED" : "");
  chip.className = "chip st-" + state + (d.stalled ? " st-stalled" : "");
  const act = (a.kind === "follower" && d.state !== "active") ? "none" : (d.action || "none");
  $("p-action").textContent = d.state === "waiting" ? "🛬 circling the tower until you answer"
    : (ACTION_ICON[act] || "") + " " + (ACTION_WORD[act] || act);
  const rows = [];
  const add = (k, v) => { if (v != null && v !== "") rows.push([k, v]); };
  if (a.kind === "follower") {
    add("Lead", lead && lead.name); add("Tool", d.tool && (d.tool + (d.toolLabel ? " · " + d.toolLabel : "")));
    add("Tool calls", d.toolCount); add("Quiet", fmtAge(d.quietSec));
  } else {
    add("Label", d.activity && d.activity.label); add("Branch", d.branch); add("Airport", d.placeLabel || d.place);
    if (d.state === "waiting") add("Holding for", fmtAge((d.statusAgeSec || 0) + now));
    else add("In state for", fmtAge((d.statusAgeSec || 0) + now));
  }
  const dl = $("p-rows");
  dl.replaceChildren();
  for (const [k, v] of rows) {
    dl.append(Object.assign(document.createElement("dt"), {textContent: k}), Object.assign(document.createElement("dd"), {textContent: String(v)}));
  }
  const ul = $("p-followers");
  ul.replaceChildren();
  const fl = a.kind === "follower" ? [] : (d.followers || []);
  $("p-fhead").hidden = !fl.length;
  if (fl.length) $("p-fhead").textContent = "Flights out (" + fl.filter((f) => f.state === "active").length + " in the air, " + fl.length + " in all)";
  for (const f of fl) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = (f.state === "active" ? (ACTION_ICON[f.action] || "🛩️") : "🅿️") + " " + (f.label || f.id);
    btn.title = f.state === "active" ? ACTION_WORD[f.action] : "landed";
    btn.onclick = () => select(d.id + "/" + f.id, true);
    li.append(btn); ul.append(li);
  }
  $("p-lead").hidden = !a.lead;
  $("p-lead").onclick = () => a.lead && select(a.lead.id, true);
}

function renderTop() {
  const w = atc.waitingOrder || [];
  const chip = $("holding");
  if (w.length) {
    chip.className = "alert";
    chip.textContent = "🛬 " + w.length + " holding · needs you";
  } else {
    chip.className = "clear";
    chip.textContent = "🟢 all clear";
  }
  const c = (atc.doc && atc.doc.counts) || {};
  $("counts").textContent = `✈️ ${c.busy || 0}  🅿️ ${c.idle || 0}  🛩️ ${c.activeFollowers || 0}  🏚️ ${c.offline || 0}`;
}

async function poll() {
  try {
    const r = await fetch(FEED_URL, {cache: "no-store"});
    if (r.ok) {
      const doc = await r.json();
      atc.setDoc(doc, lastT);
      renderTop();
      renderPanel();
      $("demo").hidden = !doc.fixture;
    }
  } catch (e) { /* keep the last snapshot */ }
}

(async () => {
  let mod;
  try {
    mod = await StrataLoader.load({script: "atc-engine.js", factory: "createAtcEngine", wasm: "atc-engine.wasm",
      title: "air traffic control"});
  } catch (e) { return; }
  const canvas = $("view");
  atc = new Atc(mod);
  try {
    kit = StrataKit.create({
      module: mod, canvas,
      camera: {yaw: 2.2, pitch: 0.72, dist: 64, tx: 0, ty: 3, tz: 0},
      limits: {maxDist: 180, minDist: 6},
      pick: (x, y, r) => atc.pick(x, y, r, kit.project),
      idOf: (a) => a.id,
      onTap(a) { select(a ? a.id : null, false); },
      frame(t, now, dt) {
        lastT = t;
        atc.step(t, dt || 0);
        if (camGoal) {
          const a = atc.agents.get(camGoal);
          if (!a) camGoal = null;
          else {
            const k = 1 - Math.exp(-3 * (dt || 0.016));
            kit.cam.tx += (a.disp.x - kit.cam.tx) * k; kit.cam.tz += (a.disp.z - kit.cam.tz) * k;
            kit.cam.ty += (a.disp.y - kit.cam.ty) * k;
            kit.cam.dist += (Math.max(22, Math.min(kit.cam.dist, 40)) - kit.cam.dist) * k;
            if (Math.hypot(a.disp.x - kit.cam.tx, a.disp.z - kit.cam.tz) < 0.3) camGoal = null;
          }
        }
        atc.write(t);
      },
      after() { placeLabels(); if (atc.selected && Math.floor(lastT * 2) !== renderPanel._t) { renderPanel._t = Math.floor(lastT * 2); renderPanel(); } },
      onSlow: () => StrataLoader.slow(),
      onFatal: (code, msg) => StrataLoader.fallback(code, msg),
      targets: () => [...atc.agents.values()].map((a) => {
        const s = kit.project(a.disp.x, a.disp.y, a.disp.z), r = canvas.getBoundingClientRect();
        return s && {id: a.id, x: s.x + r.left, y: s.y + r.top};
      }).filter(Boolean),
    });
  } catch (e) {
    return StrataLoader.fallback(e.code === "no-webgl2" ? "no-webgl2" : "engine");
  }
  canvas.addEventListener("pointerdown", () => { camGoal = null; });
  // A fixed dusk sun, so the field's lights carry it and captures repeat.
  kit.setSun(Date.UTC(2026, 5, 21, 0, 40, 0) / 1000, 40, -105);
  await poll();
  setInterval(poll, 2000);
  $("holding").onclick = () => {
    const w = atc.waitingOrder || [];
    if (!w.length) return;
    const i = (w.indexOf(atc.selected) + 1) % w.length;
    select(w[w.length - 1 - i], true);
  };
  $("p-close").onclick = () => select(null);
  $("help").onclick = () => { $("legend").hidden = !$("legend").hidden; };
  kit.start();
  if (kit.driven) kit.drive(0);
  StrataLoader.done();
  window.__atc = {atc, kit, select, ready: true,
    focus(id, dist, yaw, pitch) {
      const a = atc.agents.get(id); if (!a) return false;
      Object.assign(kit.cam, {tx: a.disp.x, ty: a.disp.y, tz: a.disp.z});
      if (dist) kit.cam.dist = dist; if (yaw != null) kit.cam.yaw = yaw; if (pitch != null) kit.cam.pitch = pitch;
      return true;
    }};
  canvas.focus({preventScroll: true});
})();
