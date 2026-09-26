/**
 * 开裂方案离线出图（不启 WebGL）
 * 直接调用 src/gfx/dodecaKit.js 的 buildFaceFracturePlan()，用**和运行时完全同一个 warp**
 * 画出每个五边形面的真实裂法，用来核对设计而不是核对渲染。
 *
 * 用法： node tools_fracture_preview.mjs
 * 产出： fracture-preview.html
 */
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { DODEC_FACE_NORMALS, buildFaceFracturePlan, TAU, norm } from './src/gfx/dodecaKit.js';

const R = 1.0;
const FACES = [0, 4, 7];          // 抽三个朝向不同的面作样本

/** 用 plan 生成某一片的真实轮廓（与 mkShard 取样同一 warp） */
function shardOutline(P, bi, a0, a1) {
  const { warp, bands } = P;
  const lo = bands[bi], hi = bands[bi + 1];
  const pts = [];
  const push = (a, t) => { const p = warp(a, t); pts.push(p); };
  if (lo <= 1e-9) {
    // 内带：内边界退化为面心一点
    const c = warp(a0, 0);
    pts.push(c);
  } else {
    const nA = 26;
    for (let i = 0; i <= nA; i++) push(a0 + ((a1 - a0) * i) / nA, lo);
  }
  const nT = 14;
  for (let j = 0; j <= nT; j++) push(a1, lo + ((hi - lo) * j) / nT);   // 外侧角向裂纹
  for (let i = 24; i >= 0; i--) push(a0 + ((a1 - a0) * i) / 24, hi);   // 外环裂纹（或五边形边）
  for (let j = nT; j >= 0; j--) push(a0, lo + ((hi - lo) * j) / nT);   // 内侧角向裂纹
  return pts;
}

function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) * 0.5;
}

/** 面内 2D → SVG 坐标（y 翻转） */
function mkXform(P, size) {
  let maxR = 0;
  for (const [u, v] of P.v2) maxR = Math.max(maxR, Math.hypot(u, v));
  const s = (size * 0.5 - 14) / maxR;
  return ([u, v]) => [size * 0.5 + u * s, size * 0.5 - v * s];
}

const path = (pts, X) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p)[0].toFixed(2)},${X(p)[1].toFixed(2)}`).join(' ') + ' Z';

function faceSvg(faceIdx, size, opts = {}) {
  const P = buildFaceFracturePlan(R, faceIdx);
  const X = mkXform(P, size);
  const shards = [];
  const NB = P.bands.length - 1;
  for (let bi = 0; bi < NB; bi++) {
    const B = P.breaks[bi];
    for (let i = 0; i < B.length; i++) {
      const a0 = B[i];
      const a1 = i === B.length - 1 ? B[0] + TAU : B[i + 1];
      const pts = shardOutline(P, bi, a0, a1);
      const aM = (a0 + a1) * 0.5;
      const tM = (P.bands[bi] + P.bands[bi + 1]) * 0.5;
      shards.push({ bi, i, a0, a1, pts, area: polyArea(pts), z: P.facetH(aM, tM) });
    }
  }
  const maxA = Math.max(...shards.map((s) => s.area));
  const minA = Math.min(...shards.map((s) => s.area));
  const FILLS = ['#123a58', '#12466b', '#0f5378', '#0c5f86', '#0a6a94'];

  const g = [];
  g.push(`<polygon points="${P.v2.map((p) => X(p).join(',')).join(' ')}" fill="none" stroke="#5b7099" stroke-width="1.6"/>`);

  for (const s of shards) {
    const rel = (s.area - minA) / Math.max(1e-9, maxA - minA);
    let alpha = 0.35 + 0.5 * rel;
    let fill = FILLS[s.bi % FILLS.length];
    let stroke = '#8fe3ff';
    if (opts.relief) {
      // 顶面刻面亮度图：亮度 ∝ 刻面高度（量化台阶 → 平直宝石切面）
      const zn = (s.z + 0.030) / 0.060;
      alpha = 0.16 + 0.74 * Math.max(0, Math.min(1, zn));
      fill = '#3fb9e8';
      stroke = '#bdeaff';
    }
    g.push(`<path d="${path(s.pts, X)}" fill="${fill}" fill-opacity="${alpha.toFixed(2)}" stroke="${stroke}" stroke-width="${opts.crackW || 1.1}" stroke-opacity="0.85"/>`);
  }

  // 环带标线（结构线）
  if (opts.rings) {
    for (const t of P.bands.slice(1, -1)) {
      const pts = [];
      for (let i = 0; i <= 120; i++) pts.push(P.warp((i / 120) * TAU, t));
      g.push(`<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(p)[0].toFixed(2)},${X(p)[1].toFixed(2)}`).join(' ')}" fill="none" stroke="#ffcf6b" stroke-width="1.2" stroke-dasharray="4 3" stroke-opacity="0.9"/>`);
    }
  }
  // 各带断裂点：用小圆点标出"角向裂纹的端点"，直观看出各带互相错开
  if (opts.dots) {
    const DOT = ['#ff8f8f', '#ffd36b', '#8fe3ff', '#c0ff8f', '#ff9fe8'];
    for (let bi = 0; bi < NB; bi++) {
      const col = DOT[bi % DOT.length];
      for (const a of P.breaks[bi]) {
        for (const t of [P.bands[bi], P.bands[bi + 1]]) {
          const p = X(P.warp(a, t));
          g.push(`<circle cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="2.6" fill="${col}"/>`);
        }
      }
    }
  }

  const stats = shards.map((s) => s.area);
  return {
    svg: g.join('\n'),
    info: {
      faceIdx,
      count: shards.length,
      perBand: Array.from({ length: NB }, (b, bi) => shards.filter((s) => s.bi === bi).length).join('·'),
      t1: P.bands[1].toFixed(3),
      t2: P.bands[2].toFixed(3),
      t3: P.bands[3].toFixed(3),
      areaRatio: (maxA / minA).toFixed(2),
      areaSum: stats.reduce((a, b) => a + b, 0).toFixed(4),
      pentArea: polyArea(P.v2).toFixed(4)
    }
  };
}

