// actions.h: what a busy aircraft is doing now, one effect per action:
// edit loads cargo, run spools the engines, read sweeps a radar, web sends
// radio rings, delegate launches flights from the gate, think holds short,
// other turns a violet beacon.
#pragma once

#include "draw_util.h"

namespace atc {

// An aircraft's frame: position, forward (fx, fz), right (rx, rz), scale.
struct Frame {
    float x, y, z, fx, fz, rx, rz, s;
    // A point at (forward, right, up) in the aircraft's frame.
    void at(float f, float r, float u, float& ox, float& oy, float& oz) const {
        ox = x + (fx * f + rx * r) * s;
        oz = z + (fz * f + rz * r) * s;
        oy = y + u * s;
    }
};

const Rgb kCrate{0.62f, 0.38f, 0.14f};

// On the ground: a belt loader carrying crates up into the hold.
inline void drawBeltLoader(const Frame& f, double t) {
    float x0, y0, z0, x1, y1, z1, x, y, z;
    f.at(0.5f, 2.6f, -0.45f, x0, y0, z0);
    y0 = std::max(f.y - 0.4f * f.s, 0.15f);
    f.at(0.5f, 0.5f, 0.05f, x1, y1, z1);
    auto along = [&](float u, float lift, float& ox, float& oy, float& oz) {
        ox = x0 + (x1 - x0) * u; oy = y0 + (y1 - y0) * u + lift; oz = z0 + (z1 - z0) * u;
    };
    for (int k = 0; k <= 6; ++k) {
        along(k / 6.0f, -0.08f, x, y, z);
        cube(x, y, z, 0.18f * f.s, 0.08f * f.s, 0.18f * f.s, {0.18f, 0.18f, 0.2f});
    }
    f.at(0.5f, 3.4f, 0.0f, x, y, z);
    cube(x, y0 + 0.15f, z, 0.9f * f.s, 0.3f * f.s, 0.9f * f.s, {0.85f, 0.6f, 0.1f});
    cube(x, y0 + 0.45f * f.s, z, 0.4f * f.s, 0.35f * f.s, 0.4f * f.s, kCrate);
    for (int k = 0; k < 3; ++k) {
        along(fract(static_cast<float>(t) * 0.45f * motion() + k / 3.0f), 0.12f * f.s, x, y, z);
        cube(x, y, z, 0.3f * f.s, 0.25f * f.s, 0.3f * f.s, kCrate);
    }
}

// In flight: a crate slung underneath, swinging.
inline void drawSlungCrate(const Frame& f, float phase, double t) {
    float x, y, z;
    f.at(0.3f * wave(t, 2.0, phase), 0, -1.6f, x, y, z);
    line(f.x, f.y - 0.3f * f.s, f.z, x, y, z, {0.8f, 0.8f, 0.8f}, 0.8f);
    cube(x, y, z, 0.5f * f.s, 0.4f * f.s, 0.5f * f.s, kCrate);
}

// Exhaust streaming from both engines.
inline void drawExhaust(const Frame& f, float seed, double t) {
    float x, y, z;
    for (int side = -1; side <= 1; side += 2) {
        f.at(-0.2f, side * 0.8f, -0.22f, x, y, z);
        glow(x, y, z, 0.55f * f.s, {1.0f, 0.55f, 0.15f}, 0.9f);
        for (int k = 0; k < 9; ++k) {
            const float u = fract(static_cast<float>(t) * 1.4f * motion() + k / 9.0f + seed);
            f.at(-0.3f - u * 3.2f, side * (0.8f + u * 0.15f), -0.22f + u * 0.35f, x, y, z);
            const Rgb c = mix({1.0f, 0.6f, 0.2f}, {0.55f, 0.55f, 0.58f}, std::min(u * 2.0f, 1.0f));
            glow(x, y, z, (0.35f + u * 1.1f) * f.s, c, 0.75f * (1.0f - u));
        }
    }
    H().light(f.x - f.fx * 1.5f * f.s, f.y, f.z - f.fz * 1.5f * f.s, 3.0f * f.s, {1.0f, 0.5f, 0.15f}, 0.7f, 1);
}

// A green radar scope round it, the beam turning.
inline void drawRadar(const Frame& f, bool airborne, float phase, double t) {
    float x, y, z;
    f.at(0.3f, 0, 0.55f, x, y, z);
    sph(x, y, z, 0.42f * f.s, 0.25f * f.s, 0.42f * f.s, {0.85f, 0.85f, 0.82f});
    const float gy = airborne ? f.y - 0.3f * f.s : 0.07f, r = 3.0f * f.s;
    circle(f.x, gy, f.z, r, kGreen, 0.55f, 36);
    circle(f.x, gy, f.z, r * 0.5f, kGreen, 0.3f, 24);
    const float a0 = static_cast<float>(t) * 2.2f * motion() + phase;
    for (int k = 0; k < 7; ++k) {
        const float a = a0 - k * 0.09f;
        line(f.x, gy, f.z, f.x + std::cos(a) * r, gy, f.z + std::sin(a) * r, kGreen, 0.95f - k * 0.13f);
    }
    dot(f.x + std::cos(a0) * r, gy, f.z + std::sin(a0) * r, 5.0f, 0.2f, kGreen, 1.0f);
}

// A radio mast, cyan rings going out from its tip.
inline void drawRadioRings(const Frame& f, double t) {
    float x, y, z;
    f.at(0.1f, 0, 0.3f, x, y, z);
    const float top = y + 2.4f * f.s;
    line(x, y, z, x, top, z, {0.8f, 0.85f, 0.9f}, 1.0f);
    dot(x, top, z, 6.0f, 0.18f * f.s, kCyan, 1.0f);
    for (int k = 0; k < 3; ++k) {
        const float u = fract(static_cast<float>(t) * 0.6f * motion() + k / 3.0f);
        circle(x, top, z, (0.3f + u * 3.2f) * f.s, kCyan, 0.9f * (1.0f - u), 28);
    }
}

// Chase lights running out from the gate and a marshaller waving wands.
inline void drawLaunch(const Frame& f, double t) {
    float x, y, z;
    for (int k = 0; k < 10; ++k) {
        const float u = k / 10.0f;
        const float on = fract(u - static_cast<float>(t) * 0.9f * motion()) < 0.25f ? 1.0f : 0.25f;
        f.at(-2.2f - u * 6.0f, 0, 0, x, y, z);
        dot(x, 0.1f, z, 6.0f, 0.22f, kGreen, on);
    }
    for (int side = -1; side <= 1; side += 2) {
        const float w = 0.6f * wave(t, 3.0, side * 1.5f);
        f.at(2.7f, side * (0.5f + w * 0.3f), 0.2f + w, x, y, z);
        glow(x, std::max(y, 0.3f), z, 0.5f * f.s, {1.0f, 0.5f, 0.1f}, 0.95f);
    }
    f.at(2.7f, 0, 0, x, y, z);
    cube(x, 0.45f, z, 0.25f, 0.9f, 0.25f, {0.95f, 0.75f, 0.1f});
}

// A yellow hold-short bar ahead of it and lights circling the cockpit.
inline void drawHoldShort(const Frame& f, bool airborne, double t) {
    float x0, y0, z0, x1, y1, z1, x, y, z;
    const float gy = airborne ? f.y - 0.4f * f.s : 0.07f;
    for (int k = 0; k < 2; ++k) {
        f.at(2.1f + k * 0.25f, -1.4f, 0, x0, y0, z0);
        f.at(2.1f + k * 0.25f, 1.4f, 0, x1, y1, z1);
        line(x0, gy, z0, x1, gy, z1, {1.0f, 0.8f, 0.1f}, 0.95f);
    }
    for (int k = 0; k < 3; ++k) {
        const float a = static_cast<float>(t) * 0.8f * motion() + k * 2.0944f;
        f.at(1.0f + std::cos(a) * 0.6f, std::sin(a) * 0.6f, 1.0f + 0.1f * k, x, y, z);
        glow(x, y, z, 0.45f * f.s, {1.0f, 0.95f, 0.6f}, 0.85f);
    }
}

// A slow violet beacon turning on the roof.
inline void drawRoofBeacon(const Frame& f, double t) {
    const Rgb violet{0.7f, 0.5f, 1.0f};
    float x, y, z;
    f.at(0.0f, 0, 0.6f, x, y, z);
    ball(x, y, z, 0.25f * f.s, {0.6f, 0.4f, 0.9f});
    const float a = static_cast<float>(t) * 3.0f * motion();
    line(x, y, z, x + std::cos(a) * 1.5f * f.s, y, z + std::sin(a) * 1.5f * f.s, violet, 0.9f);
    glow(x, y, z, 0.9f * f.s, violet, 0.7f);
}

inline void drawAction(agentviz::Action action, const Frame& f, bool airborne, float phase, float seed, double t) {
    using agentviz::Action;
    switch (action) {
        case Action::Edit:
            if (airborne) drawSlungCrate(f, phase, t);
            else drawBeltLoader(f, t);
            break;
        case Action::Run: drawExhaust(f, seed, t); break;
        case Action::Read: drawRadar(f, airborne, phase, t); break;
        case Action::Web: drawRadioRings(f, t); break;
        case Action::Delegate: drawLaunch(f, t); break;
        case Action::Think: drawHoldShort(f, airborne, t); break;
        case Action::Other: drawRoofBeacon(f, t); break;
        default: break;
    }
}

}  // namespace atc
