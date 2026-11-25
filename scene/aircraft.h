// aircraft.h: one aircraft per session (large) or subagent (small), from its
// agent record (atc-frame.js extras: scale, airborne, holding rank, seconds
// in state, gate x/z, family selected). The airframe in the lead's livery,
// its lights, and the state overlays: the holding beacon with why it waits,
// stalled hazard lights, the radio call on each new tool call, and the
// selection ring. What it is doing now is in actions.h.
#pragma once

#include "actions.h"

namespace atc {

struct Craft {
    const agentviz::Agent& agent;
    Frame frame;        // position, heading and scale
    float airborne, rank, age, phase;
    bool family;        // its lead is selected
};

inline Craft craftOf(const agentviz::Agent& a) {
    const float s = a.extra[0], h = a.facing;
    return {a, {a.x, a.y, a.z, std::cos(h), std::sin(h), -std::sin(h), std::cos(h), s},
        a.extra[1], a.extra[2], a.extra[3], a.seed * 6.2831853f, a.extra[6] > 0.5f};
}

struct Livery {
    Rgb body{0.92f, 0.92f, 0.90f}, stripe, dark{0.12f, 0.13f, 0.15f};
};

// Bright while working or holding; faded when idle, dim or offline.
inline Livery liveryOf(const agentviz::Agent& a) {
    Livery l;
    l.stripe = hueColor(a.parentSeed, 0.75f, 0.85f);
    using agentviz::State;
    if (a.state == State::Offline) {
        l.body = {0.30f, 0.30f, 0.31f};
        l.stripe = {0.26f, 0.26f, 0.27f};
    } else if (a.state == State::Dim) {
        l.body = {0.5f, 0.5f, 0.5f};
        l.stripe = scl(l.stripe, 0.5f);
    } else if (a.state == State::Idle) {
        l.body = {0.7f, 0.7f, 0.68f};
        l.stripe = scl(l.stripe, 0.7f);
    }
    return l;
}

// Fuselage (a chain of spheres, fat in the middle, a livery stripe), swept
// wings with engines, tailplane, and the fin in the lead's colour.
inline void drawAirframe(const Frame& f, const Livery& l) {
    float x, y, z;
    for (int k = -4; k <= 4; ++k) {
        const float d = (0.62f - 0.035f * k * k) * f.s;
        f.at(k * 0.38f, 0, 0, x, y, z);
        ball(x, y, z, d, k == 4 ? l.dark : (k == 1 || k == -1 ? l.stripe : l.body));
    }
    const Rgb engine{0.45f, 0.46f, 0.5f};
    for (int side = -1; side <= 1; side += 2) {
        for (int k = 1; k <= 5; ++k) {
            const float r = k * 0.38f, chord = (0.75f - 0.08f * k) * f.s;
            f.at(0.15f - r * 0.4f, side * r, -0.05f, x, y, z);
            sph(x, y, z, chord, 0.09f * f.s, chord, l.body);
        }
        for (float fwd : {0.3f, 0.05f}) {
            f.at(fwd, side * 0.8f, -0.22f, x, y, z);
            ball(x, y, z, 0.3f * f.s, engine);
        }
        for (int k = 1; k <= 2; ++k) {
            f.at(-1.45f - k * 0.08f, side * k * 0.3f, 0.05f, x, y, z);
            sph(x, y, z, 0.35f * f.s, 0.07f * f.s, 0.35f * f.s, l.body);
        }
    }
    for (int k = 0; k < 3; ++k) {
        f.at(-1.4f - k * 0.1f, 0, 0.25f + k * 0.22f, x, y, z);
        sph(x, y, z, 0.42f * f.s, 0.32f * f.s, 0.12f * f.s + 0.05f, l.stripe);
    }
}

// Nav lights and a strobe while working or holding.
inline void drawNavLights(const Craft& c, double t) {
    const Frame& f = c.frame;
    float x, y, z;
    f.at(-0.25f, -2.0f, -0.05f, x, y, z);
    dot(x, y, z, 4.0f, 0.15f * f.s, kRed, 1.0f);
    f.at(-0.25f, 2.0f, -0.05f, x, y, z);
    dot(x, y, z, 4.0f, 0.15f * f.s, kGreen, 1.0f);
    if (blink(t, 1.1, c.agent.seed, 0.12f) > 0.5f) {
        f.at(-1.7f, 0, 0.9f, x, y, z);
        glow(x, y, z, 0.8f * f.s, kWhite, 0.9f);
    }
}

// A question: a "?" hangs over the beacon. A permission prompt: a padlock.
inline void drawWaitingReason(const Craft& c, float x, float y, float z) {
    const float s = c.frame.s;
    if (c.agent.waitingReason == agentviz::WaitingReason::Question) {
        H().label(x, y + 1.3f * s, z, "?", 26.0f, kQuestion);
        return;
    }
    if (c.agent.waitingReason != agentviz::WaitingReason::Permission) return;
    const Rgb gold{1.0f, 0.78f, 0.25f};
    const float by = y + 1.1f * s;
    cube(x, by, z, 0.5f * s, 0.4f * s, 0.28f * s, gold);
    for (int k = 0; k <= 8; ++k) {  // the shackle: a half ring of beads
        const float a = kPi * k / 8.0f;
        ball(x + std::cos(a) * 0.17f * s, by + 0.2f * s + std::sin(a) * 0.22f * s, z, 0.09f * s, {0.85f, 0.85f, 0.88f});
    }
}

// Holding: a big pulsing beacon, faster the longer it has waited.
inline void drawHoldingBeacon(const Craft& c, double t) {
    const float s = c.frame.s;
    const float rate = 3.0f + std::min(c.age / 60.0f, 6.0f);
    const float beat = 0.5f + 0.5f * wave(t, rate, c.phase);
    float x, y, z;
    c.frame.at(0, 0, 0.9f, x, y, z);
    ball(x, y, z, 0.4f * s, scl(kRed, 0.5f + 0.5f * beat));
    glow(x, y, z, (2.2f + 2.2f * beat) * s, kRed, 0.9f);
    glow(x, y, z, (6.0f + 3.0f * beat) * s, {1.0f, 0.3f, 0.1f}, 0.22f);
    H().light(x, y, z, 6.0f, kRed, 1.0f + 1.5f * beat, 9 - std::min(static_cast<int>(c.rank), 5));
    drawWaitingReason(c, x, y, z);
}

// Stalled: three amber hazard lights turning over it and a ring on the ground.
inline void drawStalled(const Craft& c, double t) {
    const Frame& f = c.frame;
    const float on = blink(t, 1.6, c.agent.seed, 0.5f);
    float x, y, z;
    for (int k = 0; k < 3; ++k) {
        const float a = k * 2.0944f + static_cast<float>(t) * motion();
        f.at(std::cos(a) * 0.9f, std::sin(a) * 0.9f, 1.4f, x, y, z);
        ball(x, y, z, 0.28f * f.s, scl(kAmber, 0.3f + 0.7f * on));
        if (on > 0.5f) glow(x, y, z, 1.2f * f.s, kAmber, 0.9f);
    }
    circle(f.x, 0.06f, f.z, 2.6f * f.s, kAmber, 0.3f + 0.6f * on, 28);
}

// A new tool call: the landing light flashes and a radio ring goes out.
inline void drawRadioCall(const Craft& c) {
    const float p = c.agent.pulse, s = c.frame.s;
    float x, y, z;
    c.frame.at(1.6f, 0, 0, x, y, z);
    glow(x, y, z, (0.6f + 0.8f * p) * s, kWhite, 0.9f * p);
    circle(c.frame.x, c.frame.y, c.frame.z, (1.2f + 2.6f * (1.0f - p)) * s, kCyan, 0.8f * p, 32);
}

// Selected: a bright ring (and a plumb line when airborne). Its lead
// selected: a faint one. Hovered: fainter still.
inline void drawSelection(const Craft& c, double t) {
    using agentviz::Highlight;
    const Highlight hl = c.agent.highlight;
    const float alpha = hl == Highlight::Selected ? 0.95f : c.family ? 0.5f : hl == Highlight::Hovered ? 0.35f : 0.0f;
    if (alpha <= 0.0f) return;
    const Frame& f = c.frame;
    const float r = 2.6f * f.s + 0.15f * wave(t, 4.0, 0.0f);
    circle(f.x, std::max(f.y - 0.4f * f.s, 0.05f), f.z, r, kWhite, alpha, 40);
    if (hl == Highlight::Selected && c.airborne > 0.5f) line(f.x, f.y, f.z, f.x, 0.05f, f.z, kWhite, 0.35f);
}

inline void drawAircraft(const agentviz::Agent& a, double t) {
    const Craft c = craftOf(a);
    drawAirframe(c.frame, liveryOf(a));
    if (a.state == agentviz::State::Busy || a.waiting()) drawNavLights(c, t);
    if (a.waiting()) drawHoldingBeacon(c, t);
    if (a.stalled) drawStalled(c, t);
    if (a.pulse > 0.01f) drawRadioCall(c);
    drawSelection(c, t);
    if (a.state == agentviz::State::Busy) drawAction(a.action, c.frame, c.airborne > 0.5f, c.phase, a.seed, t);
}

}  // namespace atc
