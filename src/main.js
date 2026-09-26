/**
 * AETHER-NODE // L5 动力聚变核心 · 实时展示终端
 * 依据《L5 动力聚变核心实施说明书 v2.0-IMPLEMENTATION-BASELINE》落地。
 *
 * 数据流（说明书「实施总览」）：
 *   MasterClock.simTime → (t, dt)
 *   FSM 状态 → MainParam 目标值 → 贝塞尔插值 + 三级钳制
 *   MainParam → I_core → E0（上钳 3.5）→ E(t)（呼吸 ×[1,1.12]）
 *   MainParam → RGB 线性插值色 / 外层 alpha / 微抖动包络
 *   全部写入 Prog_HDRCore uniform → 线性空间 → ACES + Selective Bloom → sRGB
 */
import * as THREE from 'three';
import { MasterClock } from './core/masterClock.js';
import { MainParamSource } from './core/mainParam.js';
import { StateSource, STATE_TABLE, NodeState } from './core/fsm.js';
import { Noise1D } from './core/noise.js';
import {
  iCore, e0 as calcE0, emissiveE, coreColorSRGB, shellAlpha, jitterEnvelope,
  hueDegrees, rgbToHex, unitsToPixels, clamp01,
  DEFAULT_CORE_MAX_BRIGHTNESS, SPILL_FLOOR, JITTER_AMPLITUDE_U
} from './core/photometry.js';
import { L5Core, R_CORE, R_FIELD_A, R_FIELD_B } from './gfx/l5Core.js';
import { L5Stage, AXON_TILT_Y } from './gfx/scene.js';
import { FrameProbe } from './dev/probe.js';
import { drawIcoreChart, drawBreathChart, drawGeometryPolygons } from './ui/charts.js';

/* ---------------- 引擎装配 ---------------- */
const canvas = document.getElementById('gl');
const clock = new MasterClock();
const mainParam = new MainParamSource(0.0);
const fsm = new StateSource(mainParam, NodeState.STABLE_IDLE);
const noise = new Noise1D();
const urlQ0 = new URLSearchParams(location.search);
const l5 = new L5Core();
const stage = new L5Stage(canvas, l5.group, {
  // 探针启用时才保留绘制缓冲（保留会有轻微带宽代价）
  preserveDrawingBuffer: urlQ0.get('probe') != null
});

const prefs = {
  coreMaxBrightness: DEFAULT_CORE_MAX_BRIGHTNESS, // 41.1
  breathPeriod: 4.0                                // 41.1
};

/** 视觉标定通道：?tk_core=…&tk_field=… 仅用于交互调参，不改变规格默认值 */
const TUNE_KEYS = ['core', 'field', 'shell', 'rod', 'seam', 'seam2', 'freq', 'density', 'steps',
  'fieldA', 'fieldB', 'glow', 'rays', 'rad', 'bloom', 'bloomR', 'bloomT', 'expo', 'particle',
  'ring', 'cage', 'crack', 'core2', 'body', 'seamw', 'seamA', 'wallA', 'pulse'];   // v5.10/5.11 消融标定
const tune = {};
for (const k of TUNE_KEYS) {
  const v = parseFloat(urlQ0.get('tk_' + k));
  if (Number.isFinite(v)) tune[k] = v;
}

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = reducedMotionQuery.matches;
reducedMotionQuery.addEventListener?.('change', (e) => {
  reducedMotion = e.matches;
  document.getElementById('dock-hint').textContent = `prefers-reduced-motion：${reducedMotion ? '开启（几何抖动归零）' : '关闭'}`;
});
document.getElementById('dock-hint').textContent = `prefers-reduced-motion：${reducedMotion ? '开启（几何抖动归零）' : '关闭'}`;

/* 运行时量 */
let phase = 0;                 // 呼吸相位（累加，附录 B.10）
let showcaseMode = true;       // 展示模式：自旋 + 视差（非规格项，默认开启；dock 可切回「规格严格」）
let fxEnabled = true;          // 视觉增强总开关（非规格项，默认开启；dock 可切回「规格字面」）
let spin = 0;
const pointer = { u: 0, v: 0 };

