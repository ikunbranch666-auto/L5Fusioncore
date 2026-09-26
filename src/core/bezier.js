/**
 * 三次贝塞尔缓动求解（与 CSS cubic-bezier 同构）
 * 来源：L5 实施说明书 §4.3 / 14.1 / 14.2
 */

const NEWTON_ITERATIONS = 6;
const SUBDIVISION_EPSILON = 1e-7;

function A(a1, a2) { return 1.0 - 3.0 * a2 + 3.0 * a1; }
function B(a1, a2) { return 3.0 * a2 - 6.0 * a1; }
function C(a1) { return 3.0 * a1; }

function calcBezier(t, a1, a2) {
  return ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
}

function getSlope(t, a1, a2) {
  return 3.0 * A(a1, a2) * t * t + 2.0 * B(a1, a2) * t + C(a1);
}

export function makeCubicBezier(x1, y1, x2, y2) {
  if (x1 === y1 && x2 === y2) return (t) => t;
  return function ease(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const slope = getSlope(t, x1, x2);
      if (Math.abs(slope) < SUBDIVISION_EPSILON) break;
      t -= (calcBezier(t, x1, x2) - x) / slope;
    }
    return calcBezier(t, y1, y2);
  };
}
