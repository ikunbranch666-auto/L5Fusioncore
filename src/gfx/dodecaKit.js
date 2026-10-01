/**
 * 正十二面体几何工具包
 *
 * 为什么需要它：之前的结构层次是"几个同心整块十二面体"，在屏幕上只能读成同心轮廓，
 * 缺乏可拆装的机械感。要做出「外壳装甲板 / 内壳散热花瓣 / 展开动作」，必须把十二面体
 * 拆到"面"这一级——每个五边形面是一块可独立运动的板。
 *
 * 提供：
 *  · DODEC_FACE_NORMALS   12 个面法线（单位向量）
 *  · dodecaVertices(R)    20 个顶点（外接半径 R）
 *  · facePolygon(R, n)    某个面上的 5 个顶点（按绕向排序）
 *  · buildPetals(R)       12 块五边形"花瓣"，几何原点在铰链边中点，可直接做开门动画
 *  · buildEdgeSegments(R) 30 条棱的端点表（供沿棱流动的粒子流使用）
 *  · buildHeatFins(...)   散热鳍（v5.3 起不再使用 —— 面心外伸的白色矩形板被用户否决并移除）
 *  · buildConstraintRing(R) 单道约束环（XZ 平面，倾斜由父 Group 控制，便于做动效）
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PHI = 1.618033988749895;
export const INRADIUS_RATIO = 0.79465447;

/** 12 个面法线（已归一化）—— 与着色器 sdDodeca 中的常量必须一致 */
export const DODEC_FACE_NORMALS = (() => {
  const a = 0.85065081;
  const b = 0.52573111;
  return [
    new THREE.Vector3(a, b, 0), new THREE.Vector3(-a, b, 0),
    new THREE.Vector3(a, -b, 0), new THREE.Vector3(-a, -b, 0),
    new THREE.Vector3(0, a, b), new THREE.Vector3(0, -a, b),
    new THREE.Vector3(0, a, -b), new THREE.Vector3(0, -a, -b),
    new THREE.Vector3(b, 0, a), new THREE.Vector3(-b, 0, a),
    new THREE.Vector3(b, 0, -a), new THREE.Vector3(-b, 0, -a)
  ];
})();

/** 20 个顶点（外接半径 R） */
export function dodecaVertices(R) {
  const s = R / Math.sqrt(3);
  const v = [];
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) v.push(new THREE.Vector3(sx, sy, sz).multiplyScalar(s));
    }
  }
  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      v.push(new THREE.Vector3(0, s1 / PHI, s2 * PHI).multiplyScalar(s));
      v.push(new THREE.Vector3(s1 / PHI, s2 * PHI, 0).multiplyScalar(s));
      v.push(new THREE.Vector3(s1 * PHI, 0, s2 / PHI).multiplyScalar(s));
    }
  }
  return v;
}

/**
 * 某个面上的 5 个顶点（绕面法线逆时针排序）
 * @param {number} R 外接半径
 * @param {THREE.Vector3} n 面法线（单位）
 */
