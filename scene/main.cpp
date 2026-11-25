// agentviz-atc: Claude Code sessions as air traffic control, on Strata.
//
// The control tower in the middle is the owner. Each place (repo) is an
// airport on a ring round it; each session is an aircraft at a gate there;
// its subagents are smaller aircraft flying out from their lead's gate and
// back. A session waiting on the owner leaves its gate and joins the holding
// stack circling the tower, with a pulsing beacon: that is the point of the
// page. The tower's lamps count the aircraft holding.
//
// The page (web/atc-field.js, atc-frame.js) owns the data, layout and
// motion. Every frame it packs the field in the agentviz wire format
// (vendor/agentviz-kit, docs/KIT.md in the agentviz repo) and calls
// agentviz_frame(); this file only draws what the frame says:
//   scene floats  field half extent, layout serial, holding stack shape
//   zones         airports (airport.h; terrain.h paints the ground)
//   agents        aircraft (aircraft.h, actions.h), holding patterns (holding.h)
//   links         subagent flight loops, holding aircraft's lines home (holding.h)
#define STRATA_KIT_MAIN
#include "strata_kit.h"

#include "aircraft.h"
#include "holding.h"
#include "terrain.h"
#include "tower.h"

namespace {

agentviz::Frame frame;
float paintedSerial = -1.0f;  // the layout the terrain was last painted for

// The terrain is repainted only when the airports move or resize.
void paintTerrainIfStale(const std::vector<atc::Airport>& airports) {
    if (!atc::H().engine || frame.scene[1] == paintedSerial) return;
    atc::setTerrain(airports, std::max(frame.scene[0], 20.0f));
    paintedSerial = frame.scene[1];
}

}  // namespace

AGENTVIZ_FRAME_EXPORT(frame)

void strata_kit_configure(strata_kit::Options& o) {
    o.name = "agentviz-atc";
    o.farPlane = 600.0f;
    o.tiers[0].thinPoints = true;
}

void strata_kit_engine_ready(strata_kit::Host&) { paintedSerial = -1.0f; }

void strata_kit_build(strata_kit::Host& h, double t) {
    if (!frame.ok) return;
    const std::vector<atc::Airport> airports = atc::airportsOf(frame.zones);
    paintTerrainIfStale(airports);
    h.ambientLift = {0.05f, 0.05f, 0.07f};  // dusk over the field: the lights carry it
    atc::drawTower(frame.waitingCount, t);
    for (const auto& airport : airports) atc::drawAirport(airport, t);
    const atc::Stack stack{frame.scene[2], frame.scene[3], frame.scene[4]};
    for (const auto& agent : frame.agents) {
        atc::drawAircraft(agent, t);
        if (agent.waiting() && agent.extra[2] >= 0.0f) atc::drawHoldingPattern(agent, stack, t);
    }
    atc::drawLinks(frame.links);
}
