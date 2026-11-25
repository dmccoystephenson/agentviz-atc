// tower.h: the control tower in the middle of the field is the owner. Its
// cab glass turns red, one lamp lights per aircraft holding, and the mast
// beacon flashes red while anything waits on the owner (steady green and
// "ALL CLEAR" when nothing does).
#pragma once

#include <cstdio>

#include "draw_util.h"

namespace atc {

inline void drawTowerBody(int waiting, float beat) {
    const Rgb concrete{0.55f, 0.55f, 0.53f}, dark{0.08f, 0.09f, 0.11f};
    cyl(0, 0.4f, 0, 2.2f, 0.4f, {0.35f, 0.35f, 0.34f});
    cyl(0, 3.8f, 0, 0.9f, 3.4f, concrete);
    cyl(0, 7.3f, 0, 1.4f, 0.12f, concrete);
    const Rgb glass = waiting > 0 ? mix({0.25f, 0.05f, 0.04f}, {0.9f, 0.12f, 0.06f}, beat) : Rgb{0.10f, 0.22f, 0.25f};
    cyl(0, 7.95f, 0, 1.75f, 0.55f, glass);
    cyl(0, 8.6f, 0, 1.95f, 0.1f, dark);
    cyl(0, 8.8f, 0, 1.1f, 0.12f, concrete);
    cube(0, 9.6f, 0, 0.06f, 1.6f, 0.06f, dark);
}

// Eight lamps round the cab: one lit per aircraft holding.
inline void drawHoldingLamps(int waiting, float beat) {
    for (int i = 0; i < 8; ++i) {
        const float a = i * 2.0f * kPi / 8.0f + 0.2f;
        const float x = std::cos(a) * 2.0f, z = std::sin(a) * 2.0f;
        const bool lit = i < waiting;
        ball(x, 8.75f, z, 0.32f, lit ? scl(kRed, 0.6f + 0.4f * beat) : Rgb{0.05f, 0.12f, 0.06f});
        if (lit) glow(x, 8.75f, z, 1.3f + 0.4f * beat, kRed, 0.85f);
    }
}

inline void drawMastBeacon(int waiting, float beat) {
    if (waiting > 0) {
        ball(0, 10.5f, 0, 0.45f, scl(kRed, 0.35f + 0.65f * beat));
        glow(0, 10.5f, 0, 3.0f + 2.0f * beat, kRed, 0.9f);
        glow(0, 8.0f, 0, 9.0f + 3.0f * beat, kRed, 0.18f);
        H().light(0, 9.0f, 0, 14.0f, kRed, 1.2f + 1.5f * beat, 10);
    } else {
        ball(0, 10.5f, 0, 0.35f, kGreen);
        glow(0, 10.5f, 0, 1.6f, kGreen, 0.7f);
        H().light(0, 9.0f, 0, 9.0f, kGreen, 0.6f, 2);
    }
}

inline void drawTower(int waiting, double t) {
    const float beat = 0.5f + 0.5f * wave(t, 5.0, 0.0f);
    drawTowerBody(waiting, beat);
    drawHoldingLamps(waiting, beat);
    drawMastBeacon(waiting, beat);
    char text[48];
    if (waiting > 0)
        std::snprintf(text, sizeof text, "%d HOLDING", waiting);
    else
        std::snprintf(text, sizeof text, "ALL CLEAR");
    H().label(0, 5.6f, 0, text, waiting > 0 ? 20.0f : 13.0f, waiting > 0 ? Rgb{1.0f, 0.35f, 0.25f} : Rgb{0.6f, 1.0f, 0.7f});
}

}  // namespace atc
