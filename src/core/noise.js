/**
 * 1D 值噪声采样器（固定种子）
 * 来源：L5 实施说明书 §4.1 / 附录 B.5
 *  - 维度 1D，输入 t × 20.0，输出 [-1.0, 1.0]，不做截断（位移双向对称）
 *  - 固定种子 0x5EED（实施侧取值）
 */
const SEED = 0x5eed;

function hash1(n) {
  let h = (n ^ SEED) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h % 100000) / 50000 - 1; // [-1, 1)
}

const smooth = (t) => t * t * (3 - 2 * t);

export class Noise1D {
  sample(t) {
    const i = Math.floor(t);
    const f = t - i;
    const a = hash1(i);
    const b = hash1(i + 1);
    return a + (b - a) * smooth(f);
  }
}

/** ΔP_core = noise(t × 20.0) × 0.015u × envelope */
export function coreJitterOffset(noise, simTime, envelope) {
  return noise.sample(simTime * 20.0) * 0.015 * envelope;
}
