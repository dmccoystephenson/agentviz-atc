/* atc-field.js: the airfield model. Lays the field out from each feed
   snapshot (the tower in the middle, one airport per place on a ring round
   it, gates along each apron), keys every aircraft by id and eases it toward
   where its state puts it. Knows nothing about the DOM or the engine:
   atc-frame.js packs it for the scene, page.js draws the HTML around it.

     const field = new AtcField();
     field.update(doc, t);   // after every feed snapshot
     field.step(t, dt);      // every frame
     field.settle(t);        // captures: put every aircraft on its target now

   Classic script: window.AtcField. Needs AgentvizFeed. */
(function () {
  "use strict";
  const {followerKey} = window.AgentvizFeed;

  const STACK = {radius: 7.5, y0: 12.5, dy: 1.7};    // the holding stack round the tower
  const GATE_MIN = 5, STAND_STEP = 1.45, GATE_PAD = 1.6;
  const RING_MIN = 26, FIELD_MARGIN = 24;
  const SCALE = {lead: 1.3, stack: 1.7, hangar: 0.7, follower: 0.62};

  const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
  function angleDiff(a, b) {
    let d = (b - a) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }
  function quadratic(a, c, b, q) {
    return {x: (1 - q) * (1 - q) * a.x + 2 * (1 - q) * q * c.x + q * q * b.x,
      z: (1 - q) * (1 - q) * a.z + 2 * (1 - q) * q * c.z + q * q * b.z};
  }

  /* ------------------------------------------------------------ airports */

  // Sessions grouped by place, in the feed's place order.
  function groupByPlace(doc) {
    const byPlace = new Map();
    for (const place of doc.places || []) byPlace.set(place.id, {place, sessions: []});
    for (const s of doc.sessions || []) {
      if (!byPlace.has(s.place)) byPlace.set(s.place, {place: {id: s.place, label: s.placeLabel || s.place, seed: s.seed}, sessions: []});
      byPlace.get(s.place).sessions.push(s);
    }
    return [...byPlace.values()];
  }

  // Gate widths: a session's resting subagents park in a row behind it.
  function measureGroup(group) {
    group.gated = group.sessions.filter((s) => s.state !== "offline");
    group.hangared = group.sessions.filter((s) => s.state === "offline");
    group.widths = group.gated.map((s) => Math.max(GATE_MIN, (s.followers || []).length * STAND_STEP + GATE_PAD));
    group.halfWidth = Math.max(group.widths.reduce((a, b) => a + b, 0) / 2, 4);
    group.footprint = 2 * (group.halfWidth + 8.5) + 5;
  }

  function makeAirport(group, angle, ringRadius) {
    const ux = Math.cos(angle), uz = Math.sin(angle);
    const place = group.place;
    const airport = {id: place.id, label: place.label || place.id, seed: place.seed || 0, toolCount: place.toolCount || 0,
      cx: ux * ringRadius, cz: uz * ringRadius, ux, uz, vx: -uz, vz: ux, halfWidth: group.halfWidth,
      waiting: group.sessions.filter((s) => s.state === "waiting").length, sessions: group.sessions.length, group};
    // A point `along` out from the tower and `side` along the apron.
    airport.at = (along, side) => ({x: airport.cx + ux * along + airport.vx * side, z: airport.cz + uz * along + airport.vz * side});
    return airport;
  }

  function layOutAirports(groups) {
    groups.forEach(measureGroup);
    const total = groups.reduce((a, g) => a + g.footprint, 0);
    const ringRadius = Math.max(RING_MIN, total / (2 * Math.PI));
    let acc = 0;
    const airports = groups.map((group) => {
      const angle = -Math.PI / 2 + (acc + group.footprint / 2) / total * 2 * Math.PI;
      acc += group.footprint;
      return makeAirport(group, angle, ringRadius);
    });
    return {airports, extent: ringRadius + FIELD_MARGIN,
      key: JSON.stringify(groups.map((g) => [g.place.id, Math.round(g.halfWidth * 10)]))};
  }

  /* ------------------------------------------------------------ field */

  class AtcField {
    constructor() {
      this.doc = null;
      this.snapT = 0;
      this.airports = [];
      this.airportById = new Map();
      this.extent = 40;
      this.layoutKey = "";
      this.layoutSerial = 0;    // bumps when the airports move or resize: the scene rebuilds its terrain
      this.agents = new Map();  // id -> {id, lead, session, follower, data, leadAgent, slot, disp}
      this.waitingOrder = [];
    }

    update(doc, t) {
      this.doc = doc;
      this.snapT = t;
      const layout = layOutAirports(groupByPlace(doc));
      this.airports = layout.airports;
      this.airportById = new Map(this.airports.map((a) => [a.id, a]));
      this.extent = layout.extent;
      if (layout.key !== this.layoutKey) { this.layoutKey = layout.key; this.layoutSerial++; }
      // Holding order: the longest wait sits highest.
      this.waitingOrder = (doc.sessions || []).filter((s) => s.state === "waiting")
        .sort((a, b) => (a.statusAgeSec || 0) - (b.statusAgeSec || 0)).map((s) => s.id);
      const seen = new Set();
      for (const airport of this.airports) this.placeAirport(airport, seen, t);
      for (const id of [...this.agents.keys()]) if (!seen.has(id)) this.agents.delete(id);
    }

    placeAirport(airport, seen, t) {
      const group = airport.group;
      let side = -group.widths.reduce((a, b) => a + b, 0) / 2;
      group.gated.forEach((session, i) => {
        const gate = side + group.widths[i] / 2;
        side += group.widths[i];
        const rank = this.waitingOrder.indexOf(session.id);
        const slot = {kind: session.state === "waiting" ? "stack" : "gate", airport, side: gate, rank};
        const lead = this.upsert(session, null, null, slot, t, seen);
        this.placeFollowers(session, lead, airport, gate, t, seen);
      });
      group.hangared.forEach((session, k) => {
        const spot = -(group.halfWidth + 4.5) + (k - (group.hangared.length - 1) / 2) * 2.0;
        this.upsert(session, null, null, {kind: "hangar", airport, side: spot}, t, seen);
      });
    }

    placeFollowers(session, lead, airport, gate, t, seen) {
      const followers = session.followers || [];
      const resting = followers.filter((f) => f.state !== "active"), active = followers.filter((f) => f.state === "active");
      resting.forEach((f, j) => {
        const side = gate + (j - (resting.length - 1) / 2) * STAND_STEP;
        this.upsert(session, f, lead, {kind: "stand", airport, side}, t, seen);
      });
      active.forEach((f, j) => {
        this.upsert(session, f, lead, {kind: "route", airport, side: gate, index: j, count: active.length, seed: f.seed || 0}, t, seen);
      });
    }

    upsert(session, follower, leadAgent, slot, t, seen) {
      const id = follower ? followerKey(session, follower) : session.id;
      seen.add(id);
      let agent = this.agents.get(id);
      if (!agent) { agent = {id, disp: null}; this.agents.set(id, agent); }
      Object.assign(agent, {lead: !follower, session, follower, data: follower || session, leadAgent, slot});
      if (!agent.disp) {
        // A new subagent takes off from its lead; anything else appears where it belongs.
        agent.disp = Object.assign({}, leadAgent && leadAgent.disp ? leadAgent.disp : this.targetOf(agent, t));
      }
      return agent;
    }

    /* ---------------------------------------------------------- where things go */

    // Where an agent's state puts it at scene time t: {x, y, z, h (heading)}.
    targetOf(agent, t) {
      const slot = agent.slot, airport = slot.airport, toTower = Math.atan2(-airport.uz, -airport.ux);
      const parked = (along, y) => { const p = airport.at(along, slot.side); return {x: p.x, y, z: p.z, h: toTower}; };
      switch (slot.kind) {
        case "gate": return parked(-0.3, 0.78);
        case "hangar": return parked(-1.3, 0.42);
        case "stand": return parked(2.6, 0.4);
        case "stack": {
          const angle = t * 0.25 + slot.rank * 2.3;
          return {x: Math.cos(angle) * STACK.radius, y: STACK.y0 + slot.rank * STACK.dy, z: Math.sin(angle) * STACK.radius,
            h: angle + Math.PI / 2};
        }
        default: return this.routeAt(slot, (t / (15 + slot.seed * 6) + slot.seed) % 1);
      }
    }

    // A subagent's loop: out from behind its lead's gate, round a waypoint
    // past the runway, and back. u runs 0..1 round the loop.
    routePoint(slot, u) {
      const airport = slot.airport, spread = (slot.index - (slot.count - 1) / 2) * 3.4;
      const start = airport.at(4.4, slot.side + spread * 0.25);
      const turn = airport.at(13 + 2.6 * (slot.index % 3), slot.side + spread);
      const height = 3 + 0.7 * slot.index;
      const outbound = u < 0.5, q = outbound ? u * 2 : (u - 0.5) * 2, bow = outbound ? 3 : -3;
      const control = {x: (start.x + turn.x) / 2 + airport.vx * bow, z: (start.z + turn.z) / 2 + airport.vz * bow};
      const p = outbound ? quadratic(start, control, turn, q) : quadratic(turn, control, start, q);
      const y = 0.4 + height * (outbound ? Math.sin(q * Math.PI / 2) : Math.cos(q * Math.PI / 2));
      return {x: p.x, y, z: p.z};
    }

    routeAt(slot, u) {
      const p = this.routePoint(slot, u), next = this.routePoint(slot, (u + 0.004) % 1);
      return {x: p.x, y: p.y, z: p.z, h: Math.atan2(next.z - p.z, next.x - p.x)};
    }

    gateOf(agent) { return agent.slot.airport.at(-0.3, agent.slot.side); }

    scaleOf(agent) {
      if (!agent.lead) return SCALE.follower;
      return agent.slot.kind === "hangar" ? SCALE.hangar : agent.slot.kind === "stack" ? SCALE.stack : SCALE.lead;
    }

    /* ---------------------------------------------------------- motion */

    // Captures and tests: every aircraft exactly on its target at t.
    settle(t) {
      for (const agent of this.agents.values()) agent.disp = Object.assign({}, this.targetOf(agent, t));
    }

    step(t, dt) {
      for (const agent of this.agents.values()) moveToward(agent.disp, this.targetOf(agent, t), dt);
    }
  }

  // Far off (a state change moved it): fly there at a capped speed, turning
  // into the flight path. Close: ease onto the target and its heading.
  function moveToward(d, target, dt) {
    const dx = target.x - d.x, dy = target.y - d.y, dz = target.z - d.z, dist = Math.hypot(dx, dy, dz);
    if (dist > 2.5) {
      const v = clamp(dist * 1.1, 5, 18) * dt;
      d.x += dx / dist * v; d.y += dy / dist * v; d.z += dz / dist * v;
      if (Math.hypot(dx, dz) > 0.5) d.h += angleDiff(d.h, Math.atan2(dz, dx)) * (1 - Math.exp(-6 * dt));
      return;
    }
    const k = 1 - Math.exp(-7 * dt);
    d.x += dx * k; d.y += dy * k; d.z += dz * k;
    d.h += angleDiff(d.h, target.h) * k;
  }

  AtcField.STACK = STACK;
  window.AtcField = AtcField;
})();