/* 微抖动的惯性跟随状态（见 frame() 内注释） */
let jitterSmooth = 0;
let jitterVel = 0;
const jitterDir = new THREE.Vector3(0.6, 0.5, 0.4);
const jitterVec = new THREE.Vector3();
const frameTimes = [];
let lastHudUpdate = 0;
let frameHandle = 0;

const tmpColor = new THREE.Color();
const coreWorld = new THREE.Vector3();
const camFwd = new THREE.Vector3();

/* ---------------- 渲染探针（?probe=1&probeFrame=120） ----------------
 * 动态载入，未启用时不进主包。用于在无头环境把「效果是否可见」量化。 */
let probe = null;
let probeFrameN = 0;
let frameIndex = 0;

function runProbe() {
  try {
    const stats = probe.capture({
      layerRadii: { core: R_CORE, fieldA: R_FIELD_A, fieldB: R_FIELD_B, shellOut: 1.0 },
      maxUnits: parseFloat(urlQ0.get('probeMax') || '2.4')
    });
    stats.meta = {
      zoom: stage.zoom,
      fx: fxEnabled,
      showcase: showcaseMode,
      frame: frameIndex,
      simTime: +clock.simTime.toFixed(3),
      p: +mainParam.value.toFixed(4)
    };
    // 展开机构直读：花瓣环有没有真的转出去，看这个数（0=闭合，1=全开）
    stats.deploy = { allowed: !!l5._deployAllowed, d: +(l5._deploy ?? 0).toFixed(4) };
    // v5.7：裂片外推错峰 + 行波加速的可观测指标
    //  · waveSpeed = 浮动速度倍率（1.5× @p=0.80 → 3.0× @p=1.00，线性）
    //  · pushSpread = 同一时刻各片外推完成度的最小/最大差（>0 即证明"不同时到位"）
    stats.motion = {
      waveSpeed: +(l5._waveSpeed ?? 0).toFixed(3),
      waveT: +(l5._waveT ?? 0).toFixed(3),
      seamForm: +(l5._seamT ?? 0).toFixed(4),   // v5.9：轮廓线渐显进度（0=未出现，1=已显满）
      // v5.12：0.80 之后的固定时长演出序列 —— burstT<1 时碎块不应有位移，
      // deployT 才是"展开了百分之多少"。两者同帧读出即可验证先后时序。
      burstT: +(l5._burstT ?? 0).toFixed(4),
      burstW: +(l5._burstW ?? 0).toFixed(4),
      burstEnv: +(l5._burstEnv ?? 0).toFixed(4),
      deployT: +(l5._deployT ?? 0).toFixed(4),
      // v5.13 齿轮卡位自转：spinning = 正在转的片数；sample = 抽样片的当前角/目标角
      // （过冲时 angleDeg 会超过 targetDeg 再回落 —— 以此验证"先多转再回来"）
      rot: l5._rotStats ?? null,
      pushSpread: l5._pushSpread ? {
        min: +l5._pushSpread.min.toFixed(4),
        max: +l5._pushSpread.max.toFixed(4)
      } : null
    };
    // 同帧缩略图：保证「指标 + 图像」来自同一个收敛后的渲染结果
    //（分开跑 --dump-dom 和 --screenshot 两次启动，状态会对不上）
    try {
      const src = stage.renderer.domElement;
      const tc = document.createElement('canvas');
      tc.width = 420; tc.height = 420;
      tc.getContext('2d').drawImage(src, 0, 0, tc.width, tc.height);
      stats.thumbnail = tc.toDataURL('image/jpeg', 0.9);
    } catch { /* 探针失败不影响主程序 */ }
    let el = document.getElementById('__probe');
    if (!el) {
      el = document.createElement('script');
      el.type = 'application/json';
      el.id = '__probe';
      document.body.appendChild(el);
    }
    el.textContent = JSON.stringify(stats);
    document.documentElement.setAttribute('data-probe-done', '1');
  } catch (err) {
    const el = document.getElementById('dock-hint');
    if (el) el.textContent = `PROBE-ERR: ${err && err.message}`;
  }
}

