// terrain.h: the ground, painted once per layout: mown grass, the tower's
// plaza and ring road, a service road to each airport, and each airport's
// apron, hangar pad, taxiway and runway markings.
#pragma once

#include <vector>

#include "airport.h"

namespace atc {

inline float smooth01(float e0, float e1, float x) {
    const float t = std::clamp((x - e0) / (e1 - e0), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}
// Coverage of a band |d| < half, softened by one cell.
inline float band(float d, float half, float soft) { return 1.0f - smooth01(half - soft, half + soft, std::fabs(d)); }
inline float boxCov(float a, float a0, float a1, float b, float halfB, float soft) {
    return band(a - (a0 + a1) * 0.5f, (a1 - a0) * 0.5f, soft) * band(b, halfB, soft);
}

struct Paint {
    Rgb concrete{0.40f, 0.40f, 0.38f}, asphalt{0.09f, 0.09f, 0.10f}, white{0.85f, 0.85f, 0.82f},
        yellow{0.85f, 0.65f, 0.10f};
    float soft;
};

// The service road from the plaza out to an airport.
inline Rgb paintRoad(Rgb col, const Airport& ap, float x, float z, const Paint& p) {
    const float out = x * ap.ux + z * ap.uz, side = -x * ap.uz + z * ap.ux;
    const float roadEnd = std::sqrt(ap.cx * ap.cx + ap.cz * ap.cz) - 5.5f;
    return mix(col, p.asphalt, band(side, 0.45f, p.soft) * (out > 4.0f && out < roadEnd ? 1.0f : 0.0f));
}

// Apron, hangar pad, taxiway, runway with centre dashes and threshold bars.
inline Rgb paintAirport(Rgb col, const Airport& ap, float x, float z, const Paint& p) {
    float a, b;
    ap.local(x, z, a, b);
    const float hw = ap.halfWidth, soft = p.soft;
    col = mix(col, p.concrete, boxCov(a, -5.0f, 3.0f, b, hw + 1.0f, soft));
    col = mix(col, p.concrete, boxCov(a, -5.0f, -0.5f, b + hw + 4.5f, 3.5f, soft));
    col = mix(col, p.asphalt, boxCov(a, 2.5f, 7.0f, b - (hw + 2.2f), 0.8f, soft));
    col = mix(col, p.yellow, boxCov(a, 2.8f, 6.6f, b - (hw + 2.2f), 0.07f, soft) * 0.8f);
    const float rwHalf = ap.runwayHalf();
    col = mix(col, p.asphalt, boxCov(a, 6.0f, 8.6f, b, rwHalf, soft));
    const float dash = fract(b / 2.4f) < 0.5f ? 1.0f : 0.0f;
    col = mix(col, p.white, boxCov(a, 7.18f, 7.42f, b, rwHalf - 2.0f, soft) * dash * 0.9f);
    for (int end = -1; end <= 1; end += 2) {
        const float bars = fract((a - 6.0f) / 0.52f) < 0.5f ? 1.0f : 0.0f;
        col = mix(col, p.white, boxCov(a, 6.3f, 8.3f, b - end * (rwHalf - 0.9f), 0.6f, soft) * bars * 0.9f);
    }
    return mix(col, p.yellow, band(a - 2.7f, 0.08f, soft) * band(b, hw + 0.8f, soft) * 0.7f);
}

inline Rgb groundColour(const std::vector<Airport>& airports, float x, float z, const Paint& p) {
    const Rgb grassA{0.10f, 0.20f, 0.07f}, grassB{0.15f, 0.26f, 0.09f};
    const float stripe = 0.5f + 0.5f * std::sin((x * 0.7f + z * 0.7f) * 0.9f);
    Rgb col = mix(grassA, grassB, stripe * 0.6f + 0.2f * std::sin(x * 0.13f) * std::cos(z * 0.11f));
    const float r = std::sqrt(x * x + z * z);
    col = mix(col, p.concrete, band(r, 4.5f, p.soft));
    col = mix(col, p.asphalt, band(r - 9.0f, 0.5f, p.soft));
    for (const Airport& ap : airports) col = paintAirport(paintRoad(col, ap, x, z, p), ap, x, z, p);
    return col;
}

// A flat terrain tile `extent` either side of the tower, coloured per sample.
inline void setTerrain(const std::vector<Airport>& airports, float extent) {
    const float cellTarget = 0.4f;
    const int n = std::min(1025, static_cast<int>(2.0f * extent / cellTarget) + 1);
    const float cell = 2.0f * extent / (n - 1), x0 = -extent;
    std::vector<float> heights(static_cast<size_t>(n) * n, 0.0f), colors(static_cast<size_t>(n) * n * 3);
    Paint paint;
    paint.soft = cell * 0.7f;
    for (int j = 0; j < n; ++j)
        for (int i = 0; i < n; ++i) {
            const Rgb col = groundColour(airports, x0 + i * cell, x0 + j * cell, paint);
            const size_t k = (static_cast<size_t>(j) * n + i) * 3;
            colors[k] = col.r;
            colors[k + 1] = col.g;
            colors[k + 2] = col.b;
        }
    StrataTerrainTile tile{};
    tile.origin[0] = x0;
    tile.origin[2] = x0;
    tile.cell_size = cell;
    tile.samples_x = n;
    tile.samples_z = n;
    tile.heights = heights.data();
    tile.colors = colors.data();
    tile.color[3] = 1.0f;
    strata_set_terrain(H().engine, &tile);
    H().terrainSamples = n * n;
}

}  // namespace atc
