// Starts the fixture server for the browser tests on port 8944 (8844 + 100)
// and returns {base, stop}. The child is killed by its own handle only.
const {spawn} = require("child_process");
const path = require("path");
const http = require("http");

const PORT = Number(process.env.ATC_TEST_PORT || 8944);

function up(url) {
  return new Promise((resolve) => {
    http.get(url, (r) => { r.resume(); resolve(r.statusCode === 200); }).on("error", () => resolve(false));
  });
}

async function startServer() {
  const repo = path.resolve(__dirname, "..");
  const child = spawn("python3", ["-m", "vendor.agentfeed", "serve", "--web", "web", "--port", String(PORT), "--fixture"],
    {cwd: repo, stdio: "ignore"});
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) {
    if (await up(base + "/api/agents")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {base, stop: () => child.kill()};
}

const LAUNCH = {channel: "chromium", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]};

module.exports = {startServer, LAUNCH};
