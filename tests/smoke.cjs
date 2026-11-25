// Headless smoke test: loads /?fixture=1, waits for the kit to draw, checks
// there are no console errors and the frame is not one flat colour, taps an
// aircraft and checks the panel opens, and saves docs/media/screenshot.png.
//   NODE_PATH=<node_modules with playwright> node tests/smoke.cjs
const {chromium} = require("playwright");
const path = require("path");
const {startServer, LAUNCH} = require("./serve.cjs");

(async () => {
  const srv = await startServer();
  const browser = await chromium.launch(LAUNCH);
  const errors = [];
  let ok = false;
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 760}});
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(srv.base + "/?fixture=1", {waitUntil: "commit"});
    await page.waitForFunction(() => window.__atc && window.__atc.ready && window.__atc.atc.agents.size > 0, null, {timeout: 90000});
    await page.waitForTimeout(4000);
    const info = await page.evaluate(() => {
      const a = window.__atc.atc;
      return {agents: a.agents.size, airports: a.airports.length, waiting: a.waitingOrder.length,
        holding: document.getElementById("holding").textContent};
    });
    console.log("scene:", JSON.stringify(info));
    if (info.agents !== 19 || info.airports !== 5 || info.waiting !== 1) throw new Error("unexpected scene " + JSON.stringify(info));
    if (!/1 holding/.test(info.holding)) throw new Error("holding chip says " + info.holding);
    const shot = await page.screenshot({timeout: 60000});
    const flat = await page.evaluate(async (b64) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data, seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4));
      return seen.size;
    }, shot.toString("base64"));
    console.log("distinct colours:", flat);
    if (flat < 20) throw new Error("frame looks flat");
    // Tap the waiting aircraft through the kit's own pick and check the panel.
    const hit = await page.evaluate(() => {
      const k = window.__atc.kit, a = window.__atc.atc.agents.get("demo-waiting");
      const q = k.project(a.disp.x, a.disp.y, a.disp.z), r = k.canvas.getBoundingClientRect();
      return q && {x: q.x + r.left, y: q.y + r.top};
    });
    if (!hit) throw new Error("waiting aircraft off screen");
    await page.mouse.click(hit.x, hit.y);
    await page.waitForTimeout(500);
    const panel = await page.evaluate(() => !document.getElementById("panel").hidden && document.getElementById("p-name").textContent);
    console.log("panel:", panel);
    if (panel !== "Thistle") throw new Error("tap did not select the waiting aircraft: " + panel);
    await page.evaluate(() => window.__atc.select(null));
    await page.waitForTimeout(300);
    await page.screenshot({path: path.resolve(__dirname, "../docs/media/screenshot.png"), timeout: 60000});
    if (errors.length) throw new Error("console errors:\n" + errors.join("\n"));
    ok = true;
    console.log("smoke: PASS");
  } catch (e) {
    console.error("smoke: FAIL", e.message);
  } finally {
    await browser.close();
    srv.stop();
  }
  process.exit(ok ? 0 : 1);
})();