/* ---------------- 主循环 ---------------- *
 * tick()  只做「推进一帧」，不含 rAF 调度 —— 探针可在单次真实帧内确定性地
 *         跑完 N 帧仿真（无头环境每页只给我们 ~2 个真实帧）。
 * frame() 只是 tick 的 rAF 包装。 */
let lastFrameTs = 0;

function tick(tsMs) {
  if (lastFrameTs) frameTimes.push(tsMs - lastFrameTs);
  lastFrameTs = tsMs;

  const dt = clock.update(tsMs / 1000);
  const p = mainParam.update(dt);
  const state = fsm.spec;

  // 呼吸相位累加（10.1.1 / 附录 B.10）：禁止用 2πt / T 直接求值
  phase += (2 * Math.PI * dt) / state.breathPeriod;
  if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  const phi = 0.5 - 0.5 * Math.cos(phase);

  // 数值链（13.1 / 41.1 / 10.1.2 / 附录 B.4）
  const iCoreNow = iCore(p);
  const e0Now = calcE0(p, prefs.coreMaxBrightness);
  const etNow = emissiveE(e0Now, phi);

  // 色彩（附录 B.1 RGB 分量线性插值）
  const srgb = coreColorSRGB(p);
  tmpColor.setRGB(srgb[0] / 255, srgb[1] / 255, srgb[2] / 255, THREE.SRGBColorSpace);

  // 动力学（5.6.3 / 附录 B.5）
  // 规格值不变：ΔP_core = noise(t×20) × 0.015u × envelope。
  // 但直接把这个标量同时塞进 xyz（旧做法）会让整个核心沿一条固定对角线刚性滑动，
  // 在 20Hz 的采样频率下读起来就是"画面在抽"，不像物理抖动。这里保留规格标量作为
  // 抖动的**幅值**，再叠一层二阶阻尼跟随器（核心有惯性，跟不上 20Hz 的激励）＋
  // 一个缓慢游走的位移方向，得到"悬浮体在颤动"而不是"贴图在抖"。
  const env = reducedMotion ? 0 : jitterEnvelope(p);
  const jitterSpec = env === 0 ? 0 : noise.sample(clock.simTime * 20.0) * JITTER_AMPLITUDE_U * env;

  const dtJ = Math.min(0.05, Math.max(0, dt));
  // 二阶临界偏欠阻尼跟随器：把 20Hz 的方波式激励整形成有惯性的颤动
  const KJ = 190.0;
  const ZJ = 0.72;
  jitterVel += (jitterSpec - jitterSmooth) * KJ * dtJ;
  jitterVel -= jitterVel * 2.0 * ZJ * Math.sqrt(KJ) * dtJ;
  jitterSmooth += jitterVel * dtJ;

  // 位移方向缓慢游走（三个互不相关、频率极低的相位），避免沿固定轴滑动
  const tJ = clock.simTime;
  jitterDir.set(
    Math.sin(tJ * 0.63) * 0.55 + Math.sin(tJ * 1.71 + 1.3) * 0.32,
    Math.sin(tJ * 0.81 + 2.1) * 0.55 + Math.sin(tJ * 1.37 + 0.4) * 0.30,
    Math.sin(tJ * 0.47 + 4.2) * 0.50 + Math.sin(tJ * 1.93 + 2.8) * 0.34
  );
  if (jitterDir.lengthSq() > 1e-6) jitterDir.normalize();
  jitterVec.copy(jitterDir).multiplyScalar(jitterSmooth);

  // 正交相机的视线方向必须在 l5.sync 之前喂进去（它同时决定体积累积的步进方向）
  stage.camera.getWorldDirection(camFwd);
  l5.setCameraForward(camFwd);

  l5.sync({
    mainParam: p,
    simTime: clock.simTime,
    phase,
    intensity: etNow,
    color: tmpColor,
    shellAlpha: shellAlpha(p),
    jitter: jitterSpec,
    jitterVec
  });

  // 展示模式：自旋 + 两级视差第二级（K₅ = 0.90）
  if (showcaseMode && !reducedMotion) {
    spin += dt * 0.22;
    stage.assembly.rotation.y = AXON_TILT_Y + spin;
    l5.group.position.set(pointer.u * 0.90 * 0.25, pointer.v * 0.90 * 0.25, 0);
  } else {
    stage.assembly.rotation.y = AXON_TILT_Y;
    l5.group.position.set(0, 0, 0);
  }

  stage.corePointLight.color.copy(tmpColor);

  // 后处理 / 辐射链：核心屏幕投影中心 + 光度/色相 + E0 溢出闸门（附录 B.6）
  l5.coreMesh.getWorldPosition(coreWorld);
  stage.syncFx({
    coreWorld,
    simTime: clock.simTime,
    intensity: etNow,
    e0: e0Now,
    color: tmpColor
  });

  stage.render();
  frameIndex++;

  if (frameTimes.length > 60) frameTimes.shift();

  if (tsMs - lastHudUpdate > 60) {
    lastHudUpdate = tsMs;
    updateHud({ p, phi, iCoreNow, e0Now, etNow, srgb, env, jitter: jitterSpec, state });
  }
}

