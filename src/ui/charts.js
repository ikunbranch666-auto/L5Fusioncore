/**
 * 副屏图表（纯 SVG，无第三方图表库）
 * 内容全部取自 L5 实施说明书：13.1 幂次曲线、1.4.1 溢出下限、41.1 上钳、10.1.1 呼吸波形
 */
import { iCore, e0 as calcE0, DEFAULT_CORE_MAX_BRIGHTNESS, SPILL_FLOOR } from '../core/photometry.js';
import { R_CORE, R_SHELL_OUT, R_SHELL_IN } from '../gfx/l5Core.js';

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

/* ---------------- I_core 曲线 ---------------- */
export function drawIcoreChart(svg) {
  svg.innerHTML = '';
  const X0 = 46, X1 = 328, Y0 = 16, Y1 = 164;
  const V_MIN = 1.0, V_MAX = 4.2;
  const sx = (p) => X0 + p * (X1 - X0);
  const sy = (v) => Y1 - ((v - V_MIN) / (V_MAX - V_MIN)) * (Y1 - Y0);

  // 网格与刻度
  for (let v = 1.0; v <= 4.0001; v += 0.5) {
    svg.appendChild(el('line', {
      x1: X0, y1: sy(v), x2: X1, y2: sy(v),
      stroke: '#1E293B', 'stroke-width': 1
    }));
    svg.appendChild(el('text', {
      x: X0 - 8, y: sy(v) + 3, 'text-anchor': 'end',
      fill: '#64748B', 'font-size': 8.5, 'font-family': 'JetBrains Mono, monospace'
    }, v.toFixed(1)));
  }
  [0, 0.25, 0.5, 0.75, 1].forEach((p) => {
    svg.appendChild(el('text', {
      x: sx(p), y: Y1 + 14, 'text-anchor': 'middle',
      fill: '#64748B', 'font-size': 8.5, 'font-family': 'JetBrains Mono, monospace'
    }, p.toFixed(2)));
  });

  // 轴
  svg.appendChild(el('line', { x1: X0, y1: Y0, x2: X0, y2: Y1, stroke: '#334155' }));
  svg.appendChild(el('line', { x1: X0, y1: Y1, x2: X1, y2: Y1, stroke: '#334155' }));
  svg.appendChild(el('text', { x: X1, y: Y1 + 28, 'text-anchor': 'end', fill: '#475569', 'font-size': 8.5 }, 'MainParam p'));
  svg.appendChild(el('text', { x: 6, y: Y0 + 4, fill: '#475569', 'font-size': 8.5 }, 'I_core'));

  // I_core 曲线（13.1）
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push(`${sx(i / 100).toFixed(2)},${sy(iCore(i / 100)).toFixed(2)}`);
  svg.appendChild(el('polyline', {
    points: pts.join(' '), fill: 'none', stroke: '#00F2FE', 'stroke-width': 1.8,
    'stroke-linejoin': 'round'
  }));

  // E0 曲线（41.1 上钳 3.5）以虚线覆盖被钳制段
  const clipped = [];
  for (let i = 0; i <= 100; i++) {
    const p = i / 100;
    const v = calcE0(p, DEFAULT_CORE_MAX_BRIGHTNESS);
    clipped.push(`${sx(p).toFixed(2)},${sy(v).toFixed(2)}`);
  }
  svg.appendChild(el('polyline', {
    points: clipped.join(' '), fill: 'none', stroke: '#F59E0B', 'stroke-width': 1.2,
    'stroke-dasharray': '4 3', opacity: 0.85
  }));

  // 参考线：可见溢出下限 1.5（1.4.1）
  svg.appendChild(el('line', {
    x1: X0, y1: sy(SPILL_FLOOR), x2: X1, y2: sy(SPILL_FLOOR),
    stroke: '#F59E0B', 'stroke-width': 1, 'stroke-dasharray': '2 4', opacity: 0.7
  }));
  svg.appendChild(el('text', {
    x: X1, y: sy(SPILL_FLOOR) - 4, 'text-anchor': 'end', fill: '#F59E0B', 'font-size': 8.5
  }, '1.5 可见溢出下限'));

  // 参考线：上钳 3.5
  svg.appendChild(el('line', {
    x1: X0, y1: sy(DEFAULT_CORE_MAX_BRIGHTNESS), x2: X1, y2: sy(DEFAULT_CORE_MAX_BRIGHTNESS),
    stroke: '#F59E0B', 'stroke-width': 1, 'stroke-dasharray': '2 4', opacity: 0.7
  }));
  svg.appendChild(el('text', {
    x: X1, y: sy(DEFAULT_CORE_MAX_BRIGHTNESS) - 4, 'text-anchor': 'end', fill: '#F59E0B', 'font-size': 8.5
  }, '3.5 coreMaxBrightness'));

  // 三态工作点
  const states = [
    { p: 0.0, label: '01' }, { p: 0.5, label: '02' }, { p: 1.0, label: '03' }
  ];
  states.forEach((s) => {
    svg.appendChild(el('circle', { cx: sx(s.p), cy: sy(iCore(s.p)), r: 3.2, fill: '#0B0F19', stroke: '#38BDF8', 'stroke-width': 1.4 }));
    svg.appendChild(el('text', {
      x: sx(s.p), y: sy(iCore(s.p)) - 8, 'text-anchor': 'middle', fill: '#38BDF8',
      'font-size': 8.5, 'font-family': 'JetBrains Mono, monospace'
    }, s.label));
  });

  // 当前工作点游标
  const cursorLine = el('line', { x1: 0, y1: Y0, x2: 0, y2: Y1, stroke: '#E2E8F0', 'stroke-width': 1, opacity: 0.35 });
  const cursorDot = el('circle', { cx: 0, cy: 0, r: 4, fill: '#EAF9FF', stroke: '#00F2FE', 'stroke-width': 1.5 });
  const cursorText = el('text', {
    x: 0, y: 0, 'text-anchor': 'middle', fill: '#EAF9FF', 'font-size': 9,
    'font-family': 'JetBrains Mono, monospace'
  }, '');
  svg.appendChild(cursorLine);
  svg.appendChild(cursorDot);
  svg.appendChild(cursorText);

  return {
    update(p) {
      const v = iCore(p);
      const x = sx(p), y = sy(v);
      cursorLine.setAttribute('x1', x);
      cursorLine.setAttribute('x2', x);
      cursorDot.setAttribute('cx', x);
      cursorDot.setAttribute('cy', y);
      const anchorRight = p > 0.8;
      cursorText.setAttribute('x', anchorRight ? x - 6 : x + 6);
      cursorText.setAttribute('y', y - 8);
      cursorText.setAttribute('text-anchor', anchorRight ? 'end' : 'start');
      cursorText.textContent = `p=${p.toFixed(3)}  I=${v.toFixed(2)}`;
    }
  };
}

