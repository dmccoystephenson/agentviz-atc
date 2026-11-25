// Headless smoke test on the demo feed (vendor/agentviz-kit/tests/harness.cjs):
// every fixture agent and airport is on the field; the "needs you" chip cycles
// the waiting sessions; a tap on a holding aircraft opens its panel, which
// says why it waits; the wire carries each holding aircraft's reason, the
// stalled subagent and a new tool call's pulse; a subagent's own branch shows
// in its panel; feed strings never become HTML; the empty state and the
// unreachable banner show; the frame is not flat; no console errors.
// Expected counts come from the feed document, not from numbers written here.
//   npm ci && npx playwright install chromium && npm run smoke
const path = require("path");
const h = require("../vendor/agentviz-kit/tests/harness.cjs");

const REPO = path.resolve(__dirname, "..");
const PORT = Number(process.env.ATC_TEST_PORT || 9109);
const READY = "window.__page && window.__page.polls > 0 && window.__page.field.agents.size > 0";
const T = 20;  // scene time the field is settled and drawn at

function check(cond, message) { if (!cond) throw new Error(message); }

const draw = (page) => page.evaluate((t) => { window.__page.field.settle(t); window.__page.kit.drive(t); }, T);

async function checkScene(page) {
  const info = await page.evaluate(() => {
    const field = window.__page.field, doc = window.__page.doc;
    return {agents: field.agents.size, airports: field.airports.length,
      want: {agents: doc.sessions.length + doc.sessions.reduce((n, s) => n + s.followers.length, 0),
        airports: new Set(doc.sessions.map((s) => s.place)).size},
      holding: field.waitingOrder.length,
      waiting: doc.sessions.filter((s) => s.state === "waiting").map((s) => s.name)};
  });
  console.log("scene:", JSON.stringify(info));
  check(info.agents === info.want.agents, "the field does not hold every fixture agent");
  check(info.airports === info.want.airports, "one airport per place expected");
  check(info.waiting.length >= 2 && info.holding === info.waiting.length, "every waiting session should be holding");
  return info;
}

const panelTitle = (page) => page.evaluate(() => {
  const panel = document.querySelector(".av-panel");
  return panel.hidden ? null : panel.querySelector("h2").textContent.trim();
});

async function checkWaitingChip(page, names) {
  const chip = page.locator(".av-wait");
  check(await chip.isVisible(), "the needs-you chip is hidden");
  check((await chip.locator("b").textContent()) === String(names.length), "the needs-you chip miscounts");
  const seen = [];
  for (let i = 0; i < names.length; i++) { await chip.click(); seen.push(await panelTitle(page)); }
  console.log("needs-you chip cycles:", seen.join(" -> "));
  check(seen.slice().sort().join() === names.slice().sort().join(), "the chip did not cycle every waiting session");
  check(await page.locator(".av-panel .av-needs").isVisible(), "the panel does not say why it waits");
}

// Tap the holding aircraft through the kit's own picking.
async function checkTapHolding(page) {
  await page.evaluate(() => window.__page.select(null));
  await page.evaluate(() => window.__page.fit());
  await draw(page);
  const target = await page.evaluate(() => {
    const doc = window.__page.doc, s = doc.sessions.find((x) => x.waitingReason === "permission");
    const k = window.__page.kit, a = window.__page.field.agents.get(s.id);
    const q = k.project(a.disp.x, a.disp.y, a.disp.z), r = k.canvas.getBoundingClientRect();
    return q && {x: q.x + r.left, y: q.y + r.top, name: s.name, stack: a.slot.kind === "stack"};
  });
  check(target && target.stack, "the waiting session is not in the holding stack");
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(300);
  const title = await panelTitle(page);
  const reason = await page.evaluate(() => document.querySelector(".av-panel .av-needs").textContent);
  console.log("tap on the holding stack:", title, "/", reason);
  check(title === target.name && reason === "needs permission", "the tap did not open the holding aircraft with its reason");
}

