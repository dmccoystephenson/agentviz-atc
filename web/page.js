/* page.js: boots the airfield. The feed client, HUD, labels and wire come
   from the agentviz kit (agentviz-*.js); this file wires them to AtcField and
   the Strata kit, and owns the camera and the world labels. */
(function () {
  "use strict";
  const REASON = {question: "has a question", permission: "needs permission"};
  const DEFAULT_YAW = 2.2, DEFAULT_PITCH = 0.72, PORTRAIT_PITCH = 0.98;
  const canvas = document.getElementById("view");
  const field = new window.AtcField();
  const wire = AgentvizWire.create();
  const labels = AgentvizScreen.labels(document.getElementById("labels"));
  let kit = null, mod = null, feed = null, selectedId = null, hoveredId = null, follow = null, fitted = false, lastT = 0;

  function formatAge(sec) {
    if (sec == null) return "";
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    return Math.floor(s / 3600) + "h" + String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  }
  const ageOf = (data) => (data.statusAgeSec || 0) + (lastT - field.snapT);

  /* ------------------------------------------------------------ camera */
  // The whole field, whatever the window's shape. The target sits a little
  // towards the camera: perspective makes the near edge of the ring the widest.
  // On a portrait screen the camera looks down more steeply, so the ring
  // fills more of the tall view and its labels spread out.
  function fitView() {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const pitch = aspect < 1 ? PORTRAIT_PITCH : DEFAULT_PITCH;
    const toward = field.extent * (aspect < 1 ? 0.08 : 0.16);
    return {yaw: DEFAULT_YAW, pitch, ty: 3,
      tx: Math.cos(DEFAULT_YAW) * toward, tz: Math.sin(DEFAULT_YAW) * toward,
      dist: Math.min(220, field.extent * 1.45 * Math.max(1, 1.5 / aspect))};
  }
  function fit() { follow = null; if (kit) Object.assign(kit.cam, fitView()); }

  // The bottom sheet (a phone) covers the lower half of the field: there the
  // selected aircraft is framed in the clear band between the top bar and
  // the sheet instead of in the middle of the canvas.
  function sheetOpen() { const p = hud.panelRect(); return !!p && p.sheet; }
  function followTarget(p) {
    if (!sheetOpen()) return {tx: p.x, tz: p.z};
    return AgentvizScreen.reveal(kit.cam, p, hud.freeRect(canvas), {force: true, dy: 0});
  }

  // Glide the camera after an aircraft until it is framed (it may be moving).
  function stepFollow(dt) {
    if (!follow) return;
    const a = field.agents.get(follow);
    if (!a) { follow = null; return; }
    const k = 1 - Math.exp(-3 * dt), cam = kit.cam, goal = followTarget(a.disp), gx = goal.tx, gz = goal.tz;
    cam.tx += (gx - cam.tx) * k; cam.ty += (a.disp.y - cam.ty) * k; cam.tz += (gz - cam.tz) * k;
    cam.dist += (Math.max(22, Math.min(cam.dist, 40)) - cam.dist) * k;
    if (Math.hypot(gx - cam.tx, gz - cam.tz) < 0.3 && Math.abs(cam.dist - Math.max(22, Math.min(cam.dist, 40))) < 0.5) follow = null;
  }

  /* ------------------------------------------------------------ labels */
  function leadLabel(a) {
    const s = a.data, waiting = s.state === "waiting", selected = a.id === selectedId;
    const text = waiting ? (s.name || s.id) + " " + (REASON[s.waitingReason] || "needs you") + " · " + formatAge(ageOf(s))
      : s.name || s.id.slice(0, 6);
    const cls = "lead" + (waiting ? " waiting" : "") + (s.state === "offline" ? " offline" : "") + (selected ? " sel" : "");
    const el = labels.set("a:" + a.id, {cls, state: s.stalled ? "stalled" : s.state, action: s.state === "busy" ? s.action : null, text});
    return {el, rank: selected || waiting ? 0 : 2, tries: 3};  // a lead may step up over a crowded gate
  }

  // Subagents are labelled while they or their lead are selected, and a
  // stalled one always (it may need a look).
  function followerLabel(a) {
    const f = a.data, selected = a.id === selectedId;
    if (!selected && a.leadAgent.id !== selectedId && !f.stalled) return null;
    const el = labels.set("a:" + a.id, {cls: "sub" + (selected ? " sel" : ""), state: f.stalled ? "stalled" : null,
      action: f.state === "active" ? f.action : "none", text: f.label || f.id});
    return {el, rank: selected ? 0 : f.state === "active" ? 3 : 2};
  }

  // As scene/airport.h draws it: taller with more tool calls, a beacon on top.
  const terminalTop = (ap) => 1.5 * (1 + 0.5 * Math.log10(1 + ap.toolCount)) + 1.9;

  function placeLabels() {
    const items = [];
    labels.begin();
    for (const ap of field.airports) {
      const el = labels.set("p:" + ap.id, {cls: "place" + (ap.waiting ? " alert" : ""), text: "🛬 " + ap.label});
      const p = ap.at(-4.8, 0);
      items.push({el, q: kit.project(p.x, terminalTop(ap) + 1.2, p.z), rank: 1});
    }
    for (const a of field.agents.values()) {
      const item = a.lead ? leadLabel(a) : followerLabel(a);
      if (!item) continue;
      // Over a holding aircraft the label clears its beacon and the "?" or padlock.
      const lift = a.slot.kind === "stack" ? 2.7 : 1.5;
      item.q = kit.project(a.disp.x, a.disp.y + lift * field.scaleOf(a), a.disp.z);
      items.push(item);
    }
    labels.end();
    // No world label under the top bar, the panel or the legend. A label that
    // must stay (rank 0: holding or selected) drops just below the bar instead.
    hud.placeLabels(items, {canvas});
  }

  /* ------------------------------------------------------------ picking + selection */
  // Nose, middle and tail of every aircraft.
  function pick(x, y, radius) {
    const candidates = [...field.agents.values()].map((a) => {
      const d = a.disp, s = field.scaleOf(a), points = [];
      for (const f of [-1, 0, 1]) points.push([d.x + Math.cos(d.h) * f * s, d.y, d.z + Math.sin(d.h) * f * s]);
      return {item: a, points};
    });
    return AgentvizScreen.pick(kit.project, candidates, x, y, radius);
  }
  const targetOf = (a) => (a ? {session: a.session, follower: a.follower} : null);
  const idOf = (target) => (target ? (target.follower ? AgentvizFeed.followerKey(target.session, target.follower) : target.session.id) : null);

  function onSelect(target, how) {
    selectedId = idOf(target);
    const a = selectedId && field.agents.get(selectedId);
    if (kit) kit.selected = a || null;
    // A tap on a phone glides the aircraft clear of the sheet that just opened.
    if (a && (how === "list" || how === "waiting" || (how === "tap" && sheetOpen()))) follow = a.id;
  }

  // ATC's own rows under the kit's: how long in this state, where it sits.
  function panelRows({session, follower}) {
    if (follower) return [["quiet", formatAge(follower.quietSec)]];
    const a = field.agents.get(session.id);
    const where = !a ? null : {stack: "holding stack, round the tower", gate: "at its gate", hangar: "in the hangar"}[a.slot.kind];
    return [[session.state === "waiting" ? "holding for" : "in state for", formatAge(session.statusAgeSec)], ["where", where]];
  }

  const hud = AgentvizHud.create({
    title: "Air traffic control",
    legend: document.getElementById("legend"),
    buttons: [{icon: "home", label: "Show the whole field", onClick: fit}],
    onSelect,
    rows: panelRows,
    oneRow: true,
  });

  function accept(doc) {
    field.update(doc, lastT);
    hud.update(doc);
    if (!fitted) { fitted = true; fit(); }
  }

  /* ------------------------------------------------------------ boot */
  function frame(t, now, dt) {
    lastT = t;
    if (!field.doc) return;
    field.step(t, dt || 0);
    stepFollow(dt || 0.016);
    const look = {highlight: (id) => (id === selectedId ? 1 : id === hoveredId ? 2 : 0), pulse: feed.pulse};
    window.AtcFrame.write(wire, field, t, look).send(mod);
  }

  function screenTargets() {
    const r = canvas.getBoundingClientRect();
    return [...field.agents.values()].map((a) => {
      const s = kit.project(a.disp.x, a.disp.y, a.disp.z);
      return s && {id: a.id, x: s.x + r.left, y: s.y + r.top};
    }).filter(Boolean);
  }

  function createKit() {
    return StrataKit.create({
      module: mod, canvas,
      camera: {yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, dist: 64, tx: 0, ty: 3, tz: 0},
      limits: {maxDist: 240, minDist: 6},
      frame,
      after: () => { if (field.doc) placeLabels(); },
      pick,
      idOf: (a) => a.id,
      onTap: (a) => hud.select(targetOf(a), "tap"),
      onHover(a) { hoveredId = a ? a.id : null; canvas.style.cursor = a ? "pointer" : ""; },
      onSlow: () => StrataLoader.slow(),
      onFatal: (code, msg) => StrataLoader.fallback(code, msg),
      targets: screenTargets,
    });
  }

  async function boot() {
    try {
      mod = await StrataLoader.load({script: "atc-engine.js", factory: "createAtcEngine", wasm: "atc-engine.wasm",
        title: "air traffic control"});
    } catch (error) {
      console.error("atc: the engine did not load", error);
      return;  // StrataLoader has already shown its fallback
    }
    try {
      kit = createKit();
    } catch (error) {
      StrataLoader.fallback(error.code === "no-webgl2" ? "no-webgl2" : "engine");
      return;
    }
    canvas.addEventListener("pointerdown", () => { follow = null; });
    // A fixed dusk sun, so the field's lights carry it and captures repeat.
    kit.setSun(Date.UTC(2026, 5, 21, 0, 40, 0) / 1000, 40, -105);
    feed = AgentvizFeed.create({onUpdate: accept, onStatus: hud.setStatus});
    window.__page = {kit, field, hud, fit,
      select: (id, focus) => hud.select(targetOf(field.agents.get(id)), focus ? "list" : "api"),
      get selectedId() { return selectedId; },
      get doc() { return feed.doc; }, get polls() { return feed.polls; },
      stopPolling: () => feed.stop(), pollOnce: () => feed.pollOnce(), feed: (d) => feed.push(d)};
    feed.start();
    kit.start();
    if (kit.driven) kit.drive(0);
    StrataLoader.done();
    canvas.focus({preventScroll: true});
  }

  boot();
})();
