// Fix round 3: (1) contain core thermal bleed at deploy, (2) dim coreRods at deploy,
// (3) boost base-shell pentagon contours at closed state.
const fs = require('fs');
const P = 'E:/coding/NodeDesign/l5-core-showcase/src/gfx/l5Core.js';
let src = fs.readFileSync(P, 'utf8');
let applied = 0;
function rep(name, oldS, newS) {
  if (src.includes(newS)) { console.log('SKIP (already applied):', name); return; }
  const i = src.indexOf(oldS);
  if (i < 0) { console.log('FAIL (not found):', name); process.exitCode = 1; return; }
  src = src.slice(0, i) + newS + src.slice(i + oldS.length);
  applied++;
  console.log('OK:', name);
}

/* 1) 等离子核：展开（冷却模式）后约束热辐射 —— 防止 R=0.8 橙核透过半透碎片染色 */
rep('plasma containment',
`  vec3 c = plasma;
  c += u_emissive_color * eGainCore * rim * 0.55 * u_plasma_gain;
  c += vec3(1.0) * specP * eGainCore * 0.08 * u_plasma_gain;`,
`  /* v-new（冷却叙事）：碎片展开 = 进入冷却模式，核心热辐射被约束 ——
   * 否则 R=0.8 等离子核的橙光会从碎片缝隙与半透晶体内透出，
   * 把"负责冷却"的碎片整体染暖（headless 截图实测：p=0.955 满屏琥珀）。
   * deploy=1 时保留 28% 亮度：热感仍在、但不给碎片染色。 */
  float contain = mix(1.0, 0.28, smoothstep(0.0, 1.0, u_deploy));
  vec3 c = plasma * contain;
  c += u_emissive_color * eGainCore * rim * 0.55 * u_plasma_gain * contain;
  c += vec3(1.0) * specP * eGainCore * 0.08 * u_plasma_gain;`);

/* 2) 核心棱线（coreRods）随热辐射一同约束（sync 内，JS 侧） */
rep('coreRods containment',
`    this.coreRodMaterial.color.copy(color).multiplyScalar(rg * (0.58 + 0.72 * p));`,
`    // v-new：展开（冷却模式）后核心棱线随热辐射一同约束，避免橙色棱线从碎片缝隙透出染色
    const rodContain = 1.0 - 0.72 * (this._deploy || 0);
    this.coreRodMaterial.color.copy(color).multiplyScalar(rg * (0.58 + 0.72 * p) * rodContain);`);

/* 3) 基准面五边形轮廓：闭合态加亮 —— 透过半透碎片也能读出"带轮廓线的外壳" */
rep('closed contour boost',
`    c += u_emissive_color * pxLine(sdPentagon(fuv, u_face_apothem * 0.985), 2.3)
       * mix(0.28, 1.00, u_petal) * (0.45 + 0.55 * pC) * (0.55 + 0.45 * lambert);`,
`    c += u_emissive_color * pxLine(sdPentagon(fuv, u_face_apothem * 0.985), 2.3)
       * mix(0.28, 1.00, u_petal) * (0.45 + 0.55 * pC) * (0.55 + 0.45 * lambert)
       * (1.0 + 1.15 * closed);   /* v-new：闭合态(20-80 能量)轮廓加亮 —— 透过半透碎片读出带轮廓线的外壳 */`);

fs.writeFileSync(P, src);
console.log('applied:', applied, '| bytes:', src.length);
