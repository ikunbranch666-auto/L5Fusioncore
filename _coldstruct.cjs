/* v-new 冷却叙事 · 结构件冷化：
 * 约束场辉光板 / 笼框 / 幽灵框 / 核心棱线是"结构"，不该复制能量色（高能=橙）。
 * 冷结构 + 暖能量（用户认可的橙色环流粒子 + 受约束的核心热辐射）对比才成立。 */
const fs = require('fs');
const p = 'E:/coding/NodeDesign/l5-core-showcase/src/gfx/l5Core.js';
let s = fs.readFileSync(p, 'utf8');
let n = 0;
function rep(oldStr, newStr) {
  if (!s.includes(oldStr)) { console.log('MISS: ' + oldStr.slice(0, 60).replace(/\n/g, '\\n')); return; }
  s = s.replace(oldStr, newStr); n++;
}

/* 1. fieldGlow 颜色：不再复制能量色 → 恒定冷青 */
rep(`    gu.u_color.value.copy(color);`,
    `    // v-new（冷却叙事）：约束场是"冷"结构 —— 不复制能量色（高能=橙），
    // 改恒定冷青，避免 4.6u 满屏加色平面把冰蓝碎片整体染暖（headless 实测主暖源）。
    gu.u_color.value.setRGB(0.15, 0.60, 1.0);`);

/* 2. fieldGlow 增益：展开后额外让出亮度（原 head 只让 40%） */
rep(`    gu.u_gain.value = (this._plateGain ?? 1.0) * head;`,
    `    gu.u_gain.value = (this._plateGain ?? 1.0) * head * (1.0 - 0.55 * (this._deploy || 0));`);

/* 3. 笼框/幽灵框：结构件 → 冷青 */
rep(`    this.cageMaterial.color.copy(color);
    this.cageMaterial.opacity = (0.45 + 0.50 * p) * head * (this._cageMul ?? 1.0);
    this.cageGhostMaterial.color.copy(color);
    this.cageGhostMaterial.opacity = (0.12 + 0.26 * p) * head * (this._cageMul ?? 1.0);`,
    `    // v-new：笼框/幽灵框是结构件 → 恒冷青（结构冷、能量暖）；亮度仍随 p/head 走
    const coldC = this._coldColor || (this._coldColor = new THREE.Color(0.15, 0.60, 1.0));
    this.cageMaterial.color.copy(coldC);
    this.cageMaterial.opacity = (0.45 + 0.50 * p) * head * (this._cageMul ?? 1.0);
    this.cageGhostMaterial.color.copy(coldC);
    this.cageGhostMaterial.opacity = (0.12 + 0.26 * p) * head * (this._cageMul ?? 1.0);`);

/* 4. 核心棱线：结构件 → 冷青（rodContain 已有热约束） */
rep(`    this.coreRodMaterial.color.copy(color).multiplyScalar(rg * (0.58 + 0.72 * p) * rodContain);`,
    `    this.coreRodMaterial.color.copy(coldC).multiplyScalar(rg * (0.58 + 0.72 * p) * rodContain);`);

fs.writeFileSync(p, s);
console.log('applied ' + n + '/4 edits');