/* ---------------- 拼页面 ---------------- */
/** 断裂面剖面：沿厚度的侧向错位曲线 —— 直上直下=整齐切割，台阶折线=碎裂断口 */
function wallSvg(faceIdx, size) {
  const P = buildFaceFracturePlan(R, faceIdx);
  const { CRYST_Z0, CRYST_H, jag, NQZ } = P;
  const g = [];
  const W = size - 28, H = size - 34;
  const x0 = 14, y0 = 16;
  const SCALE = 900;               // 侧向错位放大倍数（错位本身只有 ~0.02 rad）
  const cols = [0.15, 0.40, 0.65, 0.90, 1.20, 1.75];
  const cw = W / cols.length;
  cols.forEach((a, ci) => {
    const cx = x0 + cw * (ci + 0.5);
    const pts = [];
    for (let k = 0; k < NQZ; k++) {
      const zA = CRYST_Z0 + CRYST_H * (k / NQZ) + 1e-3;
      const zB = CRYST_Z0 + CRYST_H * ((k + 1) / NQZ) - 1e-3;
      const jA = jag(a, 0.5, zA)[0];
      const jB = jag(a, 0.5, zB)[0];
      pts.push([cx + jA * SCALE, y0 + H * (1 - (zA - CRYST_Z0) / CRYST_H)]);
      pts.push([cx + jB * SCALE, y0 + H * (1 - (zB - CRYST_Z0) / CRYST_H)]);
    }
    g.push(`<polyline points="${pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" fill="none" stroke="#7fe3c0" stroke-width="1.6"/>`);
    g.push(`<line x1="${cx}" y1="${y0}" x2="${cx}" y2="${y0 + H}" stroke="#2a3a52" stroke-width="1" stroke-dasharray="3 3"/>`);
  });
  g.push(`<text x="14" y="${y0 - 4}" fill="#6f86a8" font-size="10">断口剖面：竖向=板厚，横向=断口侧向错位（放大 900×）</text>`);
  g.push(`<text x="14" y="${y0 + H + 14}" fill="#6f86a8" font-size="10">每段台阶 = 一层晶棱；相邻片共享同一条曲线 → 可拼合</text>`);
  return g.join('\n');
}

