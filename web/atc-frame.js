/* atc-frame.js: packs the airfield for the scene, once a frame, in the
   agentviz wire format (vendor/agentviz-kit, docs/KIT.md there).
   scene/main.cpp and its headers read what is written here.

     scene floats  0 field half extent, 1 layout serial (a change repaints the terrain),
                   2..4 the holding stack: radius, lowest height, height step
     zones         kind 0 airport. Rect: its footprint. Extras: centre x, z, unit vector
                   out from the tower x, z, apron half width, sessions waiting, sessions,
                   tool calls seen there (a busier airport has a taller terminal)
     agents        extras: scale, airborne (0/1), holding rank (-1 when not holding),
                   seconds in this state, gate x, gate z, family selected (0/1)
     links         kind 0 one dash of a subagent's flight loop (seed = the lead's seed),
                   kind 1 a holding aircraft's line home to its empty gate

   Classic script: window.AtcFrame. */
(function () {
  "use strict";
  const ZONE = {airport: 0};
  const LINK = {route: 0, home: 1};
  const ROUTE_DASHES = 20;
  const STACK = window.AtcField.STACK;

  function airportZone(wire, airport) {
    const reach = airport.halfWidth + 9;
    const corners = [airport.at(-6, -reach), airport.at(-6, reach), airport.at(9, -reach), airport.at(9, reach)];
    const xs = corners.map((p) => p.x), zs = corners.map((p) => p.z);
    wire.zone({id: "ap:" + airport.id, kind: ZONE.airport, seed: airport.seed,
      x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs),
      extra: [airport.cx, airport.cz, airport.ux, airport.uz, airport.halfWidth, airport.waiting, airport.sessions,
        airport.toolCount]});
  }

  function agentRecord(wire, field, agent, t, look) {
    const d = agent.disp, gate = field.gateOf(agent);
    const age = (agent.data.statusAgeSec || 0) + (t - field.snapT);
    wire.agent({session: agent.session, follower: agent.follower, x: d.x, y: d.y, z: d.z, facing: d.h,
      highlight: look.highlight(agent.id), pulse: look.pulse(agent.id),
      extra: [field.scaleOf(agent), d.y > 1.2 ? 1 : 0, agent.slot.kind === "stack" ? agent.slot.rank : -1, age,
        gate.x, gate.z, agent.leadAgent && look.highlight(agent.leadAgent.id) === 1 ? 1 : 0]});
  }

  // Every other dash of a subagent's loop.
  function routeDashes(wire, field, agent, alpha) {
    for (let k = 0; k < ROUTE_DASHES * 2; k += 2) {
      const p0 = field.routePoint(agent.slot, k / (ROUTE_DASHES * 2)), p1 = field.routePoint(agent.slot, (k + 1) / (ROUTE_DASHES * 2));
      wire.link({kind: LINK.route, from: agent.id, x0: p0.x, y0: p0.y, z0: p0.z, x1: p1.x, y1: p1.y, z1: p1.z,
        seed: agent.session.seed || 0, alpha});
    }
  }

  function homeLine(wire, field, agent) {
    const d = agent.disp, gate = field.gateOf(agent);
    wire.link({kind: LINK.home, from: agent.id, x0: d.x, y0: d.y, z0: d.z, x1: gate.x, y1: 0.1, z1: gate.z, alpha: 0.6});
  }

  // look: {highlight(id) -> 0 none, 1 selected, 2 hovered; pulse(id) -> 0..1}
  function write(wire, field, t, look) {
    wire.begin({doc: field.doc, waitingCount: field.waitingOrder.length,
      scene: [field.extent, field.layoutSerial, STACK.radius, STACK.y0, STACK.dy]});
    for (const airport of field.airports) airportZone(wire, airport);
    const agents = [...field.agents.values()];
    for (const agent of agents) agentRecord(wire, field, agent, t, look);
    for (const agent of agents) {
      if (agent.slot.kind === "route") {
        const family = look.highlight(agent.id) === 1 || look.highlight(agent.leadAgent.id) === 1;
        routeDashes(wire, field, agent, family ? 0.9 : 0.35);
      } else if (agent.slot.kind === "stack") {
        homeLine(wire, field, agent);
      }
    }
    return wire;
  }

  window.AtcFrame = {write, ZONE, LINK};
})();