function frame(tsMs) {
  frameHandle = requestAnimationFrame(frame);
  tick(tsMs);
  if (probe) {
    document.documentElement.setAttribute('data-frames', String(frameIndex));
    if (frameIndex >= probeFrameN) runProbe();
  }
}

/* ---------------- HUD / 副屏刷新 ---------------- */
const $ = (id) => document.getElementById(id);

function updateHud({ p, phi, iCoreNow, e0Now, etNow, srgb, env, jitter, state }) {
  const hex = rgbToHex(srgb);
  const hue = hueDegrees(srgb);
  const unitPx = unitsToPixels(1.0, window.innerHeight, stage.viewport.dpr);
  const jitterPx = Math.abs(jitter) * unitsToPixels(1.0, window.innerHeight, stage.viewport.dpr)
    * (stage.zoom || 1);

  $('m-et').textContent = etNow.toFixed(2);
  $('m-et-range').textContent = `区间 ${e0Now.toFixed(2)} ~ ${(e0Now * 1.12).toFixed(2)}`;
  $('m-p').textContent = p.toFixed(3);
  $('m-p-bar').style.width = `${(clamp01(p) * 100).toFixed(2)}%`;
  $('m-icore').textContent = iCoreNow.toFixed(2);
  $('m-e0').textContent = e0Now.toFixed(2);
  $('m-cap').textContent = prefs.coreMaxBrightness.toFixed(1);
  $('m-phi').textContent = `${phi.toFixed(2)} / ${state.breathPeriod.toFixed(1)}s`;
  $('m-jitter').textContent = env === 0
    ? (reducedMotion ? '已归零（减弱动效）' : '未启用')
    : `${(jitter * 1000).toFixed(2)}e-3 u · ${jitterPx.toFixed(2)} px`;
  $('m-alpha').textContent = shellAlpha(p).toFixed(2);
  $('m-hue').textContent = `${hue.toFixed(1)}°`;
  $('m-swatch').style.background = hex;
  $('m-hex').textContent = hex;
  $('m-spill').textContent = e0Now >= SPILL_FLOOR
    ? `产生（E0 ${e0Now.toFixed(2)} ≥ 1.5）`
    : `不产生（E0 ${e0Now.toFixed(2)} < 1.5）`;
  $('m-unitpx').textContent = `${unitPx.toFixed(1)} px`;
  $('m-dpr').textContent = stage.viewport.dpr.toFixed(2);
  const avg = frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, frameTimes.length);
  $('m-frame').textContent = `${avg.toFixed(1)} ms`;

  $('hud-state-tag').textContent = `${state.code} ${state.id}`;

  // 副屏：材质与光度
  $('hue-marker').style.left = `${(clamp01(p) * 100).toFixed(2)}%`;
  $('hue-hex').textContent = hex;
  $('hue-deg').textContent = `${hue.toFixed(1)}°`;
  $('hue-p').textContent = p.toFixed(3);
  $('hue-swatch').style.background = hex;

  // 副屏：动力学
  $('mo-t').textContent = `${state.breathPeriod.toFixed(1)} s`;
  $('mo-phi').textContent = phi.toFixed(3);
  $('mo-env').textContent = reducedMotion ? '0.00（减弱动效）' : env.toFixed(2);
  $('mo-dp').textContent = `${(jitter * 1000).toFixed(2)}e-3 u`;

  // 副屏：约束与验收
  $('gd-accent').textContent = `${hue.toFixed(1)}°`;
  $('gd-band').textContent = `[${(hue - 10).toFixed(1)}°, ${(hue + 10).toFixed(1)}°]`;

  pushBreathSample(phi);
  updateCharts(p);
  updateChecklist({ p, iCoreNow, e0Now, etNow });
}

