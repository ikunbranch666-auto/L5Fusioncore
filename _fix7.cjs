// fix7: dim the core plasma so the icy fragments stop reading orange.
// Root cause (headless-verified): fragments are ADDITIVE (out = src + dst*(1-a), a~0.5),
// so the bright orange plasma core behind them washes through at ~50% and blasts
// through seams -> amber pentagon edges + overall warm dodecahedron.
// Also fulfils the user's Phase-2b mandate: "core too bright -> dim it".
const fs = require('fs');
const p = 'E:/coding/NodeDesign/l5-core-showcase/src/gfx/l5Core.js';
let s = fs.readFileSync(p, 'utf8');
const reps = [
  // 1. global plasma dim (0.44 -> 0.28)
  ['u_plasma_gain: { value: 0.44 },           // 等离子体扮演"热"的角色（唯一允许越过 bloom 阈值者）',
   'u_plasma_gain: { value: 0.28 },           // v-fix7：降亮（0.44→0.28，用户第二阶段拍板"核心整体过亮"）——热只做心部辉光，不再透过加色碎片染橙整个构造体'],
  // 2. containment active even when closed (heat seeps subtly at seams), stronger when deployed
  ['  /* v-new（冷却叙事）：碎片展开 = 进入冷却模式，核心热辐射被约束 ——\n   * 否则 R=0.8 等离子核的橙光会从碎片缝隙与半透晶体内透出，\n   * 把"负责冷却"的碎片整体染暖（headless 截图实测：p=0.955 满屏琥珀）。\n   * deploy=1 时保留 28% 亮度：热感仍在、但不给碎片染色。 */\n  float contain = mix(1.0, 0.28, smoothstep(0.0, 1.0, u_deploy));',
   '  /* v-fix7（冷却叙事）：热约束在闭合态就生效 —— 碎片是加色半透(α≈0.5)，\n   * 亮橙核会以 50% 透染整个构造体（headless 实测：闭合态琥珀五边形棱线）。\n   * 闭合 0.55（缝隙微渗暖光=热被封在壳内）、展开 0.18（冷却模式全面接管）。 */\n  float contain = mix(0.55, 0.18, smoothstep(0.0, 1.0, u_deploy));'],
];
for (const [a, b] of reps) {
  if (!s.includes(a)) throw new Error('MISS: ' + a.slice(0, 80));
  s = s.split(a).join(b);
}
fs.writeFileSync(p, s);
console.log('fix7 applied: plasma dimmed + containment strengthened');
