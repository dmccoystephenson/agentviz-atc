# CLAUDE.md

agentviz-atc: Claude Code sessions drawn as air traffic control (Strata web kit). Part of the
agentviz family: https://github.com/dmccoystephenson/agentviz

- Data comes only from `/api/agents` (vendor/agentfeed; schema in the agentviz repo's docs/FEED.md).
- Shared pieces come from the agentviz kit (docs/KIT.md there): `vendor/agentviz-kit/` and the
  `web/agentviz-*` copies. Never edit `vendor/` or `web/agentviz-*`; re-vendor from an agentviz
  checkout with `tools/vendor-kit.sh <this repo>`. `tests/test_serve.py` checks the PINs.
- Page: `web/atc-field.js` lays out the airports and gates and eases the aircraft;
  `web/atc-frame.js` packs each frame in the agentviz wire format; `web/page.js` boots the feed
  client, HUD, labels and camera; `web/index.html` holds the theme and the legend.
- Scene: `scene/main.cpp` decodes the wire (`agentviz.h`) and calls `terrain.h`, `tower.h`,
  `airport.h`, `aircraft.h` (+ `actions.h`) and `holding.h`. Build:
  `EMSDK=/path/to/emsdk vendor/agentviz-kit/scene/build-scene.sh scene/kit.conf`
  (emsdk 6.0.11, Strata 0.10.0). The built `web/atc-engine.*` are committed.
- Run: `python3 -m vendor.agentfeed serve --web web --port 8844 [--fixture]` (127.0.0.1 only).
- Tests: `python3 -m unittest discover -s tests`; browser tests after `npm ci` and
  `npx playwright install chromium`: `npm run smoke`, `npm run screenshots` (Pillow from
  requirements-dev.txt for the GIF). The unit tests use port 9108 (`ATC_UNIT_PORT` overrides), the
  browser tests 9109 (`ATC_TEST_PORT`).
- Screenshots come from the FIXTURE feed only, never live sessions.