// Packs one frame the way the page does and reads back the agent records.
async function checkWire(page) {
  const result = await page.evaluate((t) => {
    const {field, doc} = window.__page, W = window.AgentvizWire;
    const pulsing = doc.sessions.find((s) => s.state === "busy").id;
    const data = window.AtcFrame.write(W.create(), field, t, {highlight: () => 0, pulse: (id) => (id === pulsing ? 1 : 0)}).finish();
    const rows = new Map(), start = W.HEADER + data[2] * W.ZONE_STRIDE;
    for (let i = 0; i < data[3]; i++) {
      const row = data.subarray(start + i * W.AGENT_STRIDE, start + (i + 1) * W.AGENT_STRIDE);
      rows.set(row[0], row);
    }
    const out = {reasons: [], stalled: null, pulse: rows.get(W.id24(pulsing))[16]};
    for (const s of doc.sessions) {
      if (s.state === "waiting") out.reasons.push([s.waitingReason, W.WAITING_REASONS[rows.get(W.id24(s.id))[5]]]);
      for (const f of s.followers) {
        if (f.stalled) out.stalled = {label: f.label, wire: rows.get(W.id24(s.id + "/" + f.id))[6]};
      }
    }
    return out;
  }, T);
  console.log("wire:", JSON.stringify(result));
  check(result.reasons.every(([want, got]) => want === got), "a holding aircraft's reason did not reach the wire");
  check(result.reasons.some(([r]) => r === "question") && result.reasons.some(([r]) => r === "permission"),
    "the fixture should have both waiting reasons");
  check(result.stalled && result.stalled.wire === 1, "the stalled subagent is not stalled on the wire");
  check(result.pulse === 1, "a new tool call's pulse did not reach the wire");
}

async function checkFollowerBranch(page) {
  const found = await page.evaluate(() => {
    for (const s of window.__page.doc.sessions) {
      const f = s.followers.find((x) => x.branch && x.branch !== s.branch);
      if (f) return {id: s.id + "/" + f.id, branch: f.branch};
    }
    return null;
  });
  check(found, "the fixture should have a subagent on its own branch");
  await page.evaluate((id) => window.__page.select(id, false), found.id);
  const rows = await page.evaluate(() => [...document.querySelectorAll(".av-panel dd")].map((d) => d.textContent));
  console.log("subagent branch:", found.branch);
  check(rows.includes(found.branch), "the subagent panel does not show its own branch");
}

async function checkTextOnly(page) {
  const result = await page.evaluate(() => {
    const doc = JSON.parse(JSON.stringify(window.__page.doc));
    const lead = doc.sessions.find((s) => s.followers.length);
    lead.followers[0].label = "<img src=x id=pwned>";
    window.__page.feed(doc);
    window.__page.select(lead.id, false);
    window.__page.kit.drive(20);
    return {img: !!document.getElementById("pwned"),
      lane: [...document.querySelectorAll(".av-panel .av-lanes button")].some((b) => b.textContent === "<img src=x id=pwned>"),
      label: [...document.querySelectorAll("#labels .av-label")].some((l) => l.textContent === "<img src=x id=pwned>")};
  });
  console.log("text only:", JSON.stringify(result));
  check(!result.img && result.lane && result.label, "a feed label was parsed as HTML");
}

async function checkEmptyState(page) {
  const shown = await page.evaluate(() => {
    const doc = JSON.parse(JSON.stringify(window.__page.doc));
    const sessions = doc.sessions;
    window.__page.feed(Object.assign(doc, {sessions: []}));
    const visible = !document.querySelector(".av-empty").hidden;
    window.__page.feed(Object.assign(doc, {sessions}));
    return visible && document.querySelector(".av-empty").hidden;
  });
  check(shown, "no empty-state hint with zero sessions");
}

async function checkUnreachable(page) {
  await page.route("**/api/agents*", (route) => route.fulfill({status: 503, body: "down"}));
  await page.evaluate(async () => { await window.__page.pollOnce(); await window.__page.pollOnce(); });
  const banner = await page.evaluate(() => !document.querySelector(".av-banner").hidden && document.querySelector(".av-banner").textContent);
  console.log("banner:", banner);
  check(banner && banner.includes("HTTP 503"), "no unreachable banner after failed polls");
}

h.run("smoke", {repo: REPO, port: PORT}, async ({server, browser}) => {
  const {page, errors} = await h.open(browser, server.base + "/?fixture=1&drive=1", {ready: READY});
  await h.stillAnimations(page);
  await page.evaluate(() => window.__page.stopPolling());
  const info = await checkScene(page);
  await checkWaitingChip(page, info.waiting);
  await checkTapHolding(page);
  await checkWire(page);
  await checkFollowerBranch(page);
  await checkTextOnly(page);
  await checkEmptyState(page);
  await page.evaluate(() => { window.__page.select(null); window.__page.fit(); });
  await page.mouse.move(2, 400);  // no hover ring in the saved frame
  await draw(page);
  await page.waitForTimeout(300);
  await draw(page);
  const png = await h.shot(page, path.join(REPO, "docs/media/screenshot.png"));
  console.log("distinct colours:", await h.assertNotFlat(page, png));
  h.assertNoErrors(errors);
  await checkUnreachable(page);  // last: the failed fetches log console errors of their own
});
