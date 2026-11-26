// airport.h: one airport per place, from its zone record (atc-frame.js):
// a round terminal in the place's colour (taller the more tool calls were
// seen there), its beacon (flashing red while one of its aircraft holds),
// a hangar for offline aircraft, runway edge and threshold lights, and
// approach lights with a running flash.
#pragma once

#include <vector>

#include "draw_util.h"

namespace atc {

struct Airport {
    float cx, cz, ux, uz, halfWidth, hue;
    int waiting, sessions, toolCount;

    // A point `along` out from the tower and `side` along the apron.
    void at(float along, float side, float& x, float& z) const {
        x = cx + ux * along - uz * side;
        z = cz + uz * along + ux * side;
    }
    // The reverse: where (x, z) sits in the airport's own frame.
    void local(float x, float z, float& along, float& side) const {
        const float dx = x - cx, dz = z - cz;
        along = dx * ux + dz * uz;
        side = -dx * uz + dz * ux;
    }
    float runwayHalf() const { return halfWidth + 8.0f; }
};

inline Airport airportOf(const agentviz::Zone& zone) {
    const float* e = zone.extra;
    return {e[0], e[1], e[2], e[3], e[4], zone.seed, agentviz::toInt(e[5]), agentviz::toInt(e[6]), agentviz::toInt(e[7])};
}

inline std::vector<Airport> airportsOf(const std::vector<agentviz::Zone>& zones) {
    std::vector<Airport> out;
    for (const auto& zone : zones) out.push_back(airportOf(zone));
    return out;
}

inline void drawBeacon(float x, float y, float z, bool alarm, double t) {
    if (!alarm) {
        ball(x, y, z, 0.3f, {0.9f, 0.85f, 0.6f});
        return;
    }
    const float on = blink(t, 1.5, 0.0f, 0.5f);
    ball(x, y, z, 0.35f, scl(kRed, 0.3f + 0.7f * on));
    if (on > 0.5f) glow(x, y, z, 2.2f, kRed, 0.8f);
}

// Busier airports grow: one storey, up to about two more at a few hundred tool calls.
inline void drawTerminal(const Airport& ap, double t) {
    float x, z;
    ap.at(-4.8f, 0.0f, x, z);
    const float radius = std::min(1.6f + ap.halfWidth * 0.15f, 3.0f);
    const float height = 1.5f * (1.0f + 0.5f * std::log10(1.0f + static_cast<float>(ap.toolCount)));
    cyl(x, height * 0.5f, z, radius, height * 0.5f, {0.62f, 0.62f, 0.60f});
    cyl(x, height + 0.1f, z, radius * 0.92f, 0.12f, hueColor(ap.hue, 0.55f, 0.55f));
    cyl(x, height + 0.8f, z, 0.25f, 0.6f, {0.5f, 0.5f, 0.5f});
    drawBeacon(x, height + 1.55f, z, ap.waiting > 0, t);
}

inline void drawHangar(const Airport& ap) {
    float x, z;
    ap.at(-3.6f, -(ap.halfWidth + 4.5f), x, z);
    cube(x, 0.9f, z, 3.2f, 1.8f, 3.2f, {0.30f, 0.32f, 0.34f});
    sph(x, 1.8f, z, 3.2f, 1.1f, 3.2f, {0.36f, 0.38f, 0.40f});
}

inline void drawRunwayLights(const Airport& ap) {
    float x, z;
    const float half = ap.runwayHalf();
    for (float b = -half; b <= half + 0.01f; b += 2.0f)
        for (float a : {6.05f, 8.55f}) {
            ap.at(a, b, x, z);
            dot(x, 0.08f, z, 3.0f, 0.12f, {0.95f, 0.9f, 0.7f}, 0.9f);
        }
    for (int end = -1; end <= 1; end += 2)
        for (float a = 6.2f; a < 8.5f; a += 0.45f) {
            ap.at(a, end * (half + 0.1f), x, z);
            dot(x, 0.08f, z, 3.5f, 0.14f, end < 0 ? kGreen : kRed, 0.9f);
        }
}

// Approach lights on the centreline past the green threshold, with a
// sequenced flash (the "rabbit") running in towards the runway and a pause.
inline void drawApproachLights(const Airport& ap, double t) {
    constexpr int kLights = 6;
    const float half = ap.runwayHalf();
    const int lit = H().reducedMotion
        ? -1
        : kLights - 1 - static_cast<int>(fract(static_cast<float>(t) * 1.2f + ap.hue) * (kLights + 2));
    float x, z;
    for (int k = 0; k < kLights; ++k) {
        ap.at(7.3f, -(half + 1.6f + k * 1.2f), x, z);
        dot(x, 0.1f, z, 3.0f, 0.12f, {0.9f, 0.92f, 1.0f}, 0.55f);
        if (k == lit) glow(x, 0.2f, z, 1.2f, kWhite, 0.95f);
    }
}

inline void drawAirport(const Airport& ap, double t) {
    drawTerminal(ap, t);
    drawHangar(ap);
    drawRunwayLights(ap);
    drawApproachLights(ap, t);
}

}  // namespace atc