/* ---------------- 呼吸波形 ---------------- */
export function drawBreathChart(svg) {
  svg.innerHTML = '';
  const X0 = 8, X1 = 332, Y0 = 12, Y1 = 118;
  const sy = (v) => Y1 - v * (Y1 - Y0);

  [0, 0.5, 1].forEach((v) => {
    svg.appendChild(el('line', { x1: X0, y1: sy(v), x2: X1, y2: sy(v), stroke: '#1E293B', 'stroke-width': 1 }));
    svg.appendChild(el('text', {
      x: X0 + 2, y: sy(v) - 3, fill: '#475569', 'font-size': 8.5,
      'font-family': 'JetBrains Mono, monospace'
    }, v.toFixed(1)));
  });
  svg.appendChild(el('text', { x: X1, y: Y1 + 16, 'text-anchor': 'end', fill: '#475569', 'font-size': 8.5 }, 'Φ(t) 实时（最近 120 帧）'));

  const line = el('polyline', { points: '', fill: 'none', stroke: '#00F2FE', 'stroke-width': 1.6, 'stroke-linejoin': 'round' });
  svg.appendChild(line);
  const head = el('circle', { cx: X1, cy: sy(0), r: 3, fill: '#EAF9FF' });
  svg.appendChild(head);

  return {
    update(samples) {
      const n = samples.length;
      const pts = samples.map((v, i) => `${(X0 + (i / (n - 1)) * (X1 - X0)).toFixed(1)},${sy(v).toFixed(1)}`);
      line.setAttribute('points', pts.join(' '));
      const last = samples[n - 1] || 0;
      head.setAttribute('cy', sy(last));
    }
  };
}

/* ---------------- 几何剖面多边形 ---------------- */
export function drawGeometryPolygons() {
  const shellOut = document.getElementById('dg-shell-out');
  const shellIn = document.getElementById('dg-shell-in');
  const core = document.getElementById('dg-core');
  if (!shellOut) return;

  const SCALE = 90 / R_SHELL_OUT; // 外层 1.0u → 90px
  const polygon = (r, sides = 10, rot = -Math.PI / 2) => {
    const pts = [];
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * Math.PI * 2;
      pts.push(`${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`);
    }
    return pts.join(' ');
  };

  shellOut.setAttribute('points', polygon(R_SHELL_OUT * SCALE));
  shellIn.setAttribute('points', polygon(R_SHELL_IN * SCALE));
  core.setAttribute('points', polygon(R_CORE * SCALE));
}
