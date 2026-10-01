/**
 * L5 辐射外溢链（视觉增强 ④，非规格项）
 *
 * 目的：让"热辐射外溢"真正可见，同时**不改动规格后处理**（7.1.2 的 Bloom
 * 0.85/0.45/1.0 与 3.1.1 的 ACES 曝光 1.0 保持不动）。
 *
 * 做法（经典 selective-glow + screen-space godrays 组合）：
 *   1) 掩膜：以 L5 专属图层渲染到半分辨率 RT，输出 H_accent × spillGain 的纯色剪影
 *      —— 只画 L5，背景为黑，因此后续模糊得到的是"L5 自身的光"，不会糊到 UI。
 *   2) 模糊：半分辨率两趟分离高斯（H/V）→ 得到柔和光晕纹理 tGlow。
 *   3) 合成：在 scene.js 的 L5FxPass 里同时取用
 *        · 直接采样 tGlow                → 核心外围光晕（halo）
 *        · 沿"屏幕→核心中心"方向 20 次采样 → 体积光轴（god rays / 光轴外溢）
 *
 * 规格闸门（附录 B.6）：IDLE 态 E0 = 1.20 < 1.5 溢出下限，不得出现可见光晕。
 * 因此 spillGain 由 main.js 传入，取值 smoothstep(1.5, 2.0, E0)，IDLE 恒为 0。
 */
import * as THREE from 'three';

export const GLOW_LAYER = 1;
export const PARTICLE_LAYER = 2;

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/* 掩膜材质：L5 剪影 → 强调色 × 增益（无光照，纯色） */
const MASK_FRAG = /* glsl */ `
precision highp float;
uniform vec3 u_color;
uniform float u_gain;
void main() { gl_FragColor = vec4(u_color * u_gain, 1.0); }
`;