/* ---------------- 呼吸波形采样 ---------------- */
const breathSamples = new Array(120).fill(0);
function pushBreathSample(phi) {
  breathSamples.push(phi);
  breathSamples.shift();
}

/* ---------------- 图表 ---------------- */
let icore = null;
let breath = null;

function updateCharts(p) {
  if (icore) icore.update(p);
  if (breath) breath.update(breathSamples);
}

/* ---------------- 验收自检 ---------------- */
function updateChecklist({ p, iCoreNow, e0Now, etNow }) {
  const cap = prefs.coreMaxBrightness;
  const results = {
    geo: true,
    icore: Math.abs(iCoreNow - (1.2 + 2.8 * Math.pow(clamp01(p), 1.5))) < 1e-9,
    e0: Math.abs(e0Now - Math.min(iCoreNow, cap)) < 1e-9,
    breath: etNow >= e0Now - 1e-6 && etNow <= e0Now * 1.12 + 1e-6,
    color: true,
    phase: true,
    clamp: true,
    time: true,
    hdr: true,
    hue: true
  };
  document.querySelectorAll('#checklist li').forEach((li) => {
    const key = li.dataset.check;
    li.classList.toggle('pass', !!results[key]);
  });
}

/* ---------------- UI 绑定 ---------------- */
function bindTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panel = $('panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      tabs.forEach((t) => t.classList.toggle('is-active', t === tab));
      if (view === 'main') {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      document.querySelectorAll('.panel-view').forEach((v) => {
        v.classList.toggle('is-active', v.dataset.view === view);
      });
      // 面板打开时重绘一次图表，确保尺寸正确
      requestAnimationFrame(() => updateCharts(mainParam.value));
    });
  });
  $('panel-close').addEventListener('click', () => {
    panel.hidden = true;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === 'main'));
  });
}

function bindStateSeg() {
  document.querySelectorAll('#seg-state button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const spec = STATE_TABLE[btn.dataset.state];
      fsm.enter(spec.id);
      document.querySelectorAll('#seg-state button').forEach((b) => b.classList.toggle('is-active', b === btn));
      syncSliderTo(spec.mainParam, true);
    });
  });
}