const SIZE = 300;
const rows = [];
const infos = [];
for (const f of FACES) {
  const closed = faceSvg(f, SIZE, { rings: true, dots: true });
  const relief = faceSvg(f, SIZE, { relief: true });
  const wall = wallSvg(f, SIZE);
  infos.push(closed.info);
  rows.push(`
    <div class="cell">
      <div class="ttl">面 #${f} · 闭合态（虚线=装甲结构线，圆点=各带裂纹端点）</div>
      <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${closed.svg}</svg>
    </div>
    <div class="cell">
      <div class="ttl">面 #${f} · 顶面刻面（亮度 ∝ 刻面高度，量化台阶）</div>
      <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${relief.svg}</svg>
    </div>
    <div class="cell">
      <div class="ttl">面 #${f} · 断裂面（侧壁）剖面</div>
      <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${wall}</svg>
    </div>`);
}

const total = FACES.reduce(
  (a, f) => a + buildFaceFracturePlan(R, f).breaks.reduce((b, arr) => b + arr.length, 0),
  0
);

const html = `<!doctype html><meta charset="utf-8"><title>面裂片 · 开裂方案核对</title>
<style>
 body{margin:0;padding:24px;background:#080b12;color:#cfe0f5;font:13px/1.7 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif}
 h1{font-size:19px;margin:0 0 6px;color:#eaf3ff}
 .sub{color:#7f93b3;margin-bottom:18px}
 .grid{display:grid;grid-template-columns:repeat(3,${SIZE}px);gap:18px 22px}
 .cell{background:#0c111c;border:1px solid #1b2436;border-radius:10px;padding:10px}
 .ttl{font-size:11px;color:#8fb0d8;margin-bottom:6px;height:30px}
 table{border-collapse:collapse;margin-top:20px}
 th,td{border:1px solid #1e2a3f;padding:5px 12px;text-align:right;font-variant-numeric:tabular-nums}
 th{background:#111a29;color:#9fc0e6;text-align:center}
 .note{margin-top:18px;max-width:900px;color:#93a7c4}
 .note b{color:#eaf3ff}
 .lg{display:flex;gap:16px;margin-top:10px;font-size:12px;color:#8fa6c6}
 .sw{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:5px;vertical-align:-1px}
</style>
<h1>五边形面 · 真实开裂方案（由 buildFaceFracturePlan 直接出图）</h1>
<div class="sub">三个样本面共 ${total} 片（v5.3 四环带加密版） · 与运行时同一 warp / zOf 场，非示意</div>
<div class="grid">${rows.join('')}</div>
<div class="lg">
 <span><i class="sw" style="background:#123a58"></i>内带</span>
 <span><i class="sw" style="background:#12466b"></i>带 2</span>
 <span><i class="sw" style="background:#0f5378"></i>带 3</span>
 <span><i class="sw" style="background:#0c5f86"></i>外带</span>
 <span><i class="sw" style="background:#ffcf6b"></i>环向结构线</span>
</div>
<table>
 <tr><th>面</th><th>片数</th><th>各带片数（内→外）</th><th>t1</th><th>t2</th><th>t3</th><th>最大/最小面积</th><th>片面积和</th><th>五边形面积</th></tr>
 ${infos.map((i) => `<tr><td>#${i.faceIdx}</td><td>${i.count}</td><td>${i.perBand}</td><td>${i.t1}</td><td>${i.t2}</td><td>${i.t3}</td><td>${i.areaRatio}×</td><td>${i.areaSum}</td><td>${i.pentArea}</td></tr>`).join('\n ')}
</table>
<div class="note">
 <b>裂法要点（v5.3）</b><br>
 1. 环向裂纹沿装甲结构线走（带确定性抖动），4 个环带（≈0.20/0.42/0.68，逐面抖动）→ 更碎。<br>
 2. 各带角向裂纹<b>彼此独立、互相错开</b>（内 4~5 / 4~6 / 5~7 / 外 6~8），真实裂纹遇到另一条就停 → "中心楔块 / 碎屑 / 外缘板"尺寸差是拓扑自带的。<br>
 3. 裂纹走 warp 蜿蜒场（振幅加大 + 2/3/5 次谐波调制半径）→ 不规整、机械水晶碎片感；warp 是纯函数 → 相邻片共享边界逐点一致，无缝隙无重叠。<br>
 4. 右列：棱面浮雕 zOf（带内鼓起、带缘归零成 V 槽）——运行时顶点沿法线抬高并按面片计算真实法线，硬高光随棱面跳变。<br>
 5. 片面积和与五边形面积逐行吻合（最后两列）——严丝合缝的几何自检。
</div>`;

writeFileSync(new URL('./fracture-preview.html', import.meta.url), html, 'utf8');
console.log('OK -> fracture-preview.html');
for (const i of infos) console.log(JSON.stringify(i));
