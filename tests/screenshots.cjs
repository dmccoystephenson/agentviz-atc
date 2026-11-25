// Regenerates every README image in docs/media/ from the DEMO feed (never live):
//   npm run screenshots [-- name ...]
// Stills are drawn with ?drive=1 (the kit draws one frame on demand) with
// every aircraft settled onto where its state puts it at that scene time, so
// they repeat. The GIF steps scene time frame by frame and is encoded with
// Pillow (vendor/agentviz-kit/tests/make_gif.py).
const fs = require("fs");
const os = require("os");
const path = require("path");
const h = require("../vendor/agentviz-kit/tests/harness.cjs");
const screens = require("../vendor/agentviz-kit/tests/screens.cjs");

const REPO = path.resolve(__dirname, "..");
const MEDIA = path.join(REPO, "docs/media");
const PORT = Number(process.env.ATC_TEST_PORT || 9109);
const READY = "window.__page && window.__page.polls > 0 && window.__page.field.agents.size > 0";
const only = new Set(process.argv.slice(2));
const want = (name) => only.size === 0 || only.has(name);
const DESKTOP = {viewport: {width: 1600, height: 900}};
const PHONE = {viewport: {width: 390, height: 844}, dpr: 3, mobile: true};

// Camera helpers, run in the page. at: an agent id, "ap:<place>" (a, b in the
// airport's own frame: out from the tower, along the apron) or the tower.
// facing(place, offset): the yaw that looks at an airport from outside, in.
const HELPERS = `
window.__shots = {
  t: 0,
  field() { return window.__page.field; },
  aim(o) {
    const field = this.field();
    let x = 0, y = 2, z = 0;
    if (o.at && o.at.startsWith("ap:")) {
      const p = field.airportById.get(o.at.slice(3)).at(o.a || 0, o.b || 0); x = p.x; z = p.z; y = 1;
    } else if (o.at) {
      const d = field.agents.get(o.at).disp; x = d.x; y = d.y; z = d.z;
    }
    Object.assign(window.__page.kit.cam, {tx: x + (o.dx || 0), ty: y + (o.dy || 0), tz: z + (o.dz || 0),
      dist: o.dist, yaw: o.yaw, pitch: o.pitch});
  },
  facing(place, offset) { const ap = this.field().airportById.get(place); return Math.atan2(ap.uz, ap.ux) + (offset || 0); },
  at(t) { this.t = t; this.field().settle(t); },
  draw() { window.__page.kit.drive(this.t); },
};`;

async function openPage(browser, server, options) {
  const opened = await h.open(browser, `${server.base}/?fixture=1&drive=1`, Object.assign({ready: READY}, options));
  await h.stillAnimations(opened.page);
  await opened.page.evaluate(() => window.__page.stopPolling());
  await opened.page.evaluate(HELPERS);
  return opened;
}

async function shoot(page, name, t, setup) {
  if (!want(name)) return;
  await page.evaluate(`window.__page.select(null); window.__shots.at(${t}); ${setup}`);
  await screens.still(page, path.join(MEDIA, name + ".png"), () => { window.__shots.at(window.__shots.t); window.__shots.draw(); });
}

const S = "window.__shots";
const DESKTOP_SHOTS = [
  ["hero", 14, "window.__page.fit()"],
  ["angle-low", 16, `window.__page.fit(); ${S}.aim({dist: window.__page.kit.cam.dist * 0.82, yaw: 0.4, pitch: 0.3, dy: 4})`],
  ["angle-top", 18, `${S}.aim({dist: ${S}.field().extent * 2.15, yaw: 1.5708, pitch: 1.42})`],
  ["closeup-lead", 20, `${S}.aim({at: "ap:plugin-site", a: 4, dist: 30, yaw: ${S}.facing("plugin-site", 0.5), pitch: 0.55})`],
  ["closeup-waiting", 22, `${S}.aim({dist: 26, yaw: 2.6, pitch: 0.2, dy: 9.5})`],
  ["closeup-idle-offline", 24, `${S}.aim({at: "ap:~", a: -1, b: -2, dist: 24, yaw: ${S}.facing("~", -0.4), pitch: 0.55})`],
  ["closeup-resting", 26, `${S}.aim({at: "demo-lead-a/demo-a5", dist: 15, yaw: ${S}.facing("site-one", 1.1), pitch: 0.75});
    window.__page.select("demo-lead-a")`],
  ["closeup-stalled", 28, `${S}.aim({at: "demo-stalled", dist: 13, yaw: ${S}.facing("game", 0.5), pitch: 0.6})`],
  ["closeup-actions", 30, `${S}.aim({at: "ap:engine", a: 0, b: 1, dist: 22, yaw: ${S}.facing("engine", 0.6) + Math.PI, pitch: 0.55})`],
  ["panel-desktop", 32, `window.__page.select("demo-lead-b");
    ${S}.aim({at: "demo-lead-b", dist: 34, yaw: ${S}.facing("plugin-site", 0.3), pitch: 0.6})`],
];

async function desktopStills(browser, server) {
  const {ctx, page, errors} = await openPage(browser, server, DESKTOP);
  for (const [name, t, setup] of DESKTOP_SHOTS) await shoot(page, name, t, setup);
  h.assertNoErrors(errors);
  await ctx.close();
}

async function phone(browser, server) {
  if (!want("phone")) return;
  const {ctx, page, errors} = await openPage(browser, server, PHONE);
  await shoot(page, "phone", 12, `window.__page.select("demo-waiting");
    ${S}.aim({at: "demo-waiting", dist: 40, yaw: 2.4, pitch: 0.42, dy: -4})`);
  h.assertNoErrors(errors);
  await ctx.close();
}

// Five seconds at 11 frames a second over Otto's subagents flying their loops.
async function motionGif(browser, server) {
  if (!want("motion")) return;
  const {ctx, page, errors} = await openPage(browser, server, {viewport: {width: 720, height: 420}});
  await page.evaluate(`${S}.at(40); ${S}.aim({at: "ap:plugin-site", a: 7, dist: 21, yaw: ${S}.facing("plugin-site", 0.8), pitch: 0.6})`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atc-gif-"));
  const FPS = 11;
  await screens.frames(page, tmp, 54, (i) => {
    window.__shots.at(40 + i / 11);
    window.__shots.draw();
  });
  screens.gif(tmp, path.join(MEDIA, "motion.gif"), FPS);
  fs.rmSync(tmp, {recursive: true, force: true});
  h.assertNoErrors(errors);
  await ctx.close();
}

h.run("screenshots", {repo: REPO, port: PORT}, async ({server, browser}) => {
  fs.mkdirSync(MEDIA, {recursive: true});
  await desktopStills(browser, server);
  await phone(browser, server);
  await motionGif(browser, server);
});