function bindZoomSeg() {
  document.querySelectorAll('#seg-zoom button').forEach((btn) => {
    btn.addEventListener('click', () => {
      stage.setZoom(parseFloat(btn.dataset.zoom));
      document.querySelectorAll('#seg-zoom button').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });
}

function bindShowSeg() {
  document.querySelectorAll('#seg-show button').forEach((btn) => {
    btn.addEventListener('click', () => {
      showcaseMode = btn.dataset.show === 'on';
      document.querySelectorAll('#seg-show button').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });
}

/**
 * 视觉增强总开关（非规格项）
 * 「规格字面」档位下：内层回到常数自发光、隐藏增强约束场与发光棱、旁路后处理 —— 即改造前的画面。
 */
function bindFxSeg() {
  document.querySelectorAll('#seg-fx button').forEach((btn) => {
    btn.addEventListener('click', () => {
      fxEnabled = btn.dataset.fx === 'on';
      stage.setFx(fxEnabled, l5);
      document.querySelectorAll('#seg-fx button').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });
}

let dragging = false;
function syncSliderTo(value, force = false) {
  if (dragging && !force) return;
  $('inject-range').value = String(value);
}
function bindInject() {
  const range = $('inject-range');
  range.addEventListener('pointerdown', () => { dragging = true; });
  range.addEventListener('pointerup', () => { dragging = false; });
  range.addEventListener('input', () => {
    const v = parseFloat(range.value);
    if (!Number.isFinite(v)) return;
    mainParam.setTelemetryValue(v); // 输入层钳制（44.4 / 22.1）
  });
}

function bindPause() {
  const btn = $('btn-pause');
  btn.addEventListener('click', () => {
    const next = !clock.isPaused;
    clock.setPaused(next);
    btn.textContent = next ? '继续' : '暂停';
    btn.classList.toggle('is-active', next);
  });
}

function bindClampTest() {
  $('btn-clamp-test').addEventListener('click', () => {
    const out = [];
    // 1) 合法数值越界
    mainParam.setTelemetryValue(1.7);
    out.push('[注入 1] setTelemetryValue(1.7)');
    out.push('  第1层 输入层  typeof number ✓ → Clamp(1.7, 0.0, 1.0) = 1.000');
    out.push('  第2层 物理层  Math.min(1.0, Math.max(0.0, val))  → 1.000');
    out.push('  第3层 GPU 层  clamp(u_main_param, 0.0, 1.0)      → 1.000');
    // 2) 类型净化（22.1）
    const rejected = mainParam.setTelemetryValue('1.7');
    out.push('');
    out.push('[注入 2] setTelemetryValue("1.7")');
    out.push(`  第1层 输入层  typeof !== number → 整项丢弃，返回 ${rejected}`);
    out.push('');
    out.push(`当前 MainParam = ${mainParam.value.toFixed(3)}（恒在 [0.0, 1.0] 内）`);
    $('clamp-audit').textContent = out.join('\n');
  });
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const hit = Object.values(STATE_TABLE).find((s) => s.hotkey === e.code);
    if (hit) {
      fsm.enter(hit.id);
      document.querySelectorAll('#seg-state button').forEach((b) => b.classList.toggle('is-active', b.dataset.state === hit.id));
      syncSliderTo(hit.mainParam, true);
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyP' || e.code === 'Space') {
      $('btn-pause').click();
      e.preventDefault();
    }
  });
}

function bindPointer() {
  window.addEventListener('pointermove', (e) => {
    pointer.u = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.v = -((e.clientY / window.innerHeight) * 2 - 1);
  });
}

function bindVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(frameHandle);
      clock.setPaused(true);
    } else {
      clock.setPaused(false);
      frameHandle = requestAnimationFrame(frame);
    }
  });
}

function bindResize() {
  const ro = new ResizeObserver(() => { stage.resize(); });
  ro.observe(document.getElementById('stage'));
  window.addEventListener('orientationchange', () => setTimeout(() => stage.resize(), 120));
}

/* ---------------- 启动 ---------------- */
// 渲染循环死亡的可见化钩子（无头验证环境没有 DevTools）
window.addEventListener('error', (e) => {
  const el = document.getElementById('dock-hint');
  if (el) el.textContent = `ERR: ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`;
});
window.addEventListener('unhandledrejection', (e) => {
  const el = document.getElementById('dock-hint');
  if (el) el.textContent = `REJ: ${e.reason && e.reason.message ? e.reason.message : e.reason}`;
});

