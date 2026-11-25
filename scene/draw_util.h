// draw_util.h: colours, timing helpers and primitive shapes shared by the
// airfield's drawing.
#pragma once

#include <algorithm>
#include <cmath>

#include "strata_kit.h"
#include "../vendor/agentviz-kit/scene/agentviz.h"

namespace atc {

using strata_kit::Rgb;
constexpr float kPi = 3.14159265f;

const Rgb kRed{1.0f, 0.12f, 0.06f}, kAmber{1.0f, 0.62f, 0.05f}, kGreen{0.2f, 1.0f, 0.35f},
    kCyan{0.25f, 0.75f, 1.0f}, kWhite{1.0f, 1.0f, 1.0f}, kQuestion{1.0f, 0.85f, 0.2f};

inline strata_kit::Host& H() { return strata_kit::host(); }

inline Rgb mix(Rgb a, Rgb b, float t) { return {a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t}; }
inline Rgb scl(Rgb a, float k) { return {a.r * k, a.g * k, a.b * k}; }

// The page's livery colour for a seed (hue 0..1).
inline Rgb hueColor(float h, float sat, float val) {
    auto channel = [&](float o) {
        const float k = std::fmod(h * 6.0f + o, 6.0f);
        const float x = std::clamp(std::min(k, 4.0f - k), 0.0f, 1.0f);
        return val * (1.0f - sat * x);
    };
    return {channel(5.0f), channel(3.0f), channel(1.0f)};
}

inline float fract(float x) { return x - std::floor(x); }
// Motion helpers that hold still under prefers-reduced-motion.
inline float motion() { return H().reducedMotion ? 0.0f : 1.0f; }
inline float wave(double t, double rate, float phase) {
    return H().reducedMotion ? 0.0f : static_cast<float>(std::sin(t * rate + phase));
}
inline float blink(double t, double rate, float phase, float duty) {
    if (H().reducedMotion) return 1.0f;
    return fract(static_cast<float>(t * rate) + phase) < duty ? 1.0f : 0.0f;
}

inline void sph(float x, float y, float z, float sx, float sy, float sz, Rgb c) {
    H().add(STRATA_PRIMITIVE_SPHERE, x, y, z, sx, sy, sz, c);
}
inline void ball(float x, float y, float z, float d, Rgb c) { sph(x, y, z, d, d, d, c); }
inline void cube(float x, float y, float z, float sx, float sy, float sz, Rgb c) {
    H().add(STRATA_PRIMITIVE_CUBE, x, y, z, sx, sy, sz, c);
}
inline void cyl(float x, float y, float z, float r, float halfH, Rgb c) {
    H().add(STRATA_PRIMITIVE_CYLINDER, x, y, z, r * 2.0f, halfH, r * 2.0f, c);
}
// A lit halo (blended into the bloom) and a plain point.
inline void glow(float x, float y, float z, float world, Rgb c, float a) { H().point(x, y, z, 0.0f, world, c, a); }
inline void dot(float x, float y, float z, float px, float world, Rgb c, float a) { H().point(x, y, z, px, world, c, a, 0u); }
inline void line(float x0, float y0, float z0, float x1, float y1, float z1, Rgb c, float a) {
    H().line(x0, y0, z0, x1, y1, z1, c, a);
}
inline void circle(float x, float y, float z, float r, Rgb c, float a, int n = 32) {
    for (int k = 0; k < n; ++k) {
        const float a0 = k * 2.0f * kPi / n, a1 = (k + 1) * 2.0f * kPi / n;
        line(x + std::cos(a0) * r, y, z + std::sin(a0) * r, x + std::cos(a1) * r, y, z + std::sin(a1) * r, c, a);
    }
}
// Every other one of `dashes * 2` pieces of a straight line.
inline void dashed(float x0, float y0, float z0, float x1, float y1, float z1, int dashes, Rgb c, float a) {
    const int n = dashes * 2;
    for (int k = 0; k < n; k += 2) {
        const float u0 = static_cast<float>(k) / n, u1 = static_cast<float>(k + 1) / n;
        line(x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0, z0 + (z1 - z0) * u0,
             x0 + (x1 - x0) * u1, y0 + (y1 - y0) * u1, z0 + (z1 - z0) * u1, c, a);
    }
}

}  // namespace atc
