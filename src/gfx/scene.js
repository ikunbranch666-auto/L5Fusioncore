/**
 * 渲染管线：正交相机 + ACES 色调映射 + Selective Bloom + L5 电影感后处理 + 辐射外溢链
 * 来源：L5 实施说明书 §3.3 / §3.4 / §7.2-8 / 附录 B.8（7.1.1 / 7.1.2 / 3.1.1 / 2.3.1 / 2.2.1）
 *
 *  - 清屏色 #07090D（2.2.1），每帧清 COLOR | DEPTH
 *  - 正交视锥 H_world = 20.0u，Near 0.1 / Far 100.0，相机位于 (0, 0, 50.0)（3.1.1）
 *  - 轴测微倾斜 α = 15° 俯仰 / β = −10° 偏航（母卷 3.2.1，用于暴露顶面与右侧面棱构）
 *  - UnrealBloomPass(strength 0.85, radius 0.45, threshold 1.0) → [L5FxPass] → OutputPass
 *
 * ── 视觉增强层（非规格项，setFx(false) 可整段旁路）──
 *  · 辐射链（radiance.js）：L5 图层掩膜 → 半分辨率分离高斯 → L5FxPass 内做光晕 + 径向光轴
 *    —— 这是"外溢辐射"真正可见的来源；规格 Bloom 参数未被改动，外溢由独立通道承担。
 *  · L5FxPass 其余部分：径向色差 / 暗角 / 细颗粒 / 高亮区色相保持（对冲 ACES 去饱和）。
 *  · 能量外溢粒子（radiance.js L5Particles），随溢出下限闸门启停。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { targetDpr, SPILL_FLOOR } from '../core/photometry.js';
import { L5Radiance, L5Particles, L5EdgeFlow, GLOW_LAYER, PARTICLE_LAYER } from './radiance.js';
import { buildEdgeSegments } from './dodecaKit.js';

export const H_WORLD = 20.0;
export const AXON_TILT_X = THREE.MathUtils.degToRad(15.0);   // α 俯仰
export const AXON_TILT_Y = THREE.MathUtils.degToRad(-10.0);  // β 偏航

/** L5 电影感后处理 + 辐射外溢合成 */
const L5FxShader = {
  name: 'L5FxShader',
  uniforms: {
    tDiffuse: { value: null },
    tGlow: { value: null },                          // 半分辨率模糊后的 L5 辐射纹理
    u_center: { value: new THREE.Vector2(0.5, 0.5) },  // 核心在屏幕空间的 uv
    u_aspect: { value: 1.0 },
    u_time: { value: 0.0 },
    u_amount: { value: 1.0 },
    u_intensity: { value: 1.2 },                      // E(t)
    u_color: { value: new THREE.Color(0x00f2fe) },     // H_accent
    u_glow: { value: 0.10 },                          // 光晕强度（v3 标定值；v2 的 0.42 会把整帧推到体外）
    u_rays: { value: 0.06 }                           // 径向光轴强度（v2 的 0.28 同理）
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform sampler2D tGlow;
    uniform vec2  u_center;
    uniform float u_aspect;
    uniform float u_time;
    uniform float u_amount;
    uniform float u_intensity;
    uniform vec3  u_color;
    uniform float u_glow;
    uniform float u_rays;

    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec2 uv = vUv;
      vec3 base = texture2D(tDiffuse, uv).rgb;
      float hot = clamp(u_intensity / 3.5, 0.0, 1.0);
      vec2 toC = (u_center - uv) * vec2(u_aspect, 1.0);
      float distC = length(toC);

      // —— ① 外溢光晕（来自辐射链的柔和光晕纹理）——
      vec3 halo = texture2D(tGlow, uv).rgb;

      // —— ② 径向光轴：沿「屏幕 → 核心中心」累积辐射纹理 ——
      //    距核心越远贡献越弱，避免整屏被光轴铺满
      vec3 rays = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < 20; i++) {
        float t = float(i) / 19.0;
        vec3 s = texture2D(tGlow, uv + toC * t * 0.55).rgb;
        float w = (1.0 - t * 0.9) * smoothstep(1.1, 0.12, distC + t * 0.35);
        rays += s * w;
        wsum += w;
      }
      rays /= max(wsum, 1e-4);

      // —— ③ 径向色差 ——
      vec2 caDir = toC / max(distC, 1e-4);
      vec2 ca = caDir * (0.0012 + 0.0016 * hot) * u_amount * smoothstep(0.05, 0.85, distC);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + ca).r;
      col.g = base.g;
      col.b = texture2D(tDiffuse, uv - ca).b;

      // —— 辐射合成：光晕 + 光轴，按强调色轻微染色 ——
      col += (halo * u_glow + rays * u_rays) * u_amount * (0.75 + 0.35 * u_color);

      // —— ④ 暗角 ——
      vec2 vv = (uv - vec2(0.5)) * vec2(u_aspect, 1.0);
      float vig = smoothstep(1.05, 0.28, length(vv) * 1.20);
      col *= mix(1.0, vig, 0.80 * u_amount);

      // —— ⑤ 高亮区色相保持（对冲 ACES 去饱和，使 65.1 的双色相在过载态仍可辨）——
      float l = luma(col);
      float sat = 1.0 + 0.32 * u_amount * smoothstep(1.0, 2.6, l);
      col = mix(vec3(l), col, sat);

      /* —— ⑤b 高能量防过曝：亮部软膝压缩（v5.7）——
       * 高能量态下多层加色（等离子核 / 硬壳 / 水晶 / 环状雾带 / 粒子 / 辐射链）叠加，
       * 峰值线性值远超 1.0 → 进 ACES 后被整片压成白（用户："几乎都要是一片白了"）。
       * 这里在 OutputPass（色调映射）之前对峰值做软膝：knee 以下原样通过，以上按
       * 1-exp 渐近压缩，渐近上限 ≈ knee + 0.62·(1−knee) ≈ 0.89，三通道同比例缩放
       * → 色相与相对关系完全保留，只是不再烧穿。
       * 压缩位于 bloom 之后：外围的柔和光晕（bloom 的贡献）完整保留，只有芯部被拉回。 */
      /* v5.11 修正：v5.7 的 1-exp 软膝**压过头了** —— 实测外壳亮部被挤成 p50 0.777 /
       * p95 0.799 的一条极窄带（局部对比只有 0.037），画面上就是"糊成一片白、看不清
       * 结构"。1-exp 在 knee 之上几乎是水平线，亮部之间的相对差被抹掉 ~10 倍。
       * 改用 **Reinhard 肩**：knee 处斜率连续，渐近到 knee+0.55，压缩但**保留相对差异**
       * （同样输入下亮部差保留约 3.6 倍）。knee 也抬高到 0.85 —— 只压真正的高光。 */
      float knee = 0.85;
      float mx = max(max(col.r, col.g), col.b);
      if (mx > knee) {
        float over = mx - knee;
        col *= (knee + over / (1.0 + over / 0.55)) / mx;
      }

      // —— ⑥ 细颗粒 ——
      float g = fract(sin(dot(uv * vec2(1234.5, 6789.1) + u_time, vec2(12.9898, 78.233))) * 43758.5453);
      col += (g - 0.5) * 0.016 * u_amount;

      gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    }
  `
};

export class L5Stage {
  constructor(canvas, l5Group, opts = {}) {
    this.canvas = canvas;
    this.zoom = opts.zoom ?? 2.5; // 展示特写倍率；1.00× 为 §3.1.1 规格视口

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // 探针需要 readPixels 回读默认帧缓冲，必须保留绘制缓冲
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x07090d, 1.0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100.0);
    this.camera.position.set(0, 0, 50.0);
    this.camera.lookAt(0, 0, 0);

    // 6.3 核心点光源（位置 0,0,0 / 4.0cd / 衰减指数 2.0 / 影响半径 3.5u）
    this.corePointLight = new THREE.PointLight(0x00f2fe, 4.0, 3.5, 2.0);
    this.scene.add(this.corePointLight);

    // 总装体容器：承载轴测倾斜与（展示模式下）自旋、视差
    this.assembly = new THREE.Group();
    this.assembly.rotation.x = AXON_TILT_X;
    this.assembly.rotation.y = AXON_TILT_Y;
    this.assembly.add(l5Group);
    this.scene.add(this.assembly);

    /* ---- 视觉增强：图层登记 + 辐射链 + 粒子 ---- */
    // GLOW_LAYER 掩膜遍历：标记了 noGlowMask 的对象跳过（如面向相机的辉光板 ——
    // 方形平面进掩膜会被模糊成"方形光晕"，v5.1 实测）。
    l5Group.traverse((obj) => { if (!obj.userData.noGlowMask) obj.layers.enable(GLOW_LAYER); });
    this.camera.layers.enable(GLOW_LAYER);
    this.camera.layers.enable(PARTICLE_LAYER);

    this.particles = new L5Particles(240);
    this.assembly.add(this.particles.points);

    // 沿外壳 30 条棱定向流动的粒子流（激发态才涌现）
    const { segs } = buildEdgeSegments(1.0);
    this.edgeFlow = new L5EdgeFlow(segs, 3);
    this.assembly.add(this.edgeFlow.points);

    this.radiance = new L5Radiance(this.renderer);
    this.fxEnabled = true;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.45, 1.0);
    this.composer.addPass(this.bloomPass);
    this.fxPass = new ShaderPass(L5FxShader);
    this.composer.addPass(this.fxPass);
    this.composer.addPass(new OutputPass());

    this._ndc = new THREE.Vector3();
    this.resize();
  }

  setZoom(zoom) {
    this.zoom = zoom;
    this.resize();
  }

  /** 视觉增强总开关（体积等离子核 + 约束场 + 硬壳细节 + 辐射链 + 粒子 + 后处理） */
  setFx(on, l5 = null) {
    this.fxEnabled = !!on;
    this.fxPass.enabled = !!on;
    this.fxPass.uniforms.u_amount.value = on ? 1.0 : 0.0;
    this.radiance.enabled = !!on;
    this.particles.setVisible(!!on);
    this.edgeFlow.setVisible(!!on);
    if (l5) l5.setEnhancements(!!on);
  }

  /**
   * 每帧同步后处理 / 辐射链所需参数
   * @param {THREE.Vector3} coreWorld 核心世界坐标（求屏幕投影中心）
   * @param {number} e0 规格 E0，用于附录 B.6 的溢出闸门
   */
  syncFx({ coreWorld, simTime, intensity, e0, color }) {
    const u = this.fxPass.uniforms;
    if (coreWorld) {
      this._ndc.copy(coreWorld).project(this.camera);
      u.u_center.value.set((this._ndc.x + 1) * 0.5, (this._ndc.y + 1) * 0.5);
    }
    u.u_time.value = simTime;
    u.u_intensity.value = intensity;
    if (color) u.u_color.value.copy(color);
    u.u_aspect.value = this.viewport ? this.viewport.aspect : 1.0;

    // 附录 B.6：E0 < 溢出下限 1.5 → 不产生可见光晕（IDLE 恒为 0）
    // 上界取规格封顶 3.5 而非 2.0：否则 ACTIVE_ENGAGE（E0 = 2.19）就已经满溢，
    // ENGAGE 与 OVERDRIVE 之间再无梯度 —— 实测两态的体外能量会同时拉满、糊成一片。
    const spill = this.fxEnabled
      ? THREE.MathUtils.smoothstep(e0 ?? intensity, SPILL_FLOOR, 3.5)
      : 0;
    this.spill = spill;

    const pNorm = Math.min(1, Math.max(0, (intensity - 1.2) / 2.3));
    this.particles.sync({ simTime, gain: spill * (0.30 + 0.70 * pNorm), color });
    // 沿棱粒子流：比散点更晚出现（要更"烫"才涌现），并用更陡的闸门
    const flowGate = this.fxEnabled
      ? THREE.MathUtils.smoothstep(e0 ?? intensity, SPILL_FLOOR + 0.55, 3.5)
      : 0;
    this.edgeFlow.sync({ simTime, gain: flowGate * (0.35 + 0.65 * pNorm), color });
    const rs = this._radScale ?? 1.0;
    this._radianceGain = spill * 0.28 * rs;
    this._radianceColor = color;
  }

  /** 视觉标定通道（非规格项）：?tk_glow=0.2&tk_rays=0.1&tk_bloom=0.85&tk_expo=1.0 ... */
  setTune(t = {}) {
    if (t.glow != null) this.fxPass.uniforms.u_glow.value = t.glow;
    if (t.rays != null) this.fxPass.uniforms.u_rays.value = t.rays;
    if (t.bloom != null) this.bloomPass.strength = t.bloom;
    if (t.bloomR != null) this.bloomPass.radius = t.bloomR;
    if (t.bloomT != null) this.bloomPass.threshold = t.bloomT;
    if (t.expo != null) this.renderer.toneMappingExposure = t.expo;
    if (t.rad != null) this._radScale = t.rad;
    if (t.particle != null) this._particleScale = t.particle;
  }

  /** @param {HTMLElement} container 用于按 CSS 视口尺寸解算视锥 */
  resize(container = this.canvas.parentElement || document.body) {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const dpr = targetDpr(window.devicePixelRatio);

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    // 先给出 CSS 尺寸再设像素比，避免 EffectComposer 内部以 undefined 尺寸初始化
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(dpr);
    this.radiance.setSize(w * dpr, h * dpr);

    const aspect = w / h;
    const half = H_WORLD / 2 / this.zoom;
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();

    this.viewport = { width: w, height: h, dpr, aspect };
    if (this.fxPass) this.fxPass.uniforms.u_aspect.value = aspect;
    return this.viewport;
  }

  render() {
    if (this.fxEnabled) {
      this.radiance.render(this.scene, this.camera, {
        color: this._radianceColor || this.fxPass.uniforms.u_color.value,
        gain: this._radianceGain || 0
      });
      this.fxPass.uniforms.tGlow.value = this.radiance.texture;
    }
    this.composer.render();
  }

  dispose() {
    this.composer.dispose?.();
    this.radiance.dispose();
    this.particles.dispose();
    this.edgeFlow.dispose();
    this.renderer.dispose();
  }
}
