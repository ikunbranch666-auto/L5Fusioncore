/**
 * Schwarzschild 测地线偏折角 —— 引力透镜的数学核心。
 *
 * 为什么单独成模块：透镜 shader 不能靠"经验公式"拼出来（前几轮就是这么失败的），
 * 必须有**一个**可验证的偏折函数；而它又必须是纯数值的，好让 `tools_geodesic_check.mjs`
 * 在 node 里直接断言它的正确性（不启浏览器、不截图）。
 *
 * ── 物理 ────────────────────────────────────────────────────────────────────
 * 取 G = c = 1，史瓦西半径 Rs = 1（于是 M = Rs/2 = 1/2），长度都以 Rs 为单位。
 * 零测地线（光线）的轨道方程：
 *     (du/dφ)² = 1/b² − u² + 2M·u³        （u = 1/r，b = 碰撞参数/冲量参数）
 * 令 P(u) = 1/b² − u² + u³（M = 1/2），则
 *     Δφ = 2 ∫_0^{u_t} du / √P(u)          （u_t = 转折点，P(u_t) = 0）
 *     α  = Δφ − π                          （总偏折角）
 *
 * 临界碰撞参数：b_c = 3√3·M = 3√3/2 ≈ 2.598（Rs 单位）。
 *   b < b_c → P 在 (0,2/3] 无零点 → 光线落入视界（被捕获，输出黑）。
 *   b > b_c → 有零点 → 掠过并逃逸，α 随 b 增大而减小。
 *
 * ── 数值 ────────────────────────────────────────────────────────────────────
 * · 转折点用**二分法**求 P 在 (0, 2/3] 上的最小正根（P(0)>0、P(2/3)=1/b²−4/27，
 *   b>b_c 时为负 → 必有根），60 次二分 → 稳定，不依赖初值。
 * · 积分在 u→u_t 处有 1/√ 的可积奇点，直接采样会炸。做代换 u = u_t(1 − t²)：
 *     Δφ = 4·u_t ∫_0^1 t / √P(u_t(1−t²)) dt
 *   被积函数在 t→0 时趋于有限值，再用**中点法**（采样点 t=(i+0.5)/N 永不取 t=0）
 *   → 完全避开奇点，无需特殊处理端点。
 */

/** 临界碰撞参数（Rs 单位）= 3√3/2 ≈ 2.598 */
export const BH_B_CRIT_RS = (3 * Math.sqrt(3)) / 2;

/** P(u) = 1/b² − u² + u³ —— 被积函数的分母里的多项式 */
function pPoly(u, invB2) {
  return invB2 - u * u + u * u * u;
}

/**
 * 求转折点 u_t：P 在 (0, 2/3] 上的最小正根。无根返回 -1（= 被捕获）。
 * @param {number} invB2 1/b²
 */
function turningPoint(invB2) {
  const fAt = (u) => pPoly(u, invB2);
  if (fAt(2 / 3) > 0) return -1;         // P(2/3)>0 → 全正 → 光线落入视界
  let lo = 0, hi = 2 / 3;                // f(lo) > 0, f(hi) <= 0
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) * 0.5;
    if (fAt(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * 总偏折角 α（弧度）。
 * @param {number} bRs 碰撞参数（Rs 单位）
 * @param {number} N 积分步数
 * @returns {number} α；被捕获时返回 Infinity
 */
export function deflectionAlpha(bRs, N = 4000) {
  const invB2 = 1 / (bRs * bRs);
  const ut = turningPoint(invB2);
  if (ut < 0) return Infinity;           // 落入视界
  // Δφ = 4·u_t ∫_0^1 t/√P(u_t(1−t²)) dt  （中点法，避开 t=0 的可积奇点）
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const u = ut * (1 - t * t);
    const pv = pPoly(u, invB2);
    if (pv <= 0) continue;               // 数值保护（理论上是 0）
    sum += t / Math.sqrt(pv);
  }
  const dphi = (4 * ut * sum) / N;
  return dphi - Math.PI;
}

/** 是否被捕获（b < b_c） */
export function isCaptured(bRs) {
  return bRs < BH_B_CRIT_RS;
}

/** 弱场二阶近似，仅用于测试比对：α ≈ 4M/b + 15πM²/(4b²)（M = 1/2） */
export function weakFieldAlpha(bRs) {
  const M = 0.5;
  return (4 * M) / bRs + (15 * Math.PI * M * M) / (4 * bRs * bRs);
}

/**
 * 烘焙偏折角查找表（给 shader 采样用）。
 * 采样在 u = b/b_c 上**非均匀**：u = 1 + (uMax−1)·s³（s∈[0,1]）→ 靠近临界曲线处极密，
 * 因为 α 在那里对数发散，均匀采样会把最关键的一段漏掉。
 * shader 反查：s = ((u − 1)/(uMax − 1))^(1/3)。
 *
 * @returns {{data: Uint8Array, n: number, uMax: number, alphaMax: number}}
 *          data[i] = clamp(α, 0, alphaMax) / alphaMax * 255
 */
export function buildDeflectionLUT(n = 256, uMax = 6) {
  const alphaMax = 2 * Math.PI;          // 存储上限：超过一圈的绕行对画面没有额外意义
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = n > 1 ? i / (n - 1) : 0;
    const u = 1 + (uMax - 1) * s * s * s;
    const a = deflectionAlpha(u * BH_B_CRIT_RS, 1500);
    const v = Number.isFinite(a) ? Math.min(Math.max(a, 0), alphaMax) : alphaMax;
    data[i] = Math.round((v / alphaMax) * 255);
  }
  return { data, n, uMax, alphaMax };
}
