// Regenerates every README image in docs/media/ from the FIXTURE feed:
//   NODE_PATH=<node_modules with playwright> node tests/screenshots.cjs
// Frames are drawn with the kit's ?drive=1 hook (kit.drive(t)), so scene time
// is stepped, not waited for. The GIF is assembled with Pillow (python3).
const {chromium} = require("playwright");
const path = require("path");
const fs = require("fs");
const {spawnSync} = require("child_process");
const {startServer, LAUNCH} = require("./serve.cjs");

const MEDIA = path.resolve(__dirname, "../docs/media");
// Optional names on the command line regenerate only those images.
const ONLY = new Set(process.argv.slice(2));
const want = (name) => !ONLY.size || ONLY.has(name);

async function open(browser, base, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/?fixture=1&drive=1", {waitUntil: "commit"});
  await page.waitForFunction(() => window.__atc && window.__atc.ready && window.__atc.atc.agents.size > 0, null, {timeout: 120000});
  page._errors = errors;
  page._t = 0;
  return {ctx, page};
}

// Each driven frame queues GPU work SwiftShader must finish before the next
// screenshot, so aircraft are settled onto their targets instead of stepped.
async function advance(page, t1) {
  await page.evaluate((t1) => { window.__atc.atc.settle(t1); window.__atc.kit.drive(t1); }, t1);
  page._t = t1;
}

// Point the camera: at an agent (by id), an airport (ap:<id>) or the origin.
async function aim(page, o) {
  await page.evaluate((o) => {
    const {atc, kit} = window.__atc;
    let x = 0, y = 2, z = 0;
    if (o.at && o.at.startsWith("ap:")) {
      const ap = atc.airportById.get(o.at.slice(3)); const p = ap.P(o.a || 0, o.b || 0); x = p.x; z = p.z; y = 1;
    } else if (o.at) {
      const a = atc.agents.get(o.at); x = a.disp.x; y = a.disp.y; z = a.disp.z;
    }
    if (o.dx) x += o.dx; if (o.dz) z += o.dz; if (o.dy) y += o.dy;
    Object.assign(kit.cam, {tx: x, ty: y, tz: z, dist: o.dist, yaw: o.yaw, pitch: o.pitch});
  }, o);
}

async function shot(page, name, t) {
  if (!want(name)) return;
  await advance(page, t);
  await page.evaluate((t) => window.__atc.kit.drive(t), t);
  await page.waitForTimeout(400);  // labels show after 200 ms of wall time (StrataKit.placeLabels)
  await page.evaluate((t) => window.__atc.kit.drive(t + 0.01), t);
  await page.screenshot({path: path.join(MEDIA, name), timeout: 120000});
  console.log("saved", name);
}

// The field's yaw for looking at an airport from the tower side, out.
async function yawFacing(page, apId, offset = 0) {
  return page.evaluate(([id, off]) => {
    const ap = window.__atc.atc.airportById.get(id);
    // kit camera: eye = target + (cos(pitch)cos(yaw), sin(pitch), cos(pitch)sin(yaw)) * dist
    return Math.atan2(-ap.uz, -ap.ux) + off;
  }, [apId, offset]);
}

