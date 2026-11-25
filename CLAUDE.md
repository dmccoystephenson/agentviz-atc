# CLAUDE.md

agentviz-atc: one agentviz visualization (air traffic control). Feed schema in
`vendor/agentfeed` (vendored from dmccoystephenson/agentviz; never edit it,
re-vendor with `tools/vendor-feed.sh` from that repo).

- Run: `python3 -m vendor.agentfeed serve --web web --port 8844 [--fixture]` (127.0.0.1 only).
- Scene: `scene/main.cpp` (Strata web kit); `scene/build.sh` rebuilds `web/atc-engine.{js,wasm}`
  (committed). Page: `web/index.html` + `web/atc.js`.
- Tests: `python3 -m unittest discover -s tests`; browser smoke:
  `NODE_PATH=<dir with playwright> node tests/smoke.cjs`.
- Screenshots come from the fixture feed only. Never commit live session data.
- Repo is PRIVATE; hosted Actions are refused, so run localci on PRs.
