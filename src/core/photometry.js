/**
 * L5 光度学与色彩解算
 * 来源：L5 实施说明书 §3.1 / §5.2 / 附录 B.1 / B.3 / B.4 / B.6 / B.7
 *
 * 数值链（附录 B.4，唯一强度源为 13.1）：
 *   I_core(t) = 1.2 + 2.8 × MainParam(t)^1.5
 *   E0(t)     = min(I_core(t), coreMaxBrightness)      // 上钳作用于 E0，不作用于 E(t)
 *   E(t)      = E0(t) × [1.0 + 0.12 × Φ(t)]
 */

export const CORE_ALBEDO_HEX = '#00F2FE';   // 6.1 Albedo / Emissive 起点
export const CORE_OVERDRIVE_HEX = '#FF7700'; // 5.6.2 过载色终点

export const CORE_COLOR_START = [0, 242, 254];  // #00F2FE (sRGB 分量)
export const CORE_COLOR_END = [255, 119, 0];    // #FF7700 (sRGB 分量)

export const DEFAULT_CORE_MAX_BRIGHTNESS = 3.5; // 41.1 coreMaxBrightness，范围 [1.0, 5.0]
export const DEFAULT_BREATH_PERIOD = 4.0;       // 41.1 breathPeriod，范围 [2.0, 8.0]
export const BREATH_GAIN = 0.12;                // 10.1.2
export const SHELL_ALPHA_MIN = 0.35;            // 附录 B.7
export const SHELL_ALPHA_MAX = 0.55;            // 附录 B.7
export const JITTER_AMPLITUDE_U = 0.015;        // 5.6.3
export const JITTER_FREQ = 20.0;                // 5.6.3
export const BLOOM_THRESHOLD = 1.0;             // 7.1.2
export const SPILL_FLOOR = 1.5;                 // 1.4.1 可见溢出下限（附录 B.6）

export const clamp01 = (v) => Math.min(1.0, Math.max(0.0, v));

/** 13.1 核心辐射功率（唯一强度源） */
export function iCore(mainParam) {
  return 1.2 + 2.8 * Math.pow(clamp01(mainParam), 1.5);
}

/** 41.1 / 附录 B.4 发光功率基线（上钳作用于基线） */
export function e0(mainParam, coreMaxBrightness = DEFAULT_CORE_MAX_BRIGHTNESS) {
  return Math.min(iCore(mainParam), coreMaxBrightness);
}

/** 10.1.2 呼吸叠加后的发光功率 */
export function emissiveE(baseline, phi) {
  return baseline * (1.0 + BREATH_GAIN * phi);
}

/** 附录 B.1：RGB 分量线性插值（禁止 HSV 色相角插值） */
export function coreColorSRGB(mainParam) {
  const t = clamp01(mainParam);
  return [
    CORE_COLOR_START[0] + (CORE_COLOR_END[0] - CORE_COLOR_START[0]) * t,
    CORE_COLOR_START[1] + (CORE_COLOR_END[1] - CORE_COLOR_START[1]) * t,
    CORE_COLOR_START[2] + (CORE_COLOR_END[2] - CORE_COLOR_START[2]) * t
  ];
}

/** 附录 B.7 外层电磁约束框透明度 */
export function shellAlpha(mainParam) {
  return SHELL_ALPHA_MIN + (SHELL_ALPHA_MAX - SHELL_ALPHA_MIN) * clamp01(mainParam);
}

/** 附录 B.5 微抖动幅度包络 */
export function jitterEnvelope(mainParam) {
  return Math.min(1.0, Math.max(0.0, clamp01(mainParam) * 2.0));
}

/** sRGB(0-255) → HSV 色相角（度），用于 H_accent 监视 */
export function hueDegrees([r8, g8, b8]) {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

export function rgbToHex([r, g, b]) {
  const to = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** 17.1 世界单位 → 屏幕像素换算（禁止硬编码 54.0） */
export function unitsToPixels(worldCoord, viewportHeightCss, dpr) {
  return worldCoord * (viewportHeightCss / 20.0) * dpr;
}

/** 2.3.1 DPR 上限截断 */
export function targetDpr(devicePixelRatio) {
  return Math.min(devicePixelRatio || 1, 2.0);
}
