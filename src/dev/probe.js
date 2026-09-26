/**
 * 渲染探针（开发 / 验收诊断用，URL ?probe=1 才会装配）
 *
 * 目的：把「这个效果看不看得见」从主观描述变成可测量量。
 * 做法：合成管线最后一趟渲染完成后，直接 gl.readPixels 取回默认帧缓冲，
 *      在页面内完成统计，输出 JSON。
 *
 * 关键指标与其对应的视觉问题：
 *  · core.cv / core.localContrast    —— 等离子湍流丝结构是否成形
 *                                       （纯色块 cv≈0，丝状湍流 cv 应显著 > 0）
 *  · rings[] 均值沿半径的分布        —— 各层是否在径向剖面上留下可读的「台阶 / 峰」
 *  · edgeProfile[] 梯度剖面          —— 面板缝 / 棱 / 薄壳边缘是否产生足够的局部对比
 *  · outsideEnergy                   —— 硬壳轮廓之外的能量占比 = 外溢辐射是否可见
 *  · dynamicRange                    —— 画面是否被 ACES 压平成一坨白
 */
import * as THREE from 'three';

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export class FrameProbe {
  constructor(renderer, camera) {
    this.renderer = renderer;
    this.camera = camera;
    this._buf = null;
    this._tmp = new THREE.Vector3();
  }

  /**
   * 取一帧并统计
   * @param {{maxUnits?:number, layerRadii?:Record<string,number>, bgUnits?:number}} opts
   */
  capture(opts = {}) {
    const maxUnits = opts.maxUnits ?? 2.4;
    const layerRadii = opts.layerRadii ?? { core: 0.8, shellOut: 1.0 };
    const bgUnits = opts.bgUnits ?? 2.1;

    const renderer = this.renderer;
    const gl = renderer.getContext();
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (!this._buf || this._buf.length !== w * h * 4) this._buf = new Uint8Array(w * h * 4);
    const buf = this._buf;
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    if (prevFb) gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);

    /* ---- 几何标定：世界单位 → 像素 ---- */
    const cam = this.camera;
    const pxPerUnit = h / (cam.top - cam.bottom);
    this._tmp.set(0, 0, 0).project(cam);
    const cx = ((this._tmp.x + 1) * 0.5) * w;
    const cy = ((this._tmp.y + 1) * 0.5) * h;

    /* ---- 亮度缓冲（抽样步长控制开销） ---- */
    const step = Math.max(1, Math.floor(Math.min(w, h) / 900));
    const lum = new Float32Array(w * h);
    const perc = new Float32Array(w * h);

    let sum = 0;
    let sumSq = 0;
    let n = 0;
    let maxL = 0;
    let nonBlack = 0;

    for (let y = 0; y < h; y += step) {
      const row = y * w;
      for (let x = 0; x < w; x += step) {
        const i = (row + x) * 4;
        // 感知亮度（0..1，sRGB 编码域）—— 用于「肉眼可见性」判据
        const p = (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]) / 255;
        // 线性亮度 —— 用于能量统计（Bloom / 外溢都是在线性域累加的）
        const l = 0.2126 * SRGB_TO_LINEAR[buf[i]]
                + 0.7152 * SRGB_TO_LINEAR[buf[i + 1]]
                + 0.0722 * SRGB_TO_LINEAR[buf[i + 2]];
        const k = row + x;
        lum[k] = l;
        perc[k] = p;
        sum += l; sumSq += l * l; n++;
        if (l > maxL) maxL = l;
        if (p > 0.06) nonBlack++;
      }
    }
    const meanL = sum / n;
    const sdL = Math.sqrt(Math.max(0, sumSq / n - meanL * meanL));

    /* ---- 径向剖面（1px 一环） ---- */
    const maxR = Math.ceil(maxUnits * pxPerUnit);
    const rSum = new Float64Array(maxR + 1);
    const rSq = new Float64Array(maxR + 1);
    const rCnt = new Float64Array(maxR + 1);
    let insideEnergy = 0;
    let outsideEnergy = 0;
    const shellPx = layerRadii.shellOut * pxPerUnit;
    const bgPx = bgUnits * pxPerUnit;

    for (let y = 0; y < h; y += step) {
      const dy = y - cy;
      const row = y * w;
      for (let x = 0; x < w; x += step) {
        const dx = x - cx;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > maxR) continue;
        const b = Math.floor(r);
        const l = lum[row + x];
        rSum[b] += l; rSq[b] += l * l; rCnt[b]++;
        if (r <= shellPx) insideEnergy += l;
        if (r > shellPx && r <= bgPx) outsideEnergy += l;
      }
    }

    const rings = [];
    for (let b = 0; b <= maxR; b++) {
      if (!rCnt[b]) continue;
      const m = rSum[b] / rCnt[b];
      const sd = Math.sqrt(Math.max(0, rSq[b] / rCnt[b] - m * m));
      rings.push({ u: +(b / pxPerUnit).toFixed(4), px: b, mean: +m.toFixed(5), sd: +sd.toFixed(5) });
    }

    /* ---- 核心盘内的结构度量（湍流是否成形） ---- */
    const corePx = (layerRadii.core * 0.92) * pxPerUnit;
    let cSum = 0, cSq = 0, cCnt = 0, cLocal = 0, cLocalN = 0;
    const vals = [];
    for (let y = Math.max(1, Math.floor(cy - corePx)); y < Math.min(h - 1, cy + corePx); y += step) {
      const row = y * w;
      for (let x = Math.max(1, Math.floor(cx - corePx)); x < Math.min(w - 1, cx + corePx); x += step) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > corePx * corePx) continue;
        const v = perc[row + x];
        cSum += v; cSq += v * v; cCnt++;
        vals.push(v);
        // 3x3 局部对比：|中心 - 邻域均值|
        const nb = (perc[row - w + x] + perc[row + x - 1] + perc[row + x + 1] + perc[row + w + x]) * 0.25;
        cLocal += Math.abs(v - nb); cLocalN++;
      }
    }
    vals.sort((a, b) => a - b);
    const cMean = cSum / Math.max(1, cCnt);
    const cSd = Math.sqrt(Math.max(0, cSq / Math.max(1, cCnt) - cMean * cMean));
    const core = {
      meanPerc: +cMean.toFixed(4),
      sd: +cSd.toFixed(4),
      cv: +(cSd / Math.max(1e-5, cMean)).toFixed(4),
      localContrast: +(cLocal / Math.max(1, cLocalN)).toFixed(5),
      p05: +percentile(vals, 0.05).toFixed(4),
      p50: +percentile(vals, 0.50).toFixed(4),
      p95: +percentile(vals, 0.95).toFixed(4),
      dynamicRange: +(percentile(vals, 0.95) / Math.max(1e-4, percentile(vals, 0.05))).toFixed(2),
      pixels: cCnt
    };

    /* ---- 外壳带（晶体碎片所在环带）独立度量（v5.11）----
     * 之前只有「核心盘」指标：它把内部结构体与外壳混在一起，于是"对比度上升"其实
     * 是**内外之间**的差变大，外壳自己可能已经糊成一片白而完全测不出来。
     * 这里单独取 u∈[0.92, 1.45] 的环带：报分位数、局部对比、以及**接近纯白的像素占比**
     * blownFrac —— 这才是"外壳是不是糊成一片"的直接判据。 */
    const sIn = 0.92 * pxPerUnit;
    const sOut = 1.45 * pxPerUnit;
    let sSum = 0, sSq = 0, sCnt = 0, sLocal = 0, sLocalN = 0, sBlown = 0;
    const sVals = [];
    for (let y = Math.max(1, Math.floor(cy - sOut)); y < Math.min(h - 1, cy + sOut); y += step) {
      const row = y * w;
      for (let x = Math.max(1, Math.floor(cx - sOut)); x < Math.min(w - 1, cx + sOut); x += step) {
        const dx = x - cx, dy = y - cy;
        const rr = Math.sqrt(dx * dx + dy * dy);
        if (rr < sIn || rr > sOut) continue;
        const v = perc[row + x];
        sSum += v; sSq += v * v; sCnt++;
        sVals.push(v);
        if (v > 0.92) sBlown++;
        const nb = (perc[row - w + x] + perc[row + x - 1] + perc[row + x + 1] + perc[row + w + x]) * 0.25;
        sLocal += Math.abs(v - nb); sLocalN++;
      }
    }
    sVals.sort((a, b) => a - b);
    const sMean = sSum / Math.max(1, sCnt);
    const sSd = Math.sqrt(Math.max(0, sSq / Math.max(1, sCnt) - sMean * sMean));
    /* 只看**被点亮的碎片本体**（v>0.35）：带内平均会被碎片之间的空隙拉低，
     * 测不出"碎片自己是不是糊成一片白"。这里直接给出亮部的 p95 / 过曝占比 / 局部对比。 */
    let lSum = 0, lCnt = 0, lLocal = 0, lLocalN = 0, lBlown = 0, lHot = 0;
    const lVals = [];
    for (let y = Math.max(1, Math.floor(cy - sOut)); y < Math.min(h - 1, cy + sOut); y += step) {
      const row = y * w;
      for (let x = Math.max(1, Math.floor(cx - sOut)); x < Math.min(w - 1, cx + sOut); x += step) {
        const dx = x - cx, dy = y - cy;
        const rr = Math.sqrt(dx * dx + dy * dy);
        if (rr < sIn || rr > sOut) continue;
        const v = perc[row + x];
        if (v <= 0.35) continue;                 // 空隙/暗部不计
        lSum += v; lCnt++; lVals.push(v);
        if (v > 0.92) lBlown++;
        if (v > 0.80) lHot++;
        const nb = (perc[row - w + x] + perc[row + x - 1] + perc[row + x + 1] + perc[row + w + x]) * 0.25;
        lLocal += Math.abs(v - nb); lLocalN++;
      }
    }
    lVals.sort((a, b) => a - b);
    const lMean = lSum / Math.max(1, lCnt);

    /* **面片级对比度**（v5.11 新增）—— "外壳糊成一片白" 的真正判据。
     * 像素级 localContrast 只反映相邻像素的抖动，光滑着色下天然偏低，测不出
     * "这块碎片和那块碎片是不是一样亮"。这里把壳带切成小块（约 0.12 世界单位，
     * 明显小于单个五边形面片），取每块的平均亮度，再看**块与块之间**的离散度：
     *   facet.cv 低  → 所有面片同亮度 → 结构消失（用户说的"一片白"）
     *   facet.cv 高  → 面片之间有明暗层次 → 结构可读
     * 同时给 p10/p90 的块亮度差 spread —— 直观的"最暗面片 vs 最亮面片"落差。 */
    const BS = Math.max(3, Math.round(pxPerUnit * 0.12));
    const bw = Math.ceil((2 * sOut) / BS) + 2;
    const bSum = new Float64Array(bw * bw);
    const bCnt = new Float64Array(bw * bw);
    const bx0 = Math.floor(cx - sOut), by0 = Math.floor(cy - sOut);
    for (let y = Math.max(1, by0); y < Math.min(h - 1, cy + sOut); y += step) {
      const row = y * w;
      for (let x = Math.max(1, bx0); x < Math.min(w - 1, cx + sOut); x += step) {
        const dx = x - cx, dy = y - cy;
        const rr = Math.sqrt(dx * dx + dy * dy);
        if (rr < sIn || rr > sOut) continue;
        const v = perc[row + x];
        if (v <= 0.35) continue;                 // 只统计被点亮的碎片本体
        const bi = Math.floor((y - by0) / BS) * bw + Math.floor((x - bx0) / BS);
        if (bi >= 0 && bi < bSum.length) { bSum[bi] += v; bCnt[bi]++; }
      }
    }
    const bMeans = [];
    for (let i = 0; i < bSum.length; i++) {
      if (bCnt[i] >= Math.max(4, (BS * BS) >> 2)) bMeans.push(bSum[i] / bCnt[i]);
    }
    bMeans.sort((a, b) => a - b);
    const bMean = bMeans.reduce((a, b) => a + b, 0) / Math.max(1, bMeans.length);
    const bSd = Math.sqrt(
      bMeans.reduce((a, b) => a + (b - bMean) * (b - bMean), 0) / Math.max(1, bMeans.length));
    const facet = {
      blocks: bMeans.length,
      blockPx: BS,
      meanPerc: +bMean.toFixed(4),
      cv: +(bSd / Math.max(1e-5, bMean)).toFixed(4),
      p10: +percentile(bMeans, 0.10).toFixed(4),
      p90: +percentile(bMeans, 0.90).toFixed(4),
      spread: +(percentile(bMeans, 0.90) - percentile(bMeans, 0.10)).toFixed(4)
    };

    const shell = {
      facet,
      lit: {
        meanPerc: +lMean.toFixed(4),
        p50: +percentile(lVals, 0.50).toFixed(4),
        p95: +percentile(lVals, 0.95).toFixed(4),
        localContrast: +(lLocal / Math.max(1, lLocalN)).toFixed(5),
        hotFrac: +(lHot / Math.max(1, lCnt)).toFixed(4),     // >0.80 的亮部占比
        blownFrac: +(lBlown / Math.max(1, lCnt)).toFixed(4), // >0.92 的过曝占比
        pixels: lCnt
      },
      uBand: [0.92, 1.45],
      meanPerc: +sMean.toFixed(4),
      cv: +(sSd / Math.max(1e-5, sMean)).toFixed(4),
      localContrast: +(sLocal / Math.max(1, sLocalN)).toFixed(5),
      p05: +percentile(sVals, 0.05).toFixed(4),
      p50: +percentile(sVals, 0.50).toFixed(4),
      p95: +percentile(sVals, 0.95).toFixed(4),
      blownFrac: +(sBlown / Math.max(1, sCnt)).toFixed(4),   // >0.92 的像素占比：糊成白的比例
      pixels: sCnt
    };

    /* ---- 边缘梯度剖面（面板缝 / 棱 / 薄壳轮廓的机制性可读度） ---- */
    const edgeMaxR = Math.ceil((layerRadii.shellOut * 1.45) * pxPerUnit);
    const eSum = new Float64Array(edgeMaxR + 1);
    const eCnt = new Float64Array(edgeMaxR + 1);
    let strongFrac = 0, edgeTotal = 0;
    const r0 = Math.ceil((layerRadii.core * 0.55) * pxPerUnit);
    for (let y = Math.max(1, Math.floor(cy - edgeMaxR)); y < Math.min(h - 1, cy + edgeMaxR); y += step) {
      const row = y * w;
      for (let x = Math.max(1, Math.floor(cx - edgeMaxR)); x < Math.min(w - 1, cx + edgeMaxR); x += step) {
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < r0 || r > edgeMaxR) continue;
        const gx = perc[row + x + 1] - perc[row + x - 1];
        const gy = perc[row + w + x] - perc[row - w + x];
        const g = Math.sqrt(gx * gx + gy * gy);
        const b = Math.floor(r);
        eSum[b] += g; eCnt[b]++;
        edgeTotal++;
        if (g > 0.10) strongFrac++;
      }
    }
    const edgeProfile = [];
    for (let b = r0; b <= edgeMaxR; b++) {
      if (!eCnt[b]) continue;
      edgeProfile.push({ u: +(b / pxPerUnit).toFixed(4), grad: +(eSum[b] / eCnt[b]).toFixed(5) });
    }

    /* ---- 径向剖面极值检测：找一阶差分的极大处 ---- */
    const peaks = [];
    for (let i = 2; i < rings.length - 2; i++) {
      const prev = rings[i - 2].mean;
      const cur = rings[i].mean;
      const next = rings[i + 2].mean;
      if (cur > prev && cur > next && cur > 1e-4) {
        peaks.push({ u: rings[i].u, mean: rings[i].mean, prom: +((cur - Math.min(prev, next)) / cur).toFixed(3) });
      }
    }
    peaks.sort((a, b) => b.prom - a.prom);

    return {
      frame: { w, h, dpr: +(renderer.getPixelRatio?.() ?? 1).toFixed(2), step },
      geometry: {
        centerPx: [Math.round(cx), Math.round(cy)],
        pxPerUnit: +pxPerUnit.toFixed(2),
        corePx: Math.round(layerRadii.core * pxPerUnit),
        shellPx: Math.round(shellPx),
        layerPx: Object.fromEntries(Object.entries(layerRadii).map(([k, v]) => [k, Math.round(v * pxPerUnit)]))
      },
      global: {
        meanLinear: +meanL.toFixed(5),
        sdLinear: +sdL.toFixed(5),
        maxLinear: +maxL.toFixed(4),
        nonBlackFrac: +(nonBlack / n).toFixed(4)
      },
      core,
      shell,
      rings,
      edgeProfile,
      edge: {
        strongFrac: +(strongFrac / Math.max(1, edgeTotal)).toFixed(4),
        samples: edgeTotal
      },
      energy: {
        inside: +insideEnergy.toFixed(2),
        outside: +outsideEnergy.toFixed(2),
        outsideRatio: +(outsideEnergy / Math.max(1e-6, insideEnergy + outsideEnergy)).toFixed(5)
      },
      peaks: peaks.slice(0, 8)
    };
  }
}