/* 分离高斯（9 taps，线性采样）—— 半分辨率执行 */
const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 u_dir;          // 以像素为单位的步进方向
uniform vec2 u_texel;
varying vec2 vUv;
void main() {
  vec2 step = u_dir * u_texel;
  vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
  c += texture2D(tDiffuse, vUv + step * 1.3846).rgb * 0.316216;
  c += texture2D(tDiffuse, vUv - step * 1.3846).rgb * 0.316216;
  c += texture2D(tDiffuse, vUv + step * 3.2308).rgb * 0.070270;
  c += texture2D(tDiffuse, vUv - step * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}
`;

/* ---------------- 能量外溢粒子（增强 ④ 的动感部分） ---------------- */
const PARTICLE_VERT = /* glsl */ `
precision highp float;
attribute vec3 aSeed;        // (相位, 方位角种子, 速度/高度种子)
uniform float u_time;
uniform float u_size;
uniform float u_gain;
varying float vAlpha;
void main() {
  float life = fract(u_time * (0.05 + aSeed.z * 0.10) + aSeed.x);
  float r = mix(0.82, 2.45, life);
  float ang = aSeed.y * 6.2831853 + life * (0.9 + aSeed.z * 1.6) + u_time * 0.12;
  float h = (aSeed.z * 2.0 - 1.0) * 1.05 * (1.0 - life * 0.35);
  // 沿环带向外抛射，并随生命周期抬升，形成"约束场泄流"
  vec3 pos = vec3(cos(ang) * r, h + sin(ang * 2.0 + u_time * 0.4) * 0.12, sin(ang) * r);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = u_size * (1.0 - life * 0.45);
  vAlpha = sin(life * 3.14159265) * u_gain;
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 u_color;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float fall = pow(1.0 - r * 2.0, 2.2);
  gl_FragColor = vec4(u_color * fall * vAlpha * 2.2, 1.0);
}
`;

export class L5Particles {
  constructor(count = 240) {
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      seeds[i * 3 + 0] = Math.random();
      seeds[i * 3 + 1] = Math.random();
      seeds[i * 3 + 2] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        u_time: { value: 0 },
        u_size: { value: 1.8 },   // v5.25：3.4 → 1.8（粒子过大 = 廉价感）
        u_gain: { value: 0 },
        u_color: { value: new THREE.Color(0x00f2fe) }
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'L5_Radiance_Particles';
    this.points.renderOrder = 34;
    this.points.layers.set(PARTICLE_LAYER);
    this.points.frustumCulled = false;
  }

  sync({ simTime, gain, color }) {
    this.material.uniforms.u_time.value = simTime;
    this.material.uniforms.u_gain.value = gain;
    if (color) this.material.uniforms.u_color.value.copy(color);
    this.points.visible = gain > 0.001;
  }

  setVisible(on) { this.points.visible = on; }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

/* ---------------- 沿棱流动的粒子流（激发态） ---------------- *
 * 高能量时能量壳上"涌现"的定向流动：粒子沿十二面体的 30 条棱定向推进，
 * 头尾淡入淡出，形成能量沿骨架输运的读感（而不是 v3 那种环形乱飘的散点）。 */
const FLOW_VERT = /* glsl */ `
precision highp float;
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec3 aSeed;      // (相位, 速度系数, 抖动系数)
uniform float u_time;
uniform float u_size;
uniform float u_gain;
varying float vAlpha;
void main() {
  float t = fract(u_time * (0.16 + aSeed.y * 0.30) + aSeed.x);
  vec3 base = mix(aFrom, aTo, t);
  // 沿棱法向的微小摆动，避免粒子贴成一条死线
  vec3 dir = normalize(aTo - aFrom);
  vec3 side = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
  float wob = sin(u_time * 2.1 + aSeed.x * 31.0) * 0.012 * aSeed.z;
  vec3 pos = base + side * wob;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  // 头尾淡入淡出 + 中段最亮
  float life = sin(t * 3.14159265);
  gl_PointSize = u_size * (0.55 + 0.75 * life);
  vAlpha = pow(life, 1.4) * u_gain;
}
`;

const FLOW_FRAG = /* glsl */ `
precision highp float;
uniform vec3 u_color;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float fall = pow(1.0 - r * 2.0, 2.6);
  gl_FragColor = vec4(u_color * fall * vAlpha * 2.4, 1.0);
}
`;

export class L5EdgeFlow {
  /**
   * @param {Array<[THREE.Vector3, THREE.Vector3]>} segs 棱的端点表
   * @param {number} perSeg 每条棱上的粒子数
   */
  constructor(segs, perSeg = 3) {
    const n = segs.length * perSeg;
    const from = new Float32Array(n * 3);
    const to = new Float32Array(n * 3);
    const seed = new Float32Array(n * 3);
    const pos = new Float32Array(n * 3);
    let i = 0;
    for (const [a, b] of segs) {
      for (let k = 0; k < perSeg; k++) {
        from[i * 3] = a.x; from[i * 3 + 1] = a.y; from[i * 3 + 2] = a.z;
        to[i * 3] = b.x; to[i * 3 + 1] = b.y; to[i * 3 + 2] = b.z;
        seed[i * 3] = Math.random();
        seed[i * 3 + 1] = Math.random();
        seed[i * 3 + 2] = Math.random();
        i++;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aFrom', new THREE.BufferAttribute(from, 3));
    geo.setAttribute('aTo', new THREE.BufferAttribute(to, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));

    this.material = new THREE.ShaderMaterial({
      vertexShader: FLOW_VERT,
      fragmentShader: FLOW_FRAG,
      uniforms: {
        u_time: { value: 0 },
        u_size: { value: 2.2 },   // v5.25：4.2 → 2.2
        u_gain: { value: 0 },
        u_color: { value: new THREE.Color(0x00f2fe) }
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'L5_EdgeFlow';
    this.points.renderOrder = 34;
    this.points.layers.set(PARTICLE_LAYER);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  sync({ simTime, gain, color }) {
    this.material.uniforms.u_time.value = simTime;
    this.material.uniforms.u_gain.value = gain;
    if (color) this.material.uniforms.u_color.value.copy(color);
    this.points.visible = gain > 0.002;
  }

  setVisible(on) { this.points.visible = !!on && this.material.uniforms.u_gain.value > 0.002; }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

export class L5Radiance {
  constructor(renderer) {
    this.renderer = renderer;
    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true
    };
    this.maskRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.blurA = new THREE.WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });
    this.blurB = new THREE.WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });

    this.maskMaterial = new THREE.ShaderMaterial({
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: MASK_FRAG,
      uniforms: { u_color: { value: new THREE.Color(0x00f2fe) }, u_gain: { value: 0 } }
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        u_dir: { value: new THREE.Vector2(1, 0) },
        u_texel: { value: new THREE.Vector2(1, 1) }
      },
      depthTest: false,
      depthWrite: false
    });

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.enabled = true;
    this._size = { w: 1, h: 1 };
  }

  setSize(width, height) {
    const w = Math.max(2, Math.floor(width * 0.5));
    const h = Math.max(2, Math.floor(height * 0.5));
    this._size = { w, h };
    this.maskRT.setSize(w, h);
    this.blurA.setSize(w, h);
    this.blurB.setSize(w, h);
    this.blurMaterial.uniforms.u_texel.value.set(1 / w, 1 / h);
  }

  /** 返回本帧的柔和光晕纹理（blurB），供主后处理采样 */
  get texture() { return this.blurB.texture; }

  /**
   * 渲染辐射链
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {{color: THREE.Color, gain: number}} params gain=0 时整条链跳过
   */
  render(scene, camera, { color, gain }) {
    const r = this.renderer;
    if (!this.enabled || gain <= 0.0005) {
      // 仍需保证纹理内容被清零，避免上一帧残留
      if (this._dirty !== false) {
        const prevT = r.getRenderTarget();
        r.setRenderTarget(this.blurB);
        r.setClearColor(0x000000, 1);
        r.clear(true, false, false);
        r.setRenderTarget(prevT);
        this._dirty = false;
      }
      return false;
    }
    this._dirty = true;

    const prevTarget = r.getRenderTarget();
    const prevClear = new THREE.Color();
    r.getClearColor(prevClear);
    const prevAlpha = r.getClearAlpha();

    // ---- 1) 掩膜：只渲染 L5 图层 ----
    const prevOverride = scene.overrideMaterial;
    const prevLayers = camera.layers.mask;
    scene.overrideMaterial = this.maskMaterial;
    camera.layers.set(GLOW_LAYER);
    this.maskMaterial.uniforms.u_color.value.copy(color);
    this.maskMaterial.uniforms.u_gain.value = gain;

    r.setRenderTarget(this.maskRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, camera);

    // ---- 2) 分离高斯 H/V（两轮，得到更宽的光晕） ----
    const blur = (src, dst, dx, dy) => {
      this.blurMaterial.uniforms.tDiffuse.value = src.texture;
      this.blurMaterial.uniforms.u_dir.value.set(dx, dy);
      this.quad.material = this.blurMaterial;
      r.setRenderTarget(dst);
      r.clear(true, false, false);
      r.render(this.quadScene, this.quadCamera);
    };
    blur(this.maskRT, this.blurA, 1, 0);
    blur(this.blurA, this.blurB, 0, 1);
    blur(this.blurB, this.blurA, 2, 0);
    blur(this.blurA, this.blurB, 0, 2);

    // ---- 还原全局状态 ----
    scene.overrideMaterial = prevOverride;
    camera.layers.mask = prevLayers;
    r.setClearColor(prevClear, prevAlpha);
    r.setRenderTarget(prevTarget);
    return true;
  }

  dispose() {
    this.maskRT.dispose();
    this.blurA.dispose();
    this.blurB.dispose();
    this.maskMaterial.dispose();
    this.blurMaterial.dispose();
    this.quad.geometry.dispose();
  }
}
