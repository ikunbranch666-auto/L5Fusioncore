/**
 * tools_geodesic_check.mjs —— 测地线偏折角的**纯数值自检**。
 *
 * 为什么需要它：本项目铁律是"不启浏览器、不截图"，而引力透镜的正确性又不能靠肉眼。
 * 于是把可验证的部分（测地线数学）单独拿出来，在 node 里直接断言 ——
 * 参照 BinaryConstruct Skybox Editor 的 geodesic.test.ts 的四条判据。
 *
 * 用法：node tools_geodesic_check.mjs      （退出码 0 = 全部通过）
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TMP = join(ROOT, '_geo_tmp');
mkdirSync(TMP, { recursive: true });
/* 项目 package.json 未必是 type:module，.js 会被 node 当 CJS → 复制成 .mjs 再 import */
const src = readFileSync(join(ROOT, 'src/gfx/geodesic.js'), 'utf8');
writeFileSync(join(TMP, 'geodesic.mjs'), src);
/* Windows 下绝对路径 E:\... 不是合法 ESM URL → 必须转成 file:// */
const G = await import(pathToFileURL(join(TMP, 'geodesic.mjs')).href);
rmSync(TMP, { recursive: true, force: true });

const { BH_B_CRIT_RS, deflectionAlpha, isCaptured, weakFieldAlpha, buildDeflectionLUT } = G;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`OK    ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

console.log(`b_c (Rs 单位) = ${BH_B_CRIT_RS.toFixed(6)}   （理论 3√3/2 = 2.598076）`);

// ── 1. 临界碰撞参数必须是 3√3/2 ──────────────────────────────────────────────
ok('b_c = 3√3/2', Math.abs(BH_B_CRIT_RS - 2.598076211) < 1e-6);

// ── 2. b < b_c 被捕获；b > b_c 逃逸 ──────────────────────────────────────────
ok('b = 0.5·b_c 被捕获', isCaptured(0.5 * BH_B_CRIT_RS) && !Number.isFinite(deflectionAlpha(0.5 * BH_B_CRIT_RS)));
ok('b = 0.99·b_c 被捕获', isCaptured(0.99 * BH_B_CRIT_RS) && !Number.isFinite(deflectionAlpha(0.99 * BH_B_CRIT_RS)));
ok('b = 1.01·b_c 逃逸', !isCaptured(1.01 * BH_B_CRIT_RS) && Number.isFinite(deflectionAlpha(1.01 * BH_B_CRIT_RS)));
ok('b = 10·b_c 逃逸', Number.isFinite(deflectionAlpha(10 * BH_B_CRIT_RS)));

// ── 3. 偏折角随 b 单调递减 ───────────────────────────────────────────────────
let mono = true, prev = Infinity;
const sample = [];
for (let k = 0; k <= 40; k++) {
  const b = BH_B_CRIT_RS * (1.02 + k * 0.25);
  const a = deflectionAlpha(b);
  sample.push([b, a]);
  if (a > prev) mono = false;
  prev = a;
}
ok('α 随 b 单调递减（41 个采样点）', mono);

// ── 4. 远场必须吻合弱场二阶公式 ──────────────────────────────────────────────
for (const b of [30, 60, 120]) {
  const a = deflectionAlpha(b);
  const w = weakFieldAlpha(b);
  const err = Math.abs(a - w) / w;
  ok(`远场 b=${b} 与弱场公式吻合`, err < 0.03, `α=${a.toFixed(6)} 弱场=${w.toFixed(6)} 相对误差=${(err * 100).toFixed(2)}%`);
}

// ── 5. 近光子环处必须远强于弱场预测（这是透镜"把身后场景压缩成环"的来源）──────
const near = deflectionAlpha(1.001 * BH_B_CRIT_RS);
const nearWeak = weakFieldAlpha(1.001 * BH_B_CRIT_RS);
ok('近光子环 α > 2 rad', Number.isFinite(near) && near > 2.0, `α=${Number.isFinite(near) ? near.toFixed(3) : '∞'}`);
ok('近光子环远强于弱场预测', near > 3 * nearWeak, `α=${near.toFixed(3)} vs 弱场 ${nearWeak.toFixed(3)}`);

// ── 6. 查找表 ────────────────────────────────────────────────────────────────
const lut = buildDeflectionLUT(256, 6);
let lutMono = true;
for (let i = 1; i < lut.n; i++) if (lut.data[i] > lut.data[i - 1] + 1) lutMono = false;   // +1 容忍量化
ok('LUT 单调不增（含量化容差）', lutMono);
ok('LUT 首值 = 上限（临界曲线处发散）', lut.data[0] === 255, `data[0]=${lut.data[0]}`);
ok('LUT 末值很小（远场几乎不偏折）', lut.data[lut.n - 1] < 40, `data[n-1]=${lut.data[lut.n - 1]}`);
ok('LUT 无 NaN', lut.data.every((v) => Number.isFinite(v) && v >= 0 && v <= 255));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