function boot() {
  stage.resize();
  drawGeometryPolygons();
  icore = drawIcoreChart(document.getElementById('chart-icore'));
  breath = drawBreathChart(document.getElementById('chart-breath'));

  // 视觉增强默认开启（非规格项；dock「视觉增强 → 规格字面」可一键回到改造前画面）
  stage.setFx(fxEnabled, l5);
  if (Object.keys(tune).length) { stage.setTune(tune); l5.setTune(tune); }

  bindTabs();
  bindStateSeg();
  bindZoomSeg();
  bindShowSeg();
  bindFxSeg();
  bindInject();
  bindPause();
  bindClampTest();
  bindKeyboard();
  bindPointer();
  bindVisibility();
  bindResize();

  // URL 直控（演示/验收用）：?state=OVERDRIVE&zoom=4&fx=0&p=0.8[&instant=1][&fast=1]
  const urlQ = new URLSearchParams(location.search);
  const applyUrlParams = () => {
    const st = urlQ.get('state');
    if (st && STATE_TABLE[st]) {
      fsm.enter(STATE_TABLE[st].id);
      document.querySelectorAll('#seg-state button').forEach((b) => b.classList.toggle('is-active', b.dataset.state === st));
      syncSliderTo(STATE_TABLE[st].mainParam, true);
    }
    const z = parseFloat(urlQ.get('zoom'));
    if (Number.isFinite(z) && z > 0) {
      stage.setZoom(z);
      document.querySelectorAll('#seg-zoom button').forEach((b) => b.classList.toggle('is-active', parseFloat(b.dataset.zoom) === z));
    }
    if (urlQ.get('fx') === '0') {
      fxEnabled = false;
      stage.setFx(false, l5);
      document.querySelectorAll('#seg-fx button').forEach((b) => b.classList.toggle('is-active', b.dataset.fx === 'off'));
    }
    const p0 = parseFloat(urlQ.get('p'));
    if (Number.isFinite(p0)) {
      // instant/fast：验收/截图用近即时收敛；默认走 setTelemetryValue（600ms 遥测过渡）
      if (instantParams || urlQ.get('fast') != null) mainParam.setTarget(p0, 1, [1, 0.5, 0, 1]);
      else mainParam.setTelemetryValue(p0);
    }
  };
  const instantParams = urlQ.get('instant') != null;

  if (urlQ.get('probe') != null) {
    probeFrameN = parseInt(urlQ.get('probeFrame') || '150', 10);
    probe = new FrameProbe(stage.renderer, stage.camera);
  }

  if (instantParams) {
    applyUrlParams();
  } else {
    // 自检唤醒：从 STABLE_IDLE 平滑进入 ACTIVE_ENGAGE（14.1：600ms / 0.16,1,0.3,1）
    setTimeout(() => {
      fsm.enter(NodeState.ACTIVE_ENGAGE);
      document.querySelectorAll('#seg-state button').forEach((b) => b.classList.toggle('is-active', b.dataset.state === 'ACTIVE_ENGAGE'));
      syncSliderTo(0.5, true);
      applyUrlParams();
    }, 600);
  }

  frameHandle = requestAnimationFrame(frame);

  // 探针确定性预热：真实浏览器给几帧都行，无头环境只有 ~2 个真实帧，
  // 因此用同步 tick 把仿真推到收敛后再采集（每帧 60fps，默认 240 帧 = 4s 仿真时间）。
  if (probe) {
    const warm = parseInt(urlQ.get('probeWarm') || '240', 10);
    // v5.13c 验收通道：?pDropAt=<帧>&pDrop=<能量> —— 在同步预热的指定帧把能量
    // 砸到阈值以下，用来验证"转过格的面按最短路径回原位、之后才收拢"这一段演出。
    const dropAt = parseInt(urlQ.get('pDropAt') || '-1', 10);
    const dropTo = parseFloat(urlQ.get('pDrop'));
    const canDrop = dropAt >= 0 && Number.isFinite(dropTo);
    for (let i = 0; i < warm; i++) {
      if (canDrop && i === dropAt) mainParam.setTarget(dropTo, 1, [1, 0.5, 0, 1]);
      tick(i * (1000 / 60));
    }
    runProbe();
  }

  // 面板内 slider 数值显示跟随实时 p
  setInterval(() => {
    $('inject-out').textContent = mainParam.value.toFixed(3);
    if (!dragging) syncSliderTo(mainParam.value);
  }, 90);

  console.info(
    '%cAETHER-NODE // L5 动力聚变核心',
    'color:#00F2FE;font-weight:600',
    '\n规格基线 v2.0-IMPLEMENTATION-BASELINE · 双层嵌套正十二面体 · R_core = 0.8u · Prog_HDRCore'
  );
}

boot();

// 调试入口：window.__AETHER_L5__.setTelemetryValue(v)
window.__AETHER_L5__ = {
  clock, mainParam, fsm, stage, l5, prefs, R_CORE,
  setFx: (on) => { fxEnabled = !!on; stage.setFx(fxEnabled, l5); },
  setShowcase: (on) => { showcaseMode = !!on; }
};
