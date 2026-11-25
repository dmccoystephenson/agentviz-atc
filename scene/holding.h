// holding.h: the lines on and over the field. From the agents: each holding
// aircraft's orbit round the tower and the red ring pulsing at its empty
// gate. From the links (atc-frame.js): kind 0, one dash of a subagent's
// flight loop in its lead's colour; kind 1, a holding aircraft's dashed line
// home to its gate.
#pragma once

#include <vector>

#include "draw_util.h"

namespace atc {

// The holding stack's shape (scene floats 2..4, from AtcField.STACK).
struct Stack {
    float radius, y0, dy;
};

inline void drawHoldingPattern(const agentviz::Agent& a, const Stack& stack, double t) {
    const float rank = a.extra[2], gateX = a.extra[4], gateZ = a.extra[5];
    circle(0.0f, stack.y0 + rank * stack.dy, 0.0f, stack.radius, kRed, 0.35f, 48);
    circle(gateX, 0.08f, gateZ, 1.2f + 0.4f * wave(t, 5.0, 0.0f), kRed, 0.9f, 24);
}

inline void drawLinks(const std::vector<agentviz::Link>& links) {
    for (const auto& l : links) {
        if (l.kind == 0)
            line(l.x0, l.y0, l.z0, l.x1, l.y1, l.z1, hueColor(l.seed, 0.6f, 1.0f), l.alpha);
        else
            dashed(l.x0, l.y0, l.z0, l.x1, l.y1, l.z1, 8, kRed, l.alpha);
    }
}

}  // namespace atc