export function facePolygon(R, n) {
  const h = R * INRADIUS_RATIO;
  const verts = dodecaVertices(R).filter((v) => Math.abs(v.dot(n) - h) < 1e-4 * R);
  const center = n.clone().multiplyScalar(h);
  // 面内正交基
  const up = Math.abs(n.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const t = new THREE.Vector3().crossVectors(up, n).normalize();
  const b = new THREE.Vector3().crossVectors(n, t).normalize();
  verts.sort((p, q) => {
    const ap = Math.atan2(p.clone().sub(center).dot(b), p.clone().sub(center).dot(t));
    const aq = Math.atan2(q.clone().sub(center).dot(b), q.clone().sub(center).dot(t));
    return ap - aq;
  });
  return { verts, center, t, b };
}

/**
 * 12 块五边形花瓣（= 内壳被拆开后的散热板）。
 *
 * 关键：**几何顶点保持在「相对十二面体中心」的坐标系**，不做偏移 —— 因为面板着色器
 * 要靠 vObjPos 反推面内 UV。铰链用一层父 Group 实现：hingeGroup 位于铰链边中点，
 * 花瓣 mesh 反向平移 -hinge，于是旋转 hingeGroup 就是绕铰链转，而 vObjPos 不受污染。
 *
 * @param {number} R 闭合状态下的外接半径（= 内壳半径）
 * @returns {Array<{pivot:THREE.Group, mesh:THREE.Mesh, normal:THREE.Vector3,
 *                  axis:THREE.Vector3, openSign:number, center:THREE.Vector3}>}
 */
export function buildPetals(R) {
  const out = [];
  for (const n of DODEC_FACE_NORMALS) {
    const { verts, center } = facePolygon(R, n);
    if (verts.length !== 5) continue;

    // 铰链边取第 0-1 边
    const hinge = verts[0].clone().add(verts[1]).multiplyScalar(0.5);
    const axis = verts[1].clone().sub(verts[0]).normalize();

    // 判断往哪边转才是"向外开"：取离铰链最远的顶点试转一个小角度
    const far = verts[3].clone();
    const rel = far.clone().sub(hinge);
    let sign = 1;
    let bestGain = -Infinity;
    for (const s of [1, -1]) {
      const th = 0.15 * s;
      const p = rel.clone()
        .multiplyScalar(Math.cos(th))
        .add(new THREE.Vector3().crossVectors(axis, rel).multiplyScalar(Math.sin(th)))
        .add(axis.clone().multiplyScalar(axis.dot(rel) * (1 - Math.cos(th))));
      const gain = p.clone().add(hinge).length() - far.length();
      if (gain > bestGain) { bestGain = gain; sign = s; }
    }

    // 扇形三角化，顶点为「相对中心」坐标
    const pos = [];
    for (let i = 0; i < 5; i++) {
      pos.push(center.x, center.y, center.z);
      pos.push(verts[i].x, verts[i].y, verts[i].z);
      pos.push(verts[(i + 1) % 5].x, verts[(i + 1) % 5].y, verts[(i + 1) % 5].z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const nrm = [];
    for (let i = 0; i < pos.length / 3; i++) nrm.push(n.x, n.y, n.z);
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));

    const mesh = new THREE.Mesh(geo, null);
    mesh.position.copy(hinge).multiplyScalar(-1);

    const pivot = new THREE.Group();
    pivot.position.copy(hinge);
    pivot.add(mesh);

    out.push({
      pivot, mesh, normal: n.clone(), axis,
      openSign: sign, center: center.clone(), hinge: hinge.clone()
    });
  }
  return out;
}

/** 30 条棱的端点（世界/物体坐标），供沿棱流动的粒子流复用 */
export function buildEdgeSegments(R) {
  const segs = [];
  const seen = new Set();
  const verts = dodecaVertices(R);
  for (const n of DODEC_FACE_NORMALS) {
    const { verts: fv } = facePolygon(R, n);
    if (fv.length !== 5) continue;
    for (let i = 0; i < 5; i++) {
      const a = fv[i];
      const b = fv[(i + 1) % 5];
      const key = [a, b].map((v) => v.toArray().map((x) => x.toFixed(4)).join(',')).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      segs.push([a.clone(), b.clone()]);
    }
  }
  return { segs, verts };
}

/**
 * 展开后显露的散热结构：12 片径向散热鳍（沿各面法线）。
 * 返回的 geometry 原点在物体中心，可直接用 scale 做 0→1 的展开动画。
 */
export function buildHeatFins(R) {
  const parts = [];
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();

  // 鳍的径向区间：内端留在内层核心（0.8u）之外，外端收到花瓣环（≈1.1u）以内
  // —— 展开后读作"瓣环里面的散热骨架"，而不是一排戳出去的路牌
  const FIN_R0 = 0.85, FIN_R1 = 1.18;
  const FIN_MID = (FIN_R0 + FIN_R1) * 0.5;
  const FIN_LEN = FIN_R1 - FIN_R0;

  for (const n of DODEC_FACE_NORMALS) {
    // 单片鳍：沿面法线方向立起来的薄板
    const g = new THREE.BoxGeometry(R * 0.12, R * FIN_LEN, R * 0.018);
    q.setFromUnitVectors(up, n);
    g.applyQuaternion(q);
    g.translate(n.x * (R * FIN_MID), n.y * (R * FIN_MID), n.z * (R * FIN_MID));
    parts.push(g);

    // 鳍上的三道横向刻线（细长条模拟散热片脊）
    //  基：x → side（鳍宽方向）· y → n（薄，沿鳍长轴切片）· z → side×n（外伸）
    //  必须先旋转后平移 —— 反过来的话平移量会被旋转矩阵一起转走，脊会飞离鳍面。
    const side = Math.abs(n.y) < 0.99
      ? new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n).normalize()
      : new THREE.Vector3(1, 0, 0);
    const m = new THREE.Matrix4().makeBasis(side, n, new THREE.Vector3().crossVectors(side, n));
    for (let k = -1; k <= 1; k++) {
      const rg = new THREE.BoxGeometry(R * 0.185, R * 0.016, R * 0.045);
      rg.applyMatrix4(m);
      const off = n.clone().multiplyScalar(R * (FIN_MID + k * FIN_LEN * 0.30));
      rg.translate(off.x, off.y, off.z);
      parts.push(rg);
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

/** 约束环半径比（相对 R）—— 环要框住展开后的花瓣环 */
export const RING_RADIUS_RATIO = 1.30;

/**
 * 单道约束环：几何平铺在 XZ 平面（环轴 = Y），倾斜交给父 Group ——
 * 这样环上的能量珠可以直接用 (R·cosθ, 0, R·sinθ) 参数化，随 Group 一起被倾斜带动。
 */
export function buildConstraintRing(R) {
  const g = new THREE.TorusGeometry(R * RING_RADIUS_RATIO, R * 0.014, 6, 96);
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * v5.2 面裂片 —— **正式碎裂设计**（不是"五边形均匀切几块"）
 *
 * 用户诉求：五边形外壳沿其上的**结构线**裂开成大小不一的结构片，平行于原面向外推开，
 * 每片绕面心法线规律旋转 + 上下缓慢浮动。手绘图只是动效示意，开裂方式在此正式定义：
 *
 * ① 结构线对齐：装甲板（着色器 mode-0）的结构线 = 面内 0.30 / 0.62 两圈同心五边形环
 *    + 五条指向顶点的辐条。裂纹就沿这些线走 —— 环向裂纹取 0.30/0.62（带确定性抖动），
 *    角向裂纹的起手相位落在顶点方向附近，因此闭合态看上去就是装甲板本来的分缝。
 *
 * ② 真实断裂拓扑：环向裂纹与角向裂纹**互相终止/错开**（真实裂纹遇到另一条裂纹就停），
 *    所以每个环带有**各自独立**的角向裂纹数与相位：内带 3~4 条、中带 3~4 条、外带 4~5 条，
 *    彼此错位 → 同时存在"中心小楔块 / 中环碎屑 / 外缘大板"，尺寸差异是拓扑自带的。
 *
 * ③ 裂纹蜿蜒（warp field）：裂纹路径由**纯函数** warp(a,t) 生成（a=方位角，t=归一化半径）：
 *      A = a + SIG_A · bump(t) · (两个不同频率的正弦叠加)  → 裂纹向外摆出 S 形
 *      T = t · (1 + SIG_T · bump(t) · sin(3a + φ))         → 环向裂纹不是正圆，随方位起伏
 *      bump(t) = 4t(1−t) 两端归零 → t=0 严格落在面心、t=1 严格落在五边形边界。
 *    因为是纯函数，相邻片采样同一条边界得到完全相同的点列 → 无重叠、无缝隙。
 *
 * ④ **参数空间网格三角化**（关键，踩过两个坑才定下来的做法）：
 *      × 坑一：绕质心缩放做内嵌环 —— 外缘板片是弧形板（香蕉形），缩放环必然自相交，
 *        实测三角面积比轮廓大 10~45%，内嵌刻线会画到板面中间。
 *      × 坑二：质心扇形填充 —— 香蕉形的质心可能落在形外，扇形三角会大面积互相重叠
 *        （实测三角只覆盖了自身轮廓的 0~57%）。
 *    现在改为：每片是 (a,t) 参数空间里的一个**矩形单元**，直接在该矩形上铺规则网格，
 *    再把网格点经 warp 映射到面内。参数空间里不会自相交，映射 (a,t)→(x,y) 在该单元上
 *    是同胚，因此三角化必然严丝合缝地铺满整片。
 *    注意 (a,t)→(x,y) 的雅可比行列式 = −r < 0（**反向映射**）：参数空间的逆时针网格
 *    在笛卡尔空间是顺时针，必须反绕，否则三角面全部背向相机 → gl_FrontFacing=false
 *    → 着色器把外法线翻成朝内，光照全反。
 *
 * ⑤ 逐顶点 aSeam = 「到本片轮廓的距离 / 带宽 W」，轮廓上为 0、≥W 处为 1：
 *    片外缘即裂纹面，能量从裂缝里漏出；aRim=1 表示该点落在**原五边形边界**上
 *    （原边比内部裂纹更亮 → 读作"面框还在"）。结构线因此贴合每片自身形状。
 *
 * ⑥ 棱面起伏（v5.3 水晶质感）：片不再是纯平面 —— 顶点沿面法线做浮雕位移
 *    zOf(bi,a,t)：带内鼓起（sin πu）、带缘归零（裂纹处自然成 V 槽）、环带间允许跳步
 *    （读作叠层装甲）。位移同样是 (a,t) 的纯函数 → 闭合态在 z 向也严丝合缝。
 *    配合非索引几何 computeVertexNormals() 得到**逐三角面片的真实法线**，
 *    硬高光随棱面跳变 —— 这是"水晶棱面"而非"玻璃平板"的关键。
 *
 * ⑦ 运动（v5.3 修订）：**绕轴旋转取消**（实测多层片互相遮挡穿模，用户否决），
 *    只保留沿法线的上下浮动。浮动为**同频行波**：sin(ωt − k·r)，相位 = 常数 ×
 *    片到面中心的距离（WAVE_K），相位差固定、随距离增大 → 三角函数波形感。
 *
 * 裂纹拓扑单独抽成 buildFaceFracturePlan()：**开裂设计是可检视、可复用的一等公民**，
 * 而不是埋在网格构建里的中间量 —— 便于离线出图核对裂法、也便于后续调参只动这一处。
 *
 * @returns {Array<{geo, faceCenter, normal, band:number, idx:number, faceIdx:number,
 *                  azimuth:number, area:number, radial:number,
 *                  pushAmt:number, arrive:number, rotSpeed:number,
 *                  floatFreq:number, floatPhase:number}>}
 */
export const TAU = Math.PI * 2;
export const PENTA_SEG = TAU / 5;            // 相邻边法线夹角 72°
/** 确定性伪随机 [0,1)：同一 seed 每次构建完全一致 */
export const det = (x) => {
  const s = Math.sin(x * 127.1 + 13.7) * 43758.5453;
  return s - Math.floor(s);
};

/* v5.32：**GPU 可精确镜像**的伪随机 [0,1) —— 供 jag 专用。
 *
 * 为什么 jag 不能用 det()/hash11：柱面要在**顶点着色器**里按当前前沿复算位置，
 * 而它必须落在"本体晶体"的同一套参数化上 —— 本体顶点是 CPU 烘的（含 jag），
 * 柱面是 GPU 算的 ⇒ 两边必须得到**逐位相同**的 jag 值。
 * det() 的做法 fract(sin(x*127.1+13.7)*43758.5453) 做不到：sin 的自变量可达 8e4，
 * float32 做参数约简的误差（~1e-2）被 ×43758 放大成完全不同的输出 —— 这正是本项目
 * 「hash 型伪随机不能跨 CPU/GPU 镜像」那条规则的实际成因。
 *
 * 换成**只用乘加**的 hash（Dave Hoskins 无 sin 版）：float32 的乘法/加法是 IEEE 严格
 * 舍入，CPU 用 Math.fround 逐步模拟即可逐位一致。GLSL 侧镜像见 l5Core 的
 * CRYST_LINE_GLSL（jhash），两侧必须**同步修改**。
 * ★ 改动任一侧都要同时改另一侧，否则柱面会整体错位（且不会报任何错）。 */
const f32 = Math.fround;
export const jhash = (p) => {
  let x = f32(p);
  x = f32(x * f32(0.1031)); x = f32(x - Math.floor(x));   // fract(p * 0.1031)
  x = f32(x * f32(x + f32(33.33)));                       // p *= p + 33.33
  x = f32(x * f32(x + x));                                // p *= p + p
  return f32(x - Math.floor(x));                          // fract(p)
};
/** GLSL 里的 `a*c0 + b*c1 + …` 是**逐步 float32** 运算，JS 的 float64 一次算完
 *  会在高位（~650 量级）积累 ~3e-4 的差，经 jhash 内部 ~2300× 的放大后变成
 *  约 7% 的噪声差（≈0.3px）。故这里也严格逐步模拟。
 *  用法：jhash(fmad([[ia, 7.13], [it, 3.71], [k, 11.9], [1, 1.7], [faceIdx, 0.37]])) */
export const fmad = (pairs) => {
  let acc = 0;
  for (const [v, c] of pairs) acc = f32(acc + f32(f32(v) * f32(c)));
  return acc;
};
export const norm = (a) => ((a % TAU) + TAU) % TAU;
/** 有序去重 */
export const uniqSort = (arr) => {
  const a = arr.map(norm).sort((x, y) => x - y);
  const out = [];
  for (const v of a) if (!out.length || v - out[out.length - 1] > 1e-5) out.push(v);
  return out;
};

/**
 * 单个五边形面的**开裂方案**（纯几何，不含网格）：
 *  · warp(a,t)  —— 裂纹蜿蜒场，(方位角, 归一化半径) → 面内 2D 点
 *  · bands      —— 3 个环带的半径边界 [0, t1, t2, 1]
 *  · breaks[bi] —— 第 bi 环带上各自的角向裂纹断点（各带独立 → 裂纹互相错开）
 *  · rB(a)      —— 沿方位角 a 到五边形边界的距离
 *
 * 用它即可离线画出真实裂法（见 tools/fracture-preview），不必起 WebGL。
 */
export function buildFaceFracturePlan(R, faceIdx) {
  const SEG = PENTA_SEG;
  const n = DODEC_FACE_NORMALS[faceIdx];
  const { verts, center, t: e1, b: e2 } = facePolygon(R, n);

  /* ---------- 面内 2D 坐标 ---------- */
  const v2 = verts.map((p) => {
    const q = p.clone().sub(center);
    return [q.dot(e1), q.dot(e2)];
  });
  // 边中点方向 = 该边外法线方向；其长度 = 内切半径 apothem
  const mx = (v2[0][0] + v2[1][0]) * 0.5;
  const my = (v2[0][1] + v2[1][1]) * 0.5;
  const apo = Math.hypot(mx, my);
  const phi0 = Math.atan2(my, mx);
  /** 沿方位角 a 到五边形边界的距离（边界法线方向为 phi0 + k·72°） */
  const rB = (a) => {
    const k = Math.round((a - phi0) / SEG);
    return apo / Math.max(1e-4, Math.cos(a - phi0 - k * SEG));
  };
  const vertAz = v2.map(([u, v]) => norm(Math.atan2(v, u)));

  /* ---------- 裂纹蜿蜒场（v5.3：振幅加大 + 多谐波 → 更碎、更不规则） ---------- */
  const ph = det(faceIdx * 1.37 + 0.9) * TAU;
  const SIG_A = 0.22 + 0.18 * det(faceIdx * 2.11 + 3.3);
  const SIG_T = 0.13 + 0.10 * det(faceIdx * 3.79 + 1.2);
  const bump = (t) => 4 * t * (1 - t);
  /** (方位角 a, 归一化半径 t) → 面内点；t=0 → 面心，t=1 → 五边形边界 */
  const warp = (a, t) => {
    const A = a + SIG_A * bump(t)
      * (Math.sin(t * 3.1 + ph) * 0.62 + Math.sin(t * 6.9 + ph * 1.7) * 0.38);
    // T 多谐波（2/3/5 次）：环向裂纹不再是"准同心圆"，随方位强烈起伏 → 不规整
    const T = t * (1 + SIG_T * bump(t)
      * (Math.sin(2.0 * a + ph * 1.3) * 0.50
       + Math.sin(3.0 * a + ph * 2.3) * 0.32
       + Math.sin(5.0 * a + ph * 0.7) * 0.18));
    const r = T * rB(A);
    return [Math.cos(A) * r, Math.sin(A) * r];
  };

  /* ---------- 晶体体场（v5.4）：厚板 + 刻面顶面 + 锯齿断裂面 ----------
   * v5.3 的"沿法线浮雕"被用户判为木雕 —— 因为它只是**一块薄片表面的凹凸**，没有体积。
   * v5.4 改为真正的**厚板晶体**：z ∈ [Z0, Z1] 是一段真实厚度（顶面 / 底面 / 侧壁），
   * 侧壁就是断裂面。关键约束：所有位移都写成 (a,t,z) 的**全局纯函数**，于是相邻片
   * 采样同一条断裂面时得到逐点相同的顶点 → 既能各自碎裂、又能拼回严丝合缝的一整块。
   *
   * ① 顶面刻面 facetH(a,t)：低频函数**量化**成 4 级 → 平直的宝石切面 + 锐利台阶，
   *    而不是连续起伏（连续起伏正是"木雕感"的来源）。
   * ② 断裂面锯齿 jag(a,t,z)：按 (方位块, 半径块, 高度段) 取块化白噪声 →
   *    棱状突起与凹陷；沿厚度分 5 段棱，段内常量 → 断口呈台阶状晶棱。
   * ③ V(a,t,z) = 面内 warp(a+δa, t+δt) + n·(z+δz+刻面) —— 全局单射，拼合无冲突。 */
  const CRYST_H = 0.030;                       // 晶体板厚度（v5.5：用户要求"非常薄的碎棱片"）
  const CRYST_Z0 = -0.012;                     // 底面（略高于内壳 0.96u，不相交）
  const CRYST_Z1 = CRYST_Z0 + CRYST_H;         // 顶面
  const FACET_A = 0.012;                       // 顶面刻面台阶高度（随厚度同步减薄）
  const phF1 = det(faceIdx * 19.3 + 1.1) * TAU;
  const phF2 = det(faceIdx * 21.7 + 5.3) * TAU;
  const facetH = (a, t) => {
    const g = Math.sin(3.0 * a + phF1) * 0.62 + Math.sin(2.0 * a - t * 5.1 + phF2) * 0.38;
    return (Math.round(g * 2.0) / 2.0) * FACET_A;
  };
  const JAG_A = 0.016, JAG_T = 0.016, JAG_Z = 0.003;
  const NQA = 72, NQT = 26, NQZ = 3;
  /* ★ v5.32：噪声源 det() → **jhash()**（GPU 可镜像，见该文件头注释）。
   * 只有 jag 换：jag 是唯一"CPU 烘进几何、GPU 又要复算同一个值"的量。
   * 其余（bands / breaks / ph / SIG_* / facetH 相位）全程只在 CPU 侧用，保持 det() 不变
   * ⇒ 裂法、环带、断裂相位等既有观感一点不动；变的只是断口锯齿的**具体随机值**
   *   （振幅/块化粒度/统计特性完全相同，肉眼不可分辨）。 */
  const jag = (a, t, z) => {
    const k = Math.min(NQZ - 1, Math.max(0,
      Math.floor(((z - CRYST_Z0) / CRYST_H) * NQZ + 1e-9)));
    const ia = Math.floor((norm(a) / TAU) * NQA + 1e-9);
    const it = Math.floor(t * NQT + 1e-9);
    return [
      JAG_A * (jhash(fmad([[ia, 7.13], [it, 3.71], [k, 11.9], [1, 1.7], [faceIdx, 0.37]])) - 0.5) * 2,
      JAG_T * (jhash(fmad([[ia, 3.29], [it, 9.17], [k, 5.31], [1, 4.2], [faceIdx, 0.71]])) - 0.5) * 2,
      JAG_Z * (jhash(fmad([[ia, 5.71], [it, 2.13], [k, 7.77], [1, 8.1], [faceIdx, 1.13]])) - 0.5) * 2
    ];
  };
  /** (a,t,z) → 3D（相对面心）。z=Z1 时额外叠加顶面刻面高度 */
  const V = (a, t, z) => {
    const j = jag(a, t, z);
    const p = warp(a + j[0], t + j[1]);
    const zz = z + j[2] + (z > CRYST_Z1 - 1e-6 ? facetH(a, t) : 0);
    return [
      e1.x * p[0] + e2.x * p[1] + n.x * zz,
      e1.y * p[0] + e2.y * p[1] + n.y * zz,
      e1.z * p[0] + e2.z * p[1] + n.z * zz
    ];
  };

  /* ---------- 环带 + 各带独立角向裂纹（v5.3：4 带、更碎） ---------- */
  const t1 = 0.20 + 0.08 * det(faceIdx * 5.13 + 2.7);
  const t2 = 0.42 + 0.10 * det(faceIdx * 6.71 + 4.4);
  const t3 = 0.68 + 0.10 * det(faceIdx * 7.77 + 5.9);
  const bands = [0.0, t1, t2, t3, 1.0];                   // 4 个环带
  const nSec = [
    4 + (det(faceIdx * 7.31 + 1.1) > 0.50 ? 1 : 0),       // 内带 4~5
    4 + (det(faceIdx * 8.17 + 5.5) > 0.45 ? 2 : 0),       // 4~6
    5 + (det(faceIdx * 9.53 + 6.2) > 0.50 ? 2 : 0),       // 5~7
    6 + (det(faceIdx * 9.91 + 8.8) > 0.55 ? 2 : 0)        // 外带 6~8
  ];
  // 起手相位落在顶点方向附近（与辐条结构线呼应）+ 权重抖动加大 → 大小不一、疏密不均
  const vAz0 = vertAz[0];
  const breaks = nSec.map((k, bi) => {
    const w = [];
    let s = 0;
    for (let i = 0; i < k; i++) {
      const x = 0.35 + 1.45 * det(faceIdx * 13.1 + bi * 4.7 + i * 2.9);
      w.push(x); s += x;
    }
    const off = vAz0 + 0.30 * SEG * (det(faceIdx * 17.3 + bi * 3.3) - 0.5) * 2;
    const out = [];
    let acc = 0;
    for (let i = 0; i < k; i++) { out.push(off + (acc / s) * TAU); acc += w[i]; }
    // norm() 会把跨 0 的角折回 [0,2π)，顺序随之打乱 —— 必须重新升序排序，
    // 否则「相邻断点构成一个扇区」会取到 a1 < a0 甚至跨度 > 2π 的区间（实测覆盖率 1.8×）。
    return uniqSort(out);
  });

  return {
    n, verts, center, e1, e2, v2, apo, phi0, SEG, rB, vertAz,
    warp, bands, breaks, ph, SIG_A, SIG_T,
    // v5.4 晶体体场
    CRYST_H, CRYST_Z0, CRYST_Z1, FACET_A, NQZ, facetH, jag, V,
    /* v5.31：前沿柱面需要 warp / facetH 的**面级常量**原值（顶点着色器里复算位置），
     * 只有这里能拿到（facetH 是个闭包，靠 phF1/phF2 定相位）。 */
    phF1, phF2,
    /* v5.31b：**前沿折线的 seed 改成"按面统一"**（原来是按片 vShard*3.1）。
     * 用户实测："这个面的侧面柱看着不连续……像是笔刷的痕迹"。
     * 根因：相邻碎块在同一方位角上抖动值完全不同 ⇒ 柱面在碎块边界出现
     *   ±(0.055+0.020) 半径的径向台阶；且每片的出场/退场时刻也各自错开
     *   ⇒ 同一圈上有的片有墙有的片没有 ⇒ 读成断续的笔触。
     * 按面统一后：同一面所有碎块共用同一条 j(az) 折线 ⇒ 半径连续 + 时刻同步
     *   ⇒ 柱面拼成一整圈连续锯齿墙。"不规则"不丢：折线仍是 7+19 段的尖角折线，
     *   只是同一面共用一条（面与面之间 seed 仍然不同）。 */
    frontSeed: det(faceIdx * 5.71 + 2.3) * 9.0
  };
}

/* ==================== v5.31：前沿柱面（frontier band）几何 ====================
 * 用户定标（2026-10-01）："水晶碎块面现在的渐显渐隐只是上下两个脉冲面在向外扩张，
 *   两个面之间并没有侧柱面相连……我要的是一整个水晶碎块在向外扩张的效果，
 *   而不是上下两个面。"（选定方案 B：保留连续细线前沿 + 补一层**真的**前沿柱面。）
 *
 * 为什么必须是独立几何而不是"在顶/底面上画一条色带"：
 *   v5.20 试过面内色带（coplanar）→ 用户实测："我怀疑你把柱面加到了那个贴片上面的
 *   那个面上，而不是上下两个五边形脉冲面之间的那个柱面上"。共面的色带永远不可能
 *   产生"上下关系"。柱面必须是 z ∈ [Z0,Z1] 上一段**有厚度的竖直曲面**。
 *
 * 为什么位置在**顶点着色器**里算而不是 CPU 每帧回写：
 *   柱面必须落在"碎块可见边缘"上，而这个边缘由片元 shellVis 用 crystalSegJitter(az)
 *   逐像素判定。要让两边严格同位置，只能让两边跑**同一段 GLSL**；CPU 侧镜像
 *   hash11（fract(sin(p*127.1)*43758.5)）会因 GPU sin 的舍入差而给出完全不同的
 *   伪随机值 → 柱面与边缘错开 ~4px。故：几何只烘**参数**（方位 / 厚度），
 *   真实 3D 位置由 VERT 用与 FRAG 同源的函数复算。
 *
 * 顶点 = 方位 NA 档 × 厚度 NZ 档；索引固定，position/normal 只是占位（每帧 VERT 重写）。
 * NA=14 的依据：前沿折线的细层是 19 段/2π（周期 0.33 rad），本片方位跨度典型
 *   0.5~1.5 rad → 14 档给出 0.04~0.11 rad 间距，远细于 0.33 → 折线尖角不丢。 */
const BAND_NA = 14;
const BAND_NZ = 4;      // 厚度分档（首/尾正好落在 Z0 / Z1）
/** @param a0,a1 本片的方位区间（与本体碎块同一段，两端与断裂侧壁对齐） */
export function buildBandGeometry(a0, a1, shardSeed) {
  const NV = BAND_NA * BAND_NZ;
  const bandV = new Float32Array(NV);
  const az = new Float32Array(NV);
  for (let i = 0; i < BAND_NA; i++) {
    const a = norm(a0 + (a1 - a0) * (i / (BAND_NA - 1)));
    for (let k = 0; k < BAND_NZ; k++) {
      const v = i * BAND_NZ + k;
      bandV[v] = k / (BAND_NZ - 1);          // 0 = 底 Z0，1 = 顶 Z1
      az[v] = a / TAU;                        // = aCrackAz（与本体同一口径）
    }
  }
  const idx = [];
  const at = (ii, kk) => ii * BAND_NZ + kk;
  for (let i = 0; i < BAND_NA - 1; i++) {
    for (let k = 0; k < BAND_NZ - 1; k++) {
      idx.push(at(i, k), at(i, k + 1), at(i + 1, k + 1));
      idx.push(at(i, k), at(i + 1, k + 1), at(i + 1, k));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NV * 3), 3));
  /* normal 只作占位：真实法线由顶点着色器算（柱面朝向随前沿变）。
   * ★ 不能留成全 0 —— VERT 里 normalize(normal) 会得到 NaN，再乘进 u_lift 项
   *   （0 × NaN = NaN）会把整个柱面的 gl_Position 打成 NaN → 柱面彻底不显示。 */
  const nrm0 = new Float32Array(NV * 3);
  for (let v = 0; v < NV; v++) nrm0[v * 3 + 2] = 1.0;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm0, 3));
  g.setAttribute('aBand', new THREE.BufferAttribute(new Float32Array(NV).fill(1), 1));
  g.setAttribute('aBandV', new THREE.BufferAttribute(bandV, 1));
  g.setAttribute('aCrackAz', new THREE.BufferAttribute(az, 1));
  g.setAttribute('aShard', new THREE.BufferAttribute(new Float32Array(NV).fill(shardSeed), 1));
  g.setIndex(idx);
  return g;
}

export function buildFaceFragments(R) {
  const SEG = PENTA_SEG;
  const frags = [];

  DODEC_FACE_NORMALS.forEach((n, faceIdx) => {
    const P = buildFaceFracturePlan(R, faceIdx);
    if (P.verts.length !== 5) return;
    const {
      verts, center, e1, e2, rB, warp, bands, breaks, vertAz, apo, phi0,
      ph, SIG_A, SIG_T, CRYST_H, CRYST_Z0, CRYST_Z1, NQZ, facetH, V, phF1, phF2, frontSeed
    } = P;

    /* ---------- 全局采样栅格（相邻片共享边界必须逐点一致） ----------
     * 每片只取「自己区间内」的采样点，绝不各自细分：各自细分会让共享边界两侧的点列
     * 不一致 → 弦损失变成真实的缝隙（实测 4~6% 的空洞）。 */
    // v5.4：片变成实体（顶/底/4 侧壁），采样点直接乘到三角数上 —— 栅格必须收紧，
    // 否则 285 片 × 6 面 ≈ 30 万三角形。收紧后仍能压住弧线弦损失（实测面积守恒 1.000）。
    const DA = 0.080;                       // 裂纹旁的方位采样间距（rad，≈4.6°）
    const DT = 0.075;                       // 裂纹旁的半径采样间距
    const Araw = [];
    for (const arr of breaks) {
      for (const a of arr) { Araw.push(a); Araw.push(a - DA); Araw.push(a + DA); }
    }
    for (const a of vertAz) Araw.push(a);     // 五边形顶点：最外圈才能与原边逐点重合
    for (let i = 0; i < 16; i++) Araw.push((i / 16) * TAU);   // 均匀密栅：压住弧线弦损失
    const Agl = uniqSort(Araw);

    const Rraw = [];
    for (let k = 0; k < bands.length - 1; k++) {
      const lo = bands[k], hi = bands[k + 1];
      Rraw.push(lo, hi);
      if (k > 0) Rraw.push(lo + DT);          // 内带 lo=0 是面心（一个点），不需要偏移采样
      Rraw.push(hi - DT, (lo + hi) * 0.5);
    }
    const Rgl = Rraw.filter((t) => t > 1e-6 && t <= 1.0 + 1e-9).sort((x, y) => x - y);

    /** [a0,a1] 内的全局方位采样（含两端点）；a1 允许 > TAU（跨 0） */
    const aSamples = (a0, a1) => {
      const out = [a0];
      for (const a of Agl) {
        for (let m = 0; m <= 1; m++) {
          const x = a + m * TAU;
          if (x > a0 + 1e-6 && x < a1 - 1e-6) out.push(x);
        }
      }
      out.push(a1);
      out.sort((x, y) => x - y);
      return out;
    };
    /** 环带 k 的半径采样（含两端） */
    const tSamples = (k) => {
      const lo = bands[k], hi = bands[k + 1];
      const out = [lo];
      for (const t of Rgl) if (t > lo + 1e-6 && t < hi - 1e-6) out.push(t);
      out.push(hi);
      return out;
    };

    /** 面内点 → 3D（相对面心） */
    const to3 = (p) => [
      e1.x * p[0] + e2.x * p[1],
      e1.y * p[0] + e2.y * p[1],
      e1.z * p[0] + e2.z * p[1]
    ];

    /** 厚度（顶面刻面高 − 底面）→ 供 Beer-Lambert 体积吸收用 */
    const thickAt = (a, t) => (CRYST_Z1 + facetH(a, t)) - CRYST_Z0;

    /* ---------- 单块晶体：参数空间"矩形柱体" → 实体（顶面/底面/4 面断裂侧壁） ----------
     * 侧壁不是光滑挤出，而是 jag(a,t,z) 的块化噪声面 —— 相邻片共享同一条断裂面时，
     * 因 jag 是 (a,t,z) 的全局纯函数且共享同一套全局采样点，两侧顶点逐点相同 →
     * 既能各自碎裂、又能拼回严丝合缝的一整块水晶（这是本设计的核心不变式）。 */
    const sub3 = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    const crs3 = (u, v) => [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0]
    ];
    const dot3 = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    /** 侧壁外法线参考：沿 ±a / ±t 的数值导数（正号 = 参数增大方向） */
    const edgeOut = (a, t, z, axis, sign) => {
      const e = 2e-3;
      const p0 = V(a, t, z);
      const p1 = axis === 'a' ? V(a + e, t, z) : V(a, t + e, z);
      const d = sub3(p1, p0);
      return sign > 0 ? d : [-d[0], -d[1], -d[2]];
    };

    const mkSolid = (bi, a0, a1) => {
      const A = aSamples(a0, a1);
      const T = tSamples(bi);
      const NA = A.length, NT = T.length;
      const lo = bands[bi], hi = bands[bi + 1];

      // 片自身尺度 → 边缘带宽度（小片的带必须更窄，否则整片都在发光）
      let rSum = 0;
      for (let i = 0; i < NA; i++) for (let j = 0; j < NT; j++) rSum += Math.hypot(...warp(A[i], T[j]));
      const rTyp = Math.max(rSum / (NA * NT), 1e-3);
      const thick = Math.min((a1 - a0) * rTyp, (hi - lo) * apo);
      const W = Math.min(0.030, 0.32 * Math.max(thick, 1e-3));

      // 顶面的「到轮廓距离 / 带宽」属性（裂纹面发光用）
      const seam = [], rimA = [];
      for (let i = 0; i < NA; i++) {
        const sr = [], rr = [];
        for (let j = 0; j < NT; j++) {
          const p = warp(A[i], T[j]);
          const r = Math.hypot(p[0], p[1]);
          const rb = rB(A[i]);
          const dA = Math.min(A[i] - a0, a1 - A[i]) * r;
          const dT = Math.min(T[j] - lo, hi - T[j]) * rb;
          sr.push(Math.min(1, Math.min(dA, dT) / W));
          rr.push(bi === bands.length - 2 && Math.abs(T[j] - 1.0) < 1e-9 ? 1 : 0);
        }
        seam.push(sr); rimA.push(rr);
      }

      // 高度采样：沿厚度分 NQZ 段棱，段界两侧各取一点 → 断口呈台阶状晶棱
      const ZG = [];
      const eps = 1e-3;
      for (let k = 0; k < NQZ; k++) {
        const za = CRYST_Z0 + CRYST_H * (k / NQZ) + eps;
        const zb = CRYST_Z0 + CRYST_H * ((k + 1) / NQZ) - eps;
        ZG.push(za);
        if (zb - za > 2 * eps) ZG.push(zb);
      }
      const NZ = ZG.length;

      const pos = [], sm = [], rm = [], th = [], wl = [], cu = [], ca = [], tp = [];
      let area2 = 0;
      /**
       * 按参考方向定绕向并写入顶点（保证法线朝外，否则整片背向相机、光照全反）。
       * 顶点属性：s=aSeam  r=aRim  t=aThick  w=aWall(1=断裂侧壁)  u=径向 t  az=方位/TAU
       * （u/az 供"裂缝沿轨迹渐进填充"的行进前沿用）
       */
      const pushTri = (p0, p1, p2, ref, at) => {
        const nn = crs3(sub3(p1, p0), sub3(p2, p0));
        const ord = dot3(nn, ref) >= 0 ? [[p0, at[0]], [p1, at[1]], [p2, at[2]]]
                                       : [[p0, at[0]], [p2, at[2]], [p1, at[1]]];
        for (const [p, a] of ord) {
          pos.push(p[0], p[1], p[2]);
          sm.push(a.s); rm.push(a.r); th.push(a.t);
          wl.push(a.w); cu.push(a.u); ca.push(a.az);
          tp.push(a.top || 0);      // v5.31b：1 = 顶面（前沿亮折线只画在顶面）
        }
      };
      const NREF = [n.x, n.y, n.z];

      /* —— 顶面（z=Z1，含刻面高度）—— */
      for (let i = 0; i < NA - 1; i++) {
        for (let j = 0; j < NT - 1; j++) {
          const q = (ii, jj) => ({
            p: V(A[ii], T[jj], CRYST_Z1),
            a: { s: seam[ii][jj], r: rimA[ii][jj], t: thickAt(A[ii], T[jj]),
                 w: 0, u: T[jj], az: norm(A[ii]) / TAU, top: 1 }
          });
          const c00 = q(i, j), c01 = q(i, j + 1), c11 = q(i + 1, j + 1), c10 = q(i + 1, j);
          // 平面投影面积（运动分级用）：按两个三角的真实叉积累加
          {
            const w00 = warp(A[i], T[j]), w01 = warp(A[i], T[j + 1]);
            const w11 = warp(A[i + 1], T[j + 1]), w10 = warp(A[i + 1], T[j]);
            const tri2 = (o, u, v) =>
              Math.abs((u[0] - o[0]) * (v[1] - o[1]) - (v[0] - o[0]) * (u[1] - o[1])) * 0.5;
            area2 += tri2(w00, w01, w11) + tri2(w00, w11, w10);
          }
          pushTri(c00.p, c01.p, c11.p, NREF, [c00.a, c01.a, c11.a]);
          pushTri(c00.p, c11.p, c10.p, NREF, [c00.a, c11.a, c10.a]);
        }
      }

      /* —— 底面（z=Z0，平整）—— */
      for (let i = 0; i < NA - 1; i++) {
        for (let j = 0; j < NT - 1; j++) {
          const q = (ii, jj) => ({
            p: V(A[ii], T[jj], CRYST_Z0),
            a: { s: 1.0, r: 0.0, t: thickAt(A[ii], T[jj]),
                 w: 0, u: T[jj], az: norm(A[ii]) / TAU }
          });
          const d00 = q(i, j), d01 = q(i, j + 1), d11 = q(i + 1, j + 1), d10 = q(i + 1, j);
          const nref = [-n.x, -n.y, -n.z];
          pushTri(d00.p, d01.p, d11.p, nref, [d00.a, d01.a, d11.a]);
          pushTri(d00.p, d11.p, d10.p, nref, [d00.a, d11.a, d10.a]);
        }
      }

      /* —— 4 面断裂侧壁（jag 噪声面；aSeam=0 → 裂纹发光，aRim=0，aWall=1）—— */
      const wall = (fixedA, fixedT, axis, sign, S) => {
        for (let s = 0; s < S.length - 1; s++) {
          for (let k = 0; k < NZ - 1; k++) {
            const p = (si, ki) => (fixedA === null
              ? V(S[si], fixedT, ZG[ki])
              : V(fixedA, S[si], ZG[ki]));
            const u = fixedA === null ? fixedT : S[s];
            const az = norm(fixedA === null ? S[s] : fixedA) / TAU;
            const at = { s: 0.0, r: 0.0, t: thickAt(fixedA === null ? S[s] : fixedA,
                                                    fixedA === null ? fixedT : S[s]),
                         w: 1, u, az };
            const q0 = p(s, k), q1 = p(s, k + 1), q2 = p(s + 1, k + 1), q3 = p(s + 1, k);
            const ref = edgeOut(fixedA === null ? S[s] : fixedA,
                                fixedA === null ? fixedT : S[s],
                                (ZG[k] + ZG[k + 1]) * 0.5, axis, sign);
            pushTri(q0, q1, q2, ref, [at, at, at]);
            pushTri(q0, q2, q3, ref, [at, at, at]);
          }
        }
      };
      wall(a0, null, 'a', -1, T);            // 角向裂纹 A 侧
      wall(a1, null, 'a', +1, T);            // 角向裂纹 B 侧
      if (lo > 1e-9) wall(null, lo, 't', -1, A);   // 内带下界退化为面心一点，跳过
      wall(null, hi, 't', +1, A);            // 环向裂纹 / 五边形边

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      // 非索引几何 → computeVertexNormals 给出逐三角面片法线（平直棱面，硬高光跳变）
      g.computeVertexNormals();
      g.setAttribute('aSeam', new THREE.Float32BufferAttribute(sm, 1));
      g.setAttribute('aRim', new THREE.Float32BufferAttribute(rm, 1));
      g.setAttribute('aThick', new THREE.Float32BufferAttribute(th, 1));
      g.setAttribute('aWall', new THREE.Float32BufferAttribute(wl, 1));
      g.setAttribute('aCrackU', new THREE.Float32BufferAttribute(cu, 1));
      g.setAttribute('aCrackAz', new THREE.Float32BufferAttribute(ca, 1));
      /* v5.31b：aTop = 1 只给顶面。用途：20 阈值的前沿亮折线**只画在顶面** ——
       * 原来它同时画在顶面 + 底面 + 环向侧壁（那些侧壁 aCrackU 是常数，整面墙会
       * 一次性点亮）⇒ 一条细线变成 2~3 px 宽的三层亮带 = 用户说的"笔刷痕迹"。 */
      g.setAttribute('aTop', new THREE.Float32BufferAttribute(tp, 1));
      return { geo: g, area: area2, radial: rTyp };
    };

    /* ---------- 生成本面所有片 ---------- */
    const made = [];
    let shardSeq = 0;                 // v5.11：全局分片序号 → 每片唯一的明暗种子
    for (let bi = 0; bi < bands.length - 1; bi++) {
      const B = breaks[bi];
      for (let i = 0; i < B.length; i++) {
        const a0 = B[i];
        const a1 = i === B.length - 1 ? B[0] + TAU : B[i + 1];
        const made0 = mkSolid(bi, a0, a1);
        made.push({ ...made0, band: bi, azimuth: norm((a0 + a1) * 0.5), idx: i, seq: shardSeq++,
          /* v5.31：前沿柱面要用到本片的方位/半径区间（柱面只在这段区间内存在） */
          a0, a1, lo: bands[bi], hi: bands[bi + 1] });
      }
    }
    const maxArea = Math.max(...made.map((m) => m.area));
    /* v5.13c：片到面心的距离需要**面内归一化**才是可用的分级量。
     * radial 是世界单位（本面约 0.05~0.65u），直接拿去做缓动系数只会给出 0.79~1.09
     * 的极窄带宽（用户反馈"看不出差异化"）。radialN = radial / 本面最大 → 严格 0~1
     * （0=面心片，1=外缘片），下游才能拉开到 0.55~1.45 这种肉眼可辨的档差。 */
    // min-max 归一化（而不是 /max）：本面最内圈的 radial 往往已有 ~0.15 的基数，
    // 除以 max 会让档差只用到 0.16~1.0 的一段，档差被白白吃掉一截。
    const maxRadial = Math.max(...made.map((m) => m.radial), 1e-6);
    const minRadial = Math.min(...made.map((m) => m.radial));
    const spanRadial = Math.max(maxRadial - minRadial, 1e-6);
    // 运动分级（v5.3）：绕轴旋转取消（互相遮挡穿模，用户否决）→ 只保留沿法线浮动。
    // 浮动 = 同频行波 sin(ωt − k·r)：全体共用同一 ω，相位 = −WAVE_K × 片到面中心的
    // 平均距离，相位差固定且随距离增大 → 清晰的三角函数波形向外传播。
    const WAVE_OMEGA = 0.85;
    const WAVE_K = 9.0;
    made.forEach((m, i) => {
      const sN = Math.min(1, m.area / Math.max(maxArea, 1e-6));       // 0=最小片 1=最大片
      const jit = det(faceIdx * 23.7 + i * 5.1);
      const jit2 = det(faceIdx * 61.3 + i * 17.9);
      /* v5.11：把「每片自己的明暗档」烘进几何属性。
       * 为什么必须走属性：着色器里的 vObjPos 是**片局部**坐标（几何原点在面心），
       * 基于它的噪声在全部 ~285 片上完全重复 —— 只能给片内细节，给不出片与片之间的
       * 差异；而"片与片之间有没有明暗差"正是外壳结构可读性的判据（探针 facet.cv：
       * p=0.30 时 0.253 → p=1.00 时只剩 0.087，暗面片被随能量增长的平坦加色项填平）。 */
      const nVert = m.geo.getAttribute('position').count;
      const shardSeed = det(m.seq * 12.9898 + 3.17);
      m.geo.setAttribute('aShard',
        new THREE.Float32BufferAttribute(new Float32Array(nVert).fill(shardSeed), 1));
      /* v5.31：前沿柱面几何（参数化，真实位置由顶点着色器按当前前沿复算）。
       * 与本体碎块共用同一材质 ⇒ 共享 uniforms（u_shell_form 自动同步）、
       * 共用同一个 shardSeed ⇒ 前沿折线的 seed 与片元 shellVis 完全一致。 */
      const bandGeo = buildBandGeometry(m.a0, m.a1, shardSeed);

      frags.push({
        geo: m.geo,
        faceCenter: center.clone(),
        normal: n.clone(),
        /* v5.31 前沿柱面：几何 + 本片半径区间（柱面只在这段区间内存在） */
        bandGeo,
        bandLo: m.lo,
        bandHi: m.hi,
        /* v5.31：warp / facetH 的面级常量 —— 顶点着色器要用它们复算柱面位置 */
        phi0, apo, sigA: SIG_A, sigT: SIG_T, ph, f1: phF1, f2: phF2, e1, e2,
        frontSeed,          // v5.31b：前沿折线 seed（**按面统一** —— 柱面才连续）
        band: m.band,
        idx: m.idx,
        faceIdx,
        azimuth: m.azimuth,
        area: m.area,
        radial: m.radial,
        radialN: Math.min(1, Math.max(0, (m.radial - minRadial) / spanRadial)),
        pushAmt: 0.30 - 0.14 * sN + 0.05 * jit,
        /* v5.7 外推终点：全部同时启动（d 从 0 起算），但每片的**到达时刻**不同。
         * 缓动曲线（系数）全部相同 —— 只是归一化进度 = d / arrive 不同，于是
         * "起点一致、终点错开"：轻碎屑先飞出到位，重的大板后到，不再整排同时停下。
         * arrive ∈ [0.46, 1.0]：最早到位的片在展开行程 46% 处就停稳。 */
        arrive: 0.46 + 0.54 * (0.35 * sN + 0.65 * jit2),
        rotSpeed: 0,                                   // v5.3 起恒为 0（字段保留兼容）
        floatFreq: WAVE_OMEGA,
        floatPhase: -m.radial * WAVE_K
      });
    });
  });
  return frags;
}