(async () => {
  fs.mkdirSync(MEDIA, {recursive: true});
  const srv = await startServer();
  const browser = await chromium.launch(LAUNCH);
  try {
    // ---------------------------------------------------------- desktop
    const {ctx, page} = await open(browser, srv.base, {viewport: {width: 1600, height: 900}});
    await advance(page, 12);
    await aim(page, {dist: 66, yaw: 2.2, pitch: 0.72});
    await shot(page, "hero.png", 14);
    await aim(page, {dist: 58, yaw: 0.4, pitch: 0.32, dy: 4});
    await shot(page, "angle-low.png", 16);
    await aim(page, {dist: 84, yaw: 1.5708, pitch: 1.42});
    await shot(page, "angle-top.png", 18);

    let yaw = await yawFacing(page, "plugin-site", 0.5);
    await aim(page, {at: "ap:plugin-site", a: 4, dist: 30, yaw: yaw + Math.PI, pitch: 0.55});
    await shot(page, "closeup-lead.png", 20);

    await aim(page, {dist: 30, yaw: 2.6, pitch: 0.22, dy: 8});
    await shot(page, "closeup-waiting.png", 22);

    yaw = await yawFacing(page, "~", -0.5);
    await aim(page, {at: "ap:~", a: -1, b: -3.5, dist: 20, yaw: yaw + Math.PI, pitch: 0.55});
    await shot(page, "closeup-idle-offline.png", 24);

    yaw = await yawFacing(page, "site-one", 1.1);
    await aim(page, {at: "demo-lead-a/demo-a5", dist: 15, yaw: yaw + Math.PI, pitch: 0.75});
    await page.evaluate(() => window.__atc.select("demo-lead-a"));  // shows its subagents' labels
    await shot(page, "closeup-resting.png", 26);
    await page.evaluate(() => window.__atc.select(null));

    yaw = await yawFacing(page, "engine", 0.6);
    await aim(page, {at: "ap:engine", a: 0, dist: 20, yaw: yaw, pitch: 0.55});
    await shot(page, "closeup-actions.png", 28);

    // The panel, open on a lead with six flights out.
    await page.evaluate(() => window.__atc.select("demo-lead-b"));
    yaw = await yawFacing(page, "plugin-site", 0.3);
    await aim(page, {at: "demo-lead-b", dist: 34, yaw: yaw + Math.PI, pitch: 0.6, dx: 0});
    await shot(page, "panel-desktop.png", 30);
    await page.evaluate(() => window.__atc.select(null));

    // ---------------------------------------------------------- GIF
    if (want("motion.gif")) {
    const frames = path.join(MEDIA, ".frames");
    fs.rmSync(frames, {recursive: true, force: true});
    fs.mkdirSync(frames);
    await page.setViewportSize({width: 720, height: 420});
    yaw = await yawFacing(page, "plugin-site", 0.8);
    await aim(page, {at: "ap:plugin-site", a: 7, dist: 21, yaw: yaw + Math.PI, pitch: 0.6});
    await advance(page, 40);
    const N = 54;
    for (let i = 0; i < N; i++) {
      const t = 40 + i / 11;
      await page.evaluate((t) => window.__atc.kit.drive(t), t);
      await page.screenshot({path: path.join(frames, String(i).padStart(3, "0") + ".png"), timeout: 120000});
    }
    page._t = 40 + N / 11;
    const py = spawnSync("python3", ["-c", `
import sys, glob
from PIL import Image
fs = sorted(glob.glob(sys.argv[1] + "/*.png"))
ims = [Image.open(f).convert("RGB") for f in fs]
pal = ims[len(ims)//2].quantize(colors=128, method=Image.MEDIANCUT)
q = [im.quantize(palette=pal, dither=Image.NONE) for im in ims]
q[0].save(sys.argv[2], save_all=True, append_images=q[1:], duration=91, loop=0, optimize=True)
`, frames, path.join(MEDIA, "motion.gif")], {stdio: "inherit"});
    if (py.status !== 0) throw new Error("GIF assembly failed");
    fs.rmSync(frames, {recursive: true, force: true});
    console.log("saved motion.gif");
    }
    if (page._errors.length) throw new Error(page._errors.join("\n"));
    await ctx.close();

    // ---------------------------------------------------------- phone
    if (want("phone.png")) {
    const phone = await open(browser, srv.base, {viewport: {width: 390, height: 844}, deviceScaleFactor: 3, isMobile: true, hasTouch: true});
    await advance(phone.page, 10);
    await phone.page.evaluate(() => window.__atc.select("demo-waiting"));
    await aim(phone.page, {at: "demo-waiting", dist: 34, yaw: 2.4, pitch: 0.42});
    await shot(phone.page, "phone.png", 12);
    await phone.ctx.close();
    }
  } finally {
    await browser.close();
    srv.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
