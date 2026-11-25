// agentviz-atc: Claude Code sessions as air traffic control, on Strata.
//
// The control tower in the middle is the owner. Each place (repo) is an
// airport on a ring round it; each session is an aircraft at a gate there;
// its subagents are smaller aircraft flying out from their lead's gate and
// back. A session waiting on the owner leaves its gate and joins the holding
// stack circling the tower, with a pulsing beacon: that is the point of the
// page. The tower's lamps count the aircraft holding.
//
// The page (web/atc.js) owns the data, layout and motion: it polls
// /api/agents, eases every aircraft toward where its state puts it, and hands
// this module rows of floats each frame. This file only draws them.
#define STRATA_KIT_MAIN
#include "strata_kit.h"

#include <cmath>
#include <vector>

namespace {

using strata_kit::Rgb;
constexpr float kPi = 3.14159265f;

// Airport row: cx, cz, ux, uz (unit vector from the tower out), half width
// along the tangent, hue, waiting count, sessions.
constexpr int kAirportStride = 8;
// Plane row: x, y, z, heading (radians, forward = (cos, sin) in x/z), scale,
// state, action, hue, selected (0/1/2), stalled (0/1), airborne (0..1), seed,
// wait rank (-1 none), state age (seconds).
constexpr int kPlaneStride = 14;
// Line row: x0, y0, z0, x1, y1, z1, r, g, b, a.
constexpr int kLineStride = 10;

enum State { kOffline = 0, kDim, kIdle, kBusy, kWaiting };
enum Action { kNone = 0, kEdit, kRun, kRead, kWeb, kDelegate, kThink, kOther };

struct World {
    std::vector<float> airports, planes, lines;
    float extent = 40.0f;
    int waiting = 0;
    bool airportsSet = false;
    double sceneTime = -1.0;
};
World g;

strata_kit::Host& H() { return strata_kit::host(); }

Rgb mix(Rgb a, Rgb b, float t) { return {a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t}; }
Rgb scl(Rgb a, float k) { return {a.r * k, a.g * k, a.b * k}; }

Rgb hueColor(float h, float sat, float val) {
    auto ch = [&](float o) {
        const float k = std::fmod(h * 6.0f + o, 6.0f);
        const float x = std::clamp(std::min(k, 4.0f - k), 0.0f, 1.0f);
        return val * (1.0f - sat * x);
    };
    return {ch(5.0f), ch(3.0f), ch(1.0f)};
}

float fract(float x) { return x - std::floor(x); }
float wave(double t, double rate, float phase) {
    return H().reducedMotion ? 0.0f : static_cast<float>(std::sin(t * rate + phase));
}
float blink(double t, double rate, float phase, float duty) {
    if (H().reducedMotion) return 1.0f;
    return fract(static_cast<float>(t * rate) + phase) < duty ? 1.0f : 0.0f;
}

void sph(float x, float y, float z, float sx, float sy, float sz, Rgb c) {
    H().add(STRATA_PRIMITIVE_SPHERE, x, y, z, sx, sy, sz, c);
}
void cube(float x, float y, float z, float sx, float sy, float sz, Rgb c) {
    H().add(STRATA_PRIMITIVE_CUBE, x, y, z, sx, sy, sz, c);
}
void cyl(float x, float y, float z, float r, float halfH, Rgb c) {
    H().add(STRATA_PRIMITIVE_CYLINDER, x, y, z, r * 2.0f, halfH, r * 2.0f, c);
}
void glow(float x, float y, float z, float px, float world, Rgb c, float a) { H().point(x, y, z, px, world, c, a); }
void dot(float x, float y, float z, float px, float world, Rgb c, float a) {
    H().point(x, y, z, px, world, c, a, 0u);
}
void line(float x0, float y0, float z0, float x1, float y1, float z1, Rgb c, float a) {
    H().line(x0, y0, z0, x1, y1, z1, c, a);
}
void circle(float x, float y, float z, float r, Rgb c, float a, int n = 32) {
    for (int k = 0; k < n; ++k) {
        const float a0 = k * 2.0f * kPi / n, a1 = (k + 1) * 2.0f * kPi / n;
        line(x + std::cos(a0) * r, y, z + std::sin(a0) * r, x + std::cos(a1) * r, y, z + std::sin(a1) * r, c, a);
    }
}

const Rgb kRed{1.0f, 0.12f, 0.06f}, kAmber{1.0f, 0.62f, 0.05f}, kGreen{0.2f, 1.0f, 0.35f},
    kCyan{0.25f, 0.75f, 1.0f}, kWhite{1.0f, 1.0f, 1.0f};

// ------------------------------------------------------------------ terrain

float smooth01(float e0, float e1, float x) {
    const float t = std::clamp((x - e0) / (e1 - e0), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}
// Coverage of a band |d| < half, softened by one cell.
float band(float d, float half, float soft) { return 1.0f - smooth01(half - soft, half + soft, std::fabs(d)); }
float boxCov(float a, float a0, float a1, float b, float halfB, float soft) {
    return band(a - (a0 + a1) * 0.5f, (a1 - a0) * 0.5f, soft) * band(b, halfB, soft);
}

void setTerrain() {
    auto& h = H();
    const float ext = g.extent;
    const float cell = 0.4f;
    const int n = std::min(1025, static_cast<int>(2.0f * ext / cell) + 1);
    const float c = 2.0f * ext / (n - 1), x0 = -ext;
    std::vector<float> heights(static_cast<size_t>(n) * n, 0.0f), colors(static_cast<size_t>(n) * n * 3);
    const Rgb grassA{0.10f, 0.20f, 0.07f}, grassB{0.15f, 0.26f, 0.09f}, concrete{0.40f, 0.40f, 0.38f},
        asphalt{0.09f, 0.09f, 0.10f}, paint{0.85f, 0.85f, 0.82f}, yellow{0.85f, 0.65f, 0.10f};
    const float soft = c * 0.7f;
    for (int j = 0; j < n; ++j)
        for (int i = 0; i < n; ++i) {
            const float x = x0 + i * c, z = x0 + j * c;
            const size_t k = static_cast<size_t>(j) * n + i;
            // Mown stripes of grass.
            const float stripe = 0.5f + 0.5f * std::sin((x * 0.7f + z * 0.7f) * 0.9f);
            Rgb col = mix(grassA, grassB, stripe * 0.6f + 0.2f * std::sin(x * 0.13f) * std::cos(z * 0.11f));
            const float r = std::sqrt(x * x + z * z);
            // The tower's plaza, its ring road and a service road to each airport.
            col = mix(col, concrete, band(r, 4.5f, soft));
            col = mix(col, asphalt, band(r - 9.0f, 0.5f, soft));
            for (size_t p = 0; p + kAirportStride <= g.airports.size(); p += kAirportStride) {
                const float* ap = &g.airports[p];
                const float ux = ap[2], uz = ap[3], hw = ap[4];
                const float dx = x - ap[0], dz = z - ap[1];
                const float a = dx * ux + dz * uz;        // out from the tower
                const float b = -dx * uz + dz * ux;       // along the tangent
                const float rr = x * ux + z * uz, side = -x * uz + z * ux;
                const float roadLen = std::sqrt(ap[0] * ap[0] + ap[1] * ap[1]) - 5.5f;
                col = mix(col, asphalt, band(side, 0.45f, soft) * (rr > 4.0f && rr < roadLen ? 1.0f : 0.0f));
                // Apron, hangar pad, taxiway, runway.
                col = mix(col, concrete, boxCov(a, -5.0f, 3.0f, b, hw + 1.0f, soft));
                col = mix(col, concrete, boxCov(a, -5.0f, -0.5f, b + hw + 4.5f, 3.5f, soft));
                col = mix(col, asphalt, boxCov(a, 2.5f, 7.0f, b - (hw + 2.2f), 0.8f, soft));
                col = mix(col, yellow, boxCov(a, 2.8f, 6.6f, b - (hw + 2.2f), 0.07f, soft) * 0.8f);
                const float rwHalf = hw + 8.0f;
                col = mix(col, asphalt, boxCov(a, 6.0f, 8.6f, b, rwHalf, soft));
                const float dash = fract(b / 2.4f) < 0.5f ? 1.0f : 0.0f;
                col = mix(col, paint, boxCov(a, 7.18f, 7.42f, b, rwHalf - 2.0f, soft) * dash * 0.9f);
                // Threshold bars at both ends.
                for (int e = -1; e <= 1; e += 2) {
                    const float bb = b - e * (rwHalf - 0.9f);
                    const float bars = fract((a - 6.0f) / 0.52f) < 0.5f ? 1.0f : 0.0f;
                    col = mix(col, paint, boxCov(a, 6.3f, 8.3f, bb, 0.6f, soft) * bars * 0.9f);
                }
                // Apron edge line.
                col = mix(col, yellow, band(a - 2.7f, 0.08f, soft) * band(b, hw + 0.8f, soft) * 0.7f);
            }
            colors[k * 3] = col.r;
            colors[k * 3 + 1] = col.g;
            colors[k * 3 + 2] = col.b;
        }
    StrataTerrainTile tile{};
    tile.origin[0] = x0;
    tile.origin[1] = 0.0f;
    tile.origin[2] = x0;
    tile.cell_size = c;
    tile.samples_x = n;
    tile.samples_z = n;
    tile.heights = heights.data();
    tile.colors = colors.data();
    tile.color[3] = 1.0f;
    strata_set_terrain(h.engine, &tile);
    h.terrainSamples = n * n;
}

// ------------------------------------------------------------------ tower

void buildTower(double t) {
    const Rgb concrete{0.55f, 0.55f, 0.53f}, dark{0.08f, 0.09f, 0.11f};
    cyl(0, 0.4f, 0, 2.2f, 0.4f, {0.35f, 0.35f, 0.34f});
    cyl(0, 3.8f, 0, 0.9f, 3.4f, concrete);
    cyl(0, 7.3f, 0, 1.4f, 0.12f, concrete);
    const int w = g.waiting;
    // The cab: tinted glass that turns red while anything is holding.
    const float p = 0.5f + 0.5f * wave(t, 5.0, 0.0f);
    const Rgb glass = w > 0 ? mix({0.25f, 0.05f, 0.04f}, {0.9f, 0.12f, 0.06f}, p) : Rgb{0.10f, 0.22f, 0.25f};
    cyl(0, 7.95f, 0, 1.75f, 0.55f, glass);
    cyl(0, 8.6f, 0, 1.95f, 0.1f, dark);
    cyl(0, 8.8f, 0, 1.1f, 0.12f, concrete);
    cube(0, 9.6f, 0, 0.06f, 1.6f, 0.06f, dark);
    // Eight lamps round the cab: one lit per aircraft holding.
    for (int i = 0; i < 8; ++i) {
        const float a = i * 2.0f * kPi / 8.0f + 0.2f;
        const float x = std::cos(a) * 2.0f, z = std::sin(a) * 2.0f;
        const bool lit = i < w;
        sph(x, 8.75f, z, 0.32f, 0.32f, 0.32f, lit ? scl(kRed, 0.6f + 0.4f * p) : Rgb{0.05f, 0.12f, 0.06f});
        if (lit) glow(x, 8.75f, z, 0.0f, 1.3f + 0.4f * p, kRed, 0.85f);
    }
    // The beacon on the mast: steady green when nothing needs the owner,
    // flashing red when something does.
    if (w > 0) {
        const float f = 0.35f + 0.65f * p;
        sph(0, 10.5f, 0, 0.45f, 0.45f, 0.45f, scl(kRed, f));
        glow(0, 10.5f, 0, 0.0f, 3.0f + 2.0f * p, kRed, 0.9f);
        glow(0, 8.0f, 0, 0.0f, 9.0f + 3.0f * p, kRed, 0.18f);
        H().light(0, 9.0f, 0, 14.0f, kRed, 1.2f + 1.5f * p, 10);
    } else {
        sph(0, 10.5f, 0, 0.35f, 0.35f, 0.35f, kGreen);
        glow(0, 10.5f, 0, 0.0f, 1.6f, kGreen, 0.7f);
        H().light(0, 9.0f, 0, 9.0f, kGreen, 0.6f, 2);
    }
#if STRATA_ABI_MINOR >= 14
    char buf[48];
    if (w > 0)
        std::snprintf(buf, sizeof buf, "%d HOLDING", w);
    else
        std::snprintf(buf, sizeof buf, "ALL CLEAR");
    H().label(0, 5.6f, 0, buf, w > 0 ? 20.0f : 13.0f, w > 0 ? Rgb{1.0f, 0.35f, 0.25f} : Rgb{0.6f, 1.0f, 0.7f});
#endif
}

// ------------------------------------------------------------------ airports

void buildAirport(const float* ap, double t) {
    const float cx = ap[0], cz = ap[1], ux = ap[2], uz = ap[3], hw = ap[4], hue = ap[5];
    const float vx = -uz, vz = ux;
    const int waiting = static_cast<int>(ap[6]);
    auto P = [&](float a, float b, float& x, float& z) {
        x = cx + ux * a + vx * b;
        z = cz + uz * a + vz * b;
    };
    float x, z;
    // A round terminal on the tower side of the apron, roof in the place's colour.
    P(-4.8f, 0.0f, x, z);
    const float tr = std::min(1.6f + hw * 0.15f, 3.0f);
    cyl(x, 0.75f, z, tr, 0.75f, {0.62f, 0.62f, 0.60f});
    cyl(x, 1.6f, z, tr * 0.92f, 0.12f, hueColor(hue, 0.55f, 0.55f));
    cyl(x, 2.3f, z, 0.25f, 0.6f, {0.5f, 0.5f, 0.5f});
    // The airport's own beacon flashes red too while one of its aircraft holds.
    if (waiting > 0) {
        const float f = blink(t, 1.5, 0.0f, 0.5f);
        sph(x, 3.05f, z, 0.35f, 0.35f, 0.35f, scl(kRed, 0.3f + 0.7f * f));
        if (f > 0.5f) glow(x, 3.05f, z, 0.0f, 2.2f, kRed, 0.8f);
    } else {
        sph(x, 3.05f, z, 0.3f, 0.3f, 0.3f, {0.9f, 0.85f, 0.6f});
    }
    // The hangar: where offline aircraft sit, greyed.
    P(-3.6f, -(hw + 4.5f), x, z);
    cube(x, 0.9f, z, 3.2f, 1.8f, 3.2f, {0.30f, 0.32f, 0.34f});
    sph(x, 1.8f, z, 3.2f, 1.1f, 3.2f, {0.36f, 0.38f, 0.40f});
    // Runway edge lights.
    const float rwHalf = hw + 8.0f;
    for (float b = -rwHalf; b <= rwHalf + 0.01f; b += 2.0f) {
        for (float a : {6.05f, 8.55f}) {
            P(a, b, x, z);
            dot(x, 0.08f, z, 3.0f, 0.12f, {0.95f, 0.9f, 0.7f}, 0.9f);
        }
    }
    for (int e = -1; e <= 1; e += 2)
        for (float a = 6.2f; a < 8.5f; a += 0.45f) {
            P(a, e * (rwHalf + 0.1f), x, z);
            dot(x, 0.08f, z, 3.5f, 0.14f, e < 0 ? kGreen : kRed, 0.9f);
        }
}

// ------------------------------------------------------------------ aircraft

struct Frame {
    float x, y, z, fx, fz, rx, rz, s;
    // A point at (forward, right, up) in the aircraft's frame.
    void at(float f, float r, float u, float& ox, float& oy, float& oz) const {
        ox = x + (fx * f + rx * r) * s;
        oz = z + (fz * f + rz * r) * s;
        oy = y + u * s;
    }
};

void buildPlane(const float* p, double t) {
    const float x = p[0], y = p[1], z = p[2], hd = p[3], s = p[4];
    const int state = static_cast<int>(p[5]), action = static_cast<int>(p[6]);
    const float hue = p[7], seed = p[11], age = p[13];
    const int sel = static_cast<int>(p[8]);
    const bool stalled = p[9] > 0.5f;
    const float air = p[10];
    const int rank = static_cast<int>(p[12]);
    Frame fr{x, y, z, std::cos(hd), std::sin(hd), -std::sin(hd), std::cos(hd), s};
    const float ph = seed * 6.2831853f;

    Rgb body{0.92f, 0.92f, 0.90f}, livery = hueColor(hue, 0.75f, 0.85f), dark{0.12f, 0.13f, 0.15f};
    if (state == kOffline) {
        body = {0.30f, 0.30f, 0.31f};
        livery = {0.26f, 0.26f, 0.27f};
    } else if (state == kDim) {
        body = {0.5f, 0.5f, 0.5f};
        livery = scl(livery, 0.5f);
    } else if (state == kIdle) {
        body = {0.7f, 0.7f, 0.68f};
        livery = scl(livery, 0.7f);
    }
    float ox, oy, oz;
    // Fuselage: a chain of spheres, fat in the middle; a livery stripe.
    for (int k = -4; k <= 4; ++k) {
        const float f = k * 0.38f;
        const float d = 0.62f - 0.035f * k * k;
        fr.at(f, 0, 0, ox, oy, oz);
        const Rgb c = (k == 4) ? dark : (k == 1 || k == -1 ? livery : body);
        sph(ox, oy, oz, d * s, d * s, d * s, c);
    }
    // Wings, swept back, and the engines under them.
    for (int side = -1; side <= 1; side += 2) {
        for (int k = 1; k <= 5; ++k) {
            const float r = k * 0.38f;
            const float chord = 0.75f - 0.08f * k;
            fr.at(0.15f - r * 0.4f, side * r, -0.05f, ox, oy, oz);
            sph(ox, oy, oz, chord * s, 0.09f * s, chord * s, body);
        }
        fr.at(0.3f, side * 0.8f, -0.22f, ox, oy, oz);
        sph(ox, oy, oz, 0.3f * s, 0.3f * s, 0.3f * s, {0.45f, 0.46f, 0.5f});
        fr.at(0.05f, side * 0.8f, -0.22f, ox, oy, oz);
        sph(ox, oy, oz, 0.3f * s, 0.3f * s, 0.3f * s, {0.45f, 0.46f, 0.5f});
        // Tailplane.
        for (int k = 1; k <= 2; ++k) {
            fr.at(-1.45f - k * 0.08f, side * k * 0.3f, 0.05f, ox, oy, oz);
            sph(ox, oy, oz, 0.35f * s, 0.07f * s, 0.35f * s, body);
        }
    }
    // The fin, in the lead's colour: a lead and its subagents share it.
    for (int k = 0; k < 3; ++k) {
        fr.at(-1.4f - k * 0.1f, 0, 0.25f + k * 0.22f, ox, oy, oz);
        sph(ox, oy, oz, 0.42f * s, 0.32f * s, 0.12f * s + 0.05f, livery);
    }

    // Lights: nav lights and a strobe while working; nothing parked or offline.
    const bool lit = state == kBusy || state == kWaiting;
    if (lit) {
        fr.at(-0.25f, -2.0f, -0.05f, ox, oy, oz);
        dot(ox, oy, oz, 4.0f, 0.15f * s, kRed, 1.0f);
        fr.at(-0.25f, 2.0f, -0.05f, ox, oy, oz);
        dot(ox, oy, oz, 4.0f, 0.15f * s, kGreen, 1.0f);
        if (blink(t, 1.1, seed, 0.12f) > 0.5f) {
            fr.at(-1.7f, 0, 0.9f, ox, oy, oz);
            glow(ox, oy, oz, 0.0f, 0.8f * s, kWhite, 0.9f);
        }
    }

    // A waiting aircraft: a big pulsing beacon, faster the longer it holds.
    if (state == kWaiting) {
        const float rate = 3.0f + std::min(age / 60.0f, 6.0f);
        const float pu = 0.5f + 0.5f * wave(t, rate, ph);
        fr.at(0, 0, 0.9f, ox, oy, oz);
        sph(ox, oy, oz, 0.4f * s, 0.4f * s, 0.4f * s, scl(kRed, 0.5f + 0.5f * pu));
        glow(ox, oy, oz, 0.0f, (2.2f + 2.2f * pu) * s, kRed, 0.9f);
        glow(ox, oy, oz, 0.0f, (6.0f + 3.0f * pu) * s, {1.0f, 0.3f, 0.1f}, 0.22f);
        H().light(ox, oy, oz, 6.0f, kRed, 1.0f + 1.5f * pu, 9 - std::min(rank, 5));
    }
    // Stalled: flashing amber hazard lights over it and a ring on the ground.
    if (stalled) {
        const float on = blink(t, 1.6, seed, 0.5f);
        for (int k = 0; k < 3; ++k) {
            const float a = k * 2.0944f + static_cast<float>(t) * (H().reducedMotion ? 0.0f : 1.0f);
            fr.at(std::cos(a) * 0.9f, std::sin(a) * 0.9f, 1.4f, ox, oy, oz);
            sph(ox, oy, oz, 0.28f * s, 0.28f * s, 0.28f * s, scl(kAmber, 0.3f + 0.7f * on));
            if (on > 0.5f) glow(ox, oy, oz, 0.0f, 1.2f * s, kAmber, 0.9f);
        }
        circle(x, 0.06f, z, 2.6f * s, kAmber, 0.3f + 0.6f * on, 28);
    }
    // Selection ring.
    if (sel > 0) {
        const float r = 2.6f * s + 0.15f * wave(t, 4.0, 0.0f);
        circle(x, std::max(y - 0.4f * s, 0.05f), z, r, kWhite, sel == 2 ? 0.95f : 0.5f, 40);
        if (air > 0.5f) line(x, y, z, x, 0.05f, z, kWhite, 0.35f);
    }

    if (state != kBusy) return;
    // ---- what it is doing now
    const float sp = H().reducedMotion ? 0.0f : 1.0f;
    switch (action) {
        case kEdit: {  // cargo loading: a belt loader carrying crates up to the hold
            const Rgb crate{0.62f, 0.38f, 0.14f};
            float bx0, by0, bz0, bx1, by1, bz1;
            if (air < 0.5f) {
                fr.at(0.5f, 2.6f, -0.45f, bx0, by0, bz0);
                bx0 = bx0; by0 = std::max(y - 0.4f * s, 0.15f);
                fr.at(0.5f, 0.5f, 0.05f, bx1, by1, bz1);
                for (int k = 0; k <= 6; ++k) {
                    const float u = k / 6.0f;
                    cube(bx0 + (bx1 - bx0) * u, by0 + (by1 - by0) * u - 0.08f, bz0 + (bz1 - bz0) * u, 0.18f * s,
                         0.08f * s, 0.18f * s, {0.18f, 0.18f, 0.2f});
                }
                fr.at(0.5f, 3.4f, 0.0f, ox, oy, oz);
                cube(ox, by0 + 0.15f, oz, 0.9f * s, 0.3f * s, 0.9f * s, {0.85f, 0.6f, 0.1f});
                cube(ox, by0 + 0.45f * s, oz, 0.4f * s, 0.35f * s, 0.4f * s, crate);
                for (int k = 0; k < 3; ++k) {
                    const float u = fract(static_cast<float>(t) * 0.45f * sp + k / 3.0f);
                    cube(bx0 + (bx1 - bx0) * u, by0 + (by1 - by0) * u + 0.12f * s, bz0 + (bz1 - bz0) * u,
                         0.3f * s, 0.25f * s, 0.3f * s, crate);
                }
            } else {  // in flight: a crate slung underneath, swinging
                const float sw = 0.3f * wave(t, 2.0, ph);
                fr.at(sw, 0, -1.6f, ox, oy, oz);
                line(x, y - 0.3f * s, z, ox, oy, oz, {0.8f, 0.8f, 0.8f}, 0.8f);
                cube(ox, oy, oz, 0.5f * s, 0.4f * s, 0.5f * s, crate);
            }
            break;
        }
        case kRun: {  // engines spooling: exhaust streaming from both engines
            for (int side = -1; side <= 1; side += 2) {
                fr.at(-0.2f, side * 0.8f, -0.22f, ox, oy, oz);
                glow(ox, oy, oz, 0.0f, 0.55f * s, {1.0f, 0.55f, 0.15f}, 0.9f);
                for (int k = 0; k < 9; ++k) {
                    const float u = fract(static_cast<float>(t) * 1.4f * sp + k / 9.0f + seed);
                    fr.at(-0.3f - u * 3.2f, side * (0.8f + u * 0.15f), -0.22f + u * 0.35f, ox, oy, oz);
                    const Rgb c = mix({1.0f, 0.6f, 0.2f}, {0.55f, 0.55f, 0.58f}, std::min(u * 2.0f, 1.0f));
                    glow(ox, oy, oz, 0.0f, (0.35f + u * 1.1f) * s, c, 0.75f * (1.0f - u));
                }
            }
            H().light(x - fr.fx * 1.5f * s, y, z - fr.fz * 1.5f * s, 3.0f * s, {1.0f, 0.5f, 0.15f}, 0.7f, 1);
            break;
        }
        case kRead: {  // radar sweep: a green scope round it, the beam turning
            fr.at(0.3f, 0, 0.55f, ox, oy, oz);
            sph(ox, oy, oz, 0.42f * s, 0.25f * s, 0.42f * s, {0.85f, 0.85f, 0.82f});
            const float gy = air > 0.5f ? y - 0.3f * s : 0.07f;
            const float R = 3.0f * s;
            circle(x, gy, z, R, kGreen, 0.55f, 36);
            circle(x, gy, z, R * 0.5f, kGreen, 0.3f, 24);
            const float a0 = static_cast<float>(t) * 2.2f * sp + ph;
            for (int k = 0; k < 7; ++k) {
                const float a = a0 - k * 0.09f;
                line(x, gy, z, x + std::cos(a) * R, gy, z + std::sin(a) * R, kGreen, 0.95f - k * 0.13f);
            }
            dot(x + std::cos(a0) * R, gy, z + std::sin(a0) * R, 5.0f, 0.2f, kGreen, 1.0f);
            break;
        }
        case kWeb: {  // long-range radio beacon: a mast, rings going out from its tip
            fr.at(0.1f, 0, 0.3f, ox, oy, oz);
            const float top = oy + 2.4f * s;
            line(ox, oy, oz, ox, top, oz, {0.8f, 0.85f, 0.9f}, 1.0f);
            dot(ox, top, oz, 6.0f, 0.18f * s, kCyan, 1.0f);
            for (int k = 0; k < 3; ++k) {
                const float u = fract(static_cast<float>(t) * 0.6f * sp + k / 3.0f);
                circle(ox, top, oz, (0.3f + u * 3.2f) * s, kCyan, 0.9f * (1.0f - u), 28);
            }
            break;
        }
        case kDelegate: {  // the gate launching flights: chase lights out to the field
            for (int k = 0; k < 10; ++k) {
                const float u = k / 10.0f;
                const float on = fract(u - static_cast<float>(t) * 0.9f * sp) < 0.25f ? 1.0f : 0.25f;
                fr.at(-2.2f - u * 6.0f, 0, 0, ox, oy, oz);
                dot(ox, 0.1f, oz, 6.0f, 0.22f, kGreen, on);
            }
            for (int side = -1; side <= 1; side += 2) {  // the marshaller's wands
                const float wv = 0.6f * wave(t, 3.0, side * 1.5f);
                fr.at(2.7f, side * (0.5f + wv * 0.3f), 0.2f + wv, ox, oy, oz);
                glow(ox, std::max(oy, 0.3f), oz, 0.0f, 0.5f * s, {1.0f, 0.5f, 0.1f}, 0.95f);
            }
            fr.at(2.7f, 0, 0, ox, oy, oz);
            cube(ox, 0.45f, oz, 0.25f, 0.9f, 0.25f, {0.95f, 0.75f, 0.1f});
            break;
        }
        case kThink: {  // holding at the gate: a hold-short bar and lights circling the cockpit
            for (int k = 0; k < 2; ++k) {
                fr.at(2.1f + k * 0.25f, -1.4f, 0, ox, oy, oz);
                float ex, ey, ez;
                fr.at(2.1f + k * 0.25f, 1.4f, 0, ex, ey, ez);
                const float gy = air > 0.5f ? y - 0.4f * s : 0.07f;
                line(ox, gy, oz, ex, gy, ez, {1.0f, 0.8f, 0.1f}, 0.95f);
            }
            for (int k = 0; k < 3; ++k) {
                const float a = static_cast<float>(t) * 0.8f * sp + k * 2.0944f;
                fr.at(1.0f + std::cos(a) * 0.6f, std::sin(a) * 0.6f, 1.0f + 0.1f * k, ox, oy, oz);
                glow(ox, oy, oz, 0.0f, 0.45f * s, {1.0f, 0.95f, 0.6f}, 0.85f);
            }
            break;
        }
        case kOther: {  // generic: a slow violet rotating beacon on the roof
            fr.at(0.0f, 0, 0.6f, ox, oy, oz);
            sph(ox, oy, oz, 0.25f * s, 0.25f * s, 0.25f * s, {0.6f, 0.4f, 0.9f});
            const float a = static_cast<float>(t) * 3.0f * sp;
            line(ox, oy, oz, ox + std::cos(a) * 1.5f * s, oy, oz + std::sin(a) * 1.5f * s, {0.7f, 0.5f, 1.0f}, 0.9f);
            glow(ox, oy, oz, 0.0f, 0.9f * s, {0.7f, 0.5f, 1.0f}, 0.7f);
            break;
        }
        default:
            break;
    }
}

}  // namespace

void strata_kit_configure(strata_kit::Options& o) {
    o.name = "agentviz-atc";
    o.tiers[0].thinPoints = true;
}

void strata_kit_engine_ready(strata_kit::Host&) {
    if (g.airportsSet) setTerrain();
}

void strata_kit_build(strata_kit::Host& h, double seconds) {
    const double t = g.sceneTime >= 0.0 ? g.sceneTime : seconds;
    // Dusk over the field: the lights carry it.
    h.ambientLift = {0.05f, 0.05f, 0.07f};
    buildTower(t);
    for (size_t i = 0; i + kAirportStride <= g.airports.size(); i += kAirportStride) buildAirport(&g.airports[i], t);
    for (size_t i = 0; i + kPlaneStride <= g.planes.size(); i += kPlaneStride) buildPlane(&g.planes[i], t);
    for (size_t i = 0; i + kLineStride <= g.lines.size(); i += kLineStride) {
        const float* l = &g.lines[i];
        line(l[0], l[1], l[2], l[3], l[4], l[5], {l[6], l[7], l[8]}, l[9]);
    }
}

// The airports and the field's half extent. Rebuilds the terrain, so the
// page calls it only when the set of airports or their size changes.
STRATA_KIT_EXPORT void atc_set_airports(const float* rows, int count, float extent) {
    g.airports.assign(rows, rows + static_cast<size_t>(std::max(count, 0)) * kAirportStride);
    g.extent = std::max(extent, 20.0f);
    g.airportsSet = true;
    if (H().engine) setTerrain();
}
// The same rows without touching the terrain (waiting counts change often).
STRATA_KIT_EXPORT void atc_update_airports(const float* rows, int count) {
    if (static_cast<size_t>(std::max(count, 0)) * kAirportStride != g.airports.size()) return;
    g.airports.assign(rows, rows + g.airports.size());
}
STRATA_KIT_EXPORT void atc_set_planes(const float* rows, int count) {
    g.planes.assign(rows, rows + static_cast<size_t>(std::max(count, 0)) * kPlaneStride);
}
STRATA_KIT_EXPORT void atc_set_lines(const float* rows, int count) {
    g.lines.assign(rows, rows + static_cast<size_t>(std::max(count, 0)) * kLineStride);
}
STRATA_KIT_EXPORT void atc_set_waiting(int n) { g.waiting = std::max(n, 0); }
STRATA_KIT_EXPORT void atc_set_time(double seconds) { g.sceneTime = seconds; }
