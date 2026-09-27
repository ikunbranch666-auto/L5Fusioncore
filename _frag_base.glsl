
precision highp float;

uniform float u_main_param;          // 44.4 GPU Guard：着色器内必须再次 clamp
uniform float u_time;                // MasterClock.simTime
uniform float u_phase;               // CPU 侧累加的呼吸相位（附录 B.10）
uniform float u_emissive_intensity;  // E(t)
uniform vec3  u_emissive_color;      // #00F2FE ↔ #FF7700 线性插值结果
uniform float u_shell_alpha;         // 0.35 → 0.55
uniform float u_shell_id;            // 0 = 内核；1 = 规格外层硬壳；2/3 = 增强约束场
uniform float u_roughness;           // 6.1 = 0.05
uniform float u_metalness;           // 6.1 = 0.10

// —— 体积等离子核（增强 ①）——
uniform vec3  u_ray_dir_local;
uniform float u_core_radius;         // 0.80u
uniform float u_core_inradius;       // 0.80 × 0.79465447
uniform int   u_vol_steps;           // 0 = 回退到规格字面「常数自发光」
uniform float u_density;             // Beer–Lambert 吸收系数 σ

// —— 约束场 / 硬壳（增强 ②③）——
uniform vec3  u_ring_axis;
uniform float u_ring_freq;
uniform float u_ring_speed;
uniform float u_layer_gain;
uniform float u_panel_freq;          // 主面板网格频率（物体空间）
uniform float u_panel_freq2;         // 次级面板网格频率（更密、更细的线）
uniform float u_seam_px;             // 主缝半宽（像素）
uniform float u_seam2_px;            // 次缝半宽（像素）
uniform float u_hard_body;           // 硬壳暗底强度
uniform float u_face_apothem;        // 五边形面的内切半径（面局部板材用）
uniform float u_panel_mode;          // 0 = 装甲板；1 = 散热鳍格栅
uniform float u_bump;                // 板材凹凸强度（0 = 纯贴图，1 = 明显浮雕）
uniform float u_petal;               // 0 = 外壳装甲板；1 = 散热花瓣（更实心 + 多边形边缘渗光勾边）
uniform float u_core_layer;          // v5.3：1 = 裂片内芯发光层（加色叠加的第 2 层绘制）
uniform vec3  u_crystal_tint;        // v5.4：水晶本体色（与强调色做差分，便于分辨晶体/构造体）
uniform float u_deploy;              // v5.4：展开进度 0→1（驱动色差与断口亮度）
uniform float u_shell_fade;          // v-new：内壳展开后整体淡出（基准面隐藏，0=完全不可见；与 u_shell_alpha 解耦）
uniform float u_seam_form;           // v5.9：轮廓线一次性渐显进度 0→1（阈值触发，定时长）
uniform float u_crack_mul;            // v5.10：水晶加色项（轮廓线/断口）消融系数
uniform float u_pulse_gate;           // v5.11：轮廓线脉冲闸门（0.20 阈值后开 → 0.80 展开止）
uniform float u_pulse_speed;          // v5.11：脉冲循环速度（圈/秒）
uniform float u_core_gain;            // v5.11：裂片内芯加色层强度（诊断/调参）
uniform float u_body_gain;            // v5.11：裂片本体亮度档（调参/消融用）
uniform float u_seam_w;               // v5.11：轮廓环衰减跨度（越大线越粗/越铺满）
uniform float u_seam_amp;             // v5.11：轮廓线底线幅度（消融/调参）
uniform float u_wall_amp;             // v5.11：断口（断裂侧壁）反光幅度
uniform float u_burst;                // v5.12：0.80 爆发包络（0..1）
uniform float u_burst_c;              // v5.12：爆发起始位置（触发瞬间冻结的脉冲相位）
uniform float u_burst_w;              // v5.12：爆发已向两侧铺开的半宽（0.05→1.25）
uniform float u_pulse_gain;           // v5.13：循环脉冲幅度（消融/调参，默认 1）

// —— v3 显式光照预算（详见文件头注释）——
// 所有增强层都乘各自独立的预算系数，保证叠加后的 HDR 峰值落在 1.0~1.6，
// 而不是像 v2 那样堆到 ~5 被 ACES 整片压成白色。
uniform float u_plasma_gain;         // 等离子核发射总量
uniform float u_field_gain;          // 约束场总量
uniform float u_shell_gain;          // 硬壳（缝/边缘光/高光）总量

varying vec3 vNormalView;
varying vec3 vNormalWorld;
varying vec3 vObjNrm;        // 物体空间法线 = 五边形面法线
varying vec3 vTanWorld;      // 面切线（世界空间，顶点着色器里已变换）
varying vec3 vBitanWorld;
varying vec3 vViewDir;
varying vec3 vObjPos;
// v5.2 面裂片：片自身的轮廓环（由顶点着色器传来）
varying float vSeam;        // 1.0 = 片外缘(裂纹面)，0.55 = 内嵌机械刻线，0.0 = 板面本体
varying float vRim;         // 1 = 该轮廓点落在原五边形边界上（原边比内部裂纹更亮）
varying float vThick;       // v5.4：晶体板厚度（顶−底）→ 体积吸收
varying float vWall;        // v5.5：1 = 断裂侧壁（展开后才显现）
varying float vShard;       // v5.11：片级种子 → 每片自己的明暗档
varying vec2  vCrackUV;     // v5.5：裂缝轨迹坐标 (径向 u, 方位 az/2π)
const vec3 KEY_LIGHT_DIR = vec3(15.0, 20.0, 30.0); // 6.3 主键控光方向

/* —— 正十二面体 SDF：12 个面法线（已归一化） —— *
 *  three.js DodecahedronGeometry 顶点 = (±1,±1,±1) ∪ (0,±1/φ,±φ) ∪ (±1/φ,±φ,0) ∪ (±φ,0,±1/φ)。
 *  以含 (1,1,1) 的真实五边形面 {(1,1,1),(1,1,-1),(φ,0,±1/φ),(1/φ,φ,0)} 验算，
 *  其外法线 ∝ (φ,1,0) → (0.85065081, 0.52573111, 0)，其余面由对称置换给出。 */
float sdDodeca(vec3 p, float r) {
  float d = dot(p, vec3( 0.85065081,  0.52573111, 0.0));
  d = max(d, dot(p, vec3(-0.85065081,  0.52573111, 0.0)));
  d = max(d, dot(p, vec3( 0.85065081, -0.52573111, 0.0)));
  d = max(d, dot(p, vec3(-0.85065081, -0.52573111, 0.0)));
  d = max(d, dot(p, vec3( 0.0,        0.85065081,  0.52573111)));
  d = max(d, dot(p, vec3( 0.0,       -0.85065081,  0.52573111)));
  d = max(d, dot(p, vec3( 0.0,        0.85065081, -0.52573111)));
  d = max(d, dot(p, vec3( 0.0,       -0.85065081, -0.52573111)));
  d = max(d, dot(p, vec3( 0.52573111, 0.0,         0.85065081)));
  d = max(d, dot(p, vec3(-0.52573111, 0.0,         0.85065081)));
  d = max(d, dot(p, vec3( 0.52573111, 0.0,        -0.85065081)));
  d = max(d, dot(p, vec3(-0.52573111, 0.0,        -0.85065081)));
  return d - r;
}

/* —— 3D value noise + fbm（公共块 NOISE_GLSL）—— */
${NOISE_GLSL}

/* —— 面局部坐标 —— *
 * 之前的「三轴世界网格」在十二面体上只会画出横平竖直的白条和方格子：它跟五边形面
 * 毫无关系，所以既不科幻也不像机械。这里改为真正的**面内 2D 坐标**：
 *   · vObjNrm 是五边形面的法线（非索引几何 → 逐面法线，天然可用）
 *   · 面上恒有 dot(p, n) = h，故 q = p − n·dot(p,n) 就是「以面心为原点」的面内偏移
 *   · 用一组随面法线生成的正交基把 q 投成 vec2(u, v)
 * 之后所有板材都在 (u,v) 里画，自然跟随五边形。 */
vec3 faceTangent(vec3 n) {
  vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  return normalize(cross(up, n));
}

/** 正五边形 SDF（有符号距离，内部为负）；r = 内切半径(apothem) */
float sdPentagon(vec2 p, float r) {
  float a = atan(p.y, p.x);
  const float seg = 1.25663706;                 // 2π/5
  float k = floor(a / seg + 0.5);               // 最近的「边法线」方向
  return length(p) * cos(a - k * seg) - r;
}

/** 把有符号距离换算成像素再做恒定像素宽度的抗锯齿线 */
float pxLine(float d, float w) {
  float pd = abs(d) / max(fwidth(d), 1e-6);
  return 1.0 - smoothstep(0.0, w, pd);
}

float hash11(float p) { return fract(sin(p * 127.1) * 43758.5453); }

/**
 * v5.4 程序化环境（水晶/宝石专用）
 *
 * 水晶之所以是水晶，靠的是**反射了什么**，而不是表面明暗：
 * 一块真实晶体放在纯漫反射环境里就是一块灰玻璃 —— 它的"闪"全部来自环境里的
 * 高对比亮源（灯带、窗、环形灯）在棱面上的锐利成像。这里没有环境贴图，
 * 就用解析式造一个：暗底 + 顶部天光渐变 + 两条高斯灯带 + 一道水平亮环。
 * 棱面法线一转，灯带像就在棱面上扫过 → 宝石的"活光"。
 */
vec3 envProc(vec3 d) {
  float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(vec3(0.008, 0.013, 0.024), vec3(0.26, 0.38, 0.58), pow(up, 1.7));
  // 两条竖直灯带（主高光 / 副高光）：角向高斯，越靠上越强
  float az = atan(d.z, d.x);
  float bar1 = exp(-pow(sin(az * 0.5 - 0.75) * 5.5, 2.0));
  float bar2 = exp(-pow(sin(az * 0.5 + 2.05) * 8.5, 2.0));
  sky += vec3(0.95, 0.98, 1.0) * (bar1 * 0.90 + bar2 * 0.42) * smoothstep(0.02, 0.70, up);
  // 水平亮环（模拟环境里的环形灯），给侧壁断裂面一条横向反光
  sky += vec3(0.40, 0.62, 1.0) * exp(-pow((d.y - 0.10) * 6.5, 2.0)) * 0.20;
  // 底部微弱回光，避免背光面纯黑（纯黑会读成塑料）
  sky += vec3(0.03, 0.05, 0.09) * smoothstep(0.35, 0.0, up);
  return sky;
}

/**
 * 板材高度场：返回 [0,1]，1 = 缝隙（凹槽底）。
 * mode 0 = 装甲板（同心五边形板 + 辐条 + 角部铆钉），1 = 散热鳍（平行鳍片 + 稀疏系杆）
 */
float panelHeight(vec2 uv, float apo, float mode, float wpx, out float plateId) {
  float g = 0.0;
  plateId = 0.0;
  float rad = length(uv);
  float a = atan(uv.y, uv.x);
  const float seg = 1.25663706;

  if (mode < 0.5) {
    // —— 装甲板：三圈同心五边形分板 ——
    float d0 = sdPentagon(uv, apo * 0.985);
    float d1 = sdPentagon(uv, apo * 0.66);
    float d2 = sdPentagon(uv, apo * 0.30);
    g = max(max(pxLine(d0, wpx * 1.25), pxLine(d1, wpx)), pxLine(d2, wpx * 0.9));

    // —— 五条辐条（沿顶点方向，从内板延伸到边框）——
    float va = floor(a / seg + 0.5) * seg + 0.5 * seg;
    float av = abs(a - va);
    float spx = av * rad / max(fwidth(rad), 1e-6);
    float spoke = (1.0 - smoothstep(0.0, wpx * 0.9, spx)) * step(apo * 0.32, rad) * step(rad, apo * 0.97);
    g = max(g, spoke * 0.88);

    plateId = floor(a / seg + 0.5) + 5.0 * step(apo * 0.66, rad);
  } else if (mode < 1.5) {
    // —— v4.2 极简机械线框（内壳 / 花瓣）：边框 + 内圈 + 中央枢纽 + 五条角部锁扣刻线 ——
    //  之前的 22 条/面平行格栅透过外壳看就是"针织布"（用户原话）；机械质感来自
    //  少数几条果断的结构线，而不是密集纹理。
    float d0 = sdPentagon(uv, apo * 0.96);
    float d1 = sdPentagon(uv, apo * 0.60);
    float d2 = sdPentagon(uv, apo * 0.17);
    g = max(max(pxLine(d0, wpx * 1.2), pxLine(d1, wpx)), pxLine(d2, wpx * 0.9));
    // 五条角部刻线：沿顶点方向，从中央枢纽连到内圈（读作锁扣 / 螺栓位）
    float va = floor(a / seg + 0.5) * seg + 0.5 * seg;      // 五边形顶点方向
    float av = abs(a - va);
    float spx = av * rad / max(fwidth(rad), 1e-6);
    float tick = (1.0 - smoothstep(0.0, wpx * 0.9, spx))
               * step(apo * 0.17, rad) * step(rad, apo * 0.60);
    g = max(g, tick * 0.85);
    plateId = floor(a / seg + 0.5);
  } else {
    // —— mode 2 = 面裂片 ——
    //  不能沿用整面的五边形环：小片上会画出悬空的环，且那些环跟裂纹毫无关系。
    //  大尺度结构交给片自身的轮廓环（aSeam/aRim，见片元着色器裂片段），
    //  这里只留极稀疏的凹坑微纹理，让板面在特写下不是死平的塑料。
    float pits = step(0.972, hash13(vec3(floor(uv * 46.0), 0.0)));
    g = pits * 0.42;
    plateId = floor(a / seg + 0.5);
  }
  return clamp(g, 0.0, 1.0);
}

/** 由高度场求凹凸法线 —— 这是消除「2D 贴图感」的关键：板材要真的有厚度 */
vec3 panelBumped(vec3 n, vec3 t, vec3 b, vec2 uv, float apo, float mode, float strength) {
  float pid;
  float h0 = panelHeight(uv, apo, mode, 1.1, pid);
  float e = 0.035 * max(apo, 1e-3);
  float hx = panelHeight(uv + vec2(e, 0.0), apo, mode, 1.1, pid);
  float hy = panelHeight(uv + vec2(0.0, e), apo, mode, 1.1, pid);
  vec3 grad = t * (hx - h0) + b * (hy - h0);
  return normalize(n - grad * (strength / max(e, 1e-6)) * 0.05);
}

void main() {
  // —— 第三层钳制（GPU Guard，44.4）——
  float safeParam = clamp(u_main_param, 0.0, 1.0);

  // —— 统一的「压缩能量响应」——
  // E(t) 与 MainParam 若被各层线性跟随，整帧亮度会从 IDLE 到 OVERDRIVE 涨 ~3 倍，
  // 直接把画面推进 ACES 的压平区（实测核心 cv 从 0.135 掉到 0.017，湍流整片消失）。
  // 这里对两者做严格单调但压缩的映射，把能量差额交给「辐射外溢 / 粒子 / 湍流频率 /
  // 色相」这些不占用核心动态范围的通道去表达。63.2 的明度呼吸映射依然成立。
  float eN = clamp(u_emissive_intensity / 3.5, 0.0, 1.0);
  float eC = 0.60 + 0.75 * pow(eN, 0.55);          // ≈1.04 (IDLE) → 1.35 (过载)
  float pC = 0.55 + 0.45 * pow(safeParam, 0.70);   // ≈0.55 (IDLE) → 1.00 (过载)

  // DoubleSide 材质的背面法线背向相机，必须翻转（否则背面整面按最大菲涅尔发光）
  vec3 nView = normalize(vNormalView);
  if (!gl_FrontFacing) nView = -nView;
  float facing = clamp(dot(nView, normalize(vViewDir)), 0.0, 1.0);

  float lambert = max(dot(normalize(vNormalWorld), normalize(KEY_LIGHT_DIR)), 0.0);
  float specP = pow(lambert, mix(40.0, 6.0, u_roughness)) * (0.15 + u_metalness);

  /* ==================== 硬壳 / 散热花瓣（增强 ③・v4 面局部板材） ==================== */
  if (u_shell_id > 0.5 && u_shell_id < 1.5) {
    /* —— v5.3 内芯发光层（多层绘制的第 2 层，先于本体材质提前返回）——
     * 同一裂片几何、相对面心缩放 0.86、加色叠加：只输出"晶体体内封着的能量核"。
     * fbm 云团 + 面内径向衰减 + 慢呼吸；能量越高越亮。加色层不吃凹凸/裂缝细节，
     * 那些是本体层的职责 —— 两层叠加才有"晶体里透出光"的纵深。 */
    if (u_core_layer > 0.5) {
      vec3 np2 = vObjPos * 4.3 + vec3(u_time * 0.11, -u_time * 0.17, u_time * 0.07);
      float neb2 = smoothstep(0.18, 0.92, fbm3(np2));
      float rad2 = length(vObjPos);
      float fall = smoothstep(u_face_apothem * 1.10, 0.0, rad2);
      float breathe = 0.72 + 0.28 * sin(u_time * 1.7 - rad2 * 7.0);
      // v5.6：内芯以能量色为主（同源融合），只掺入少量水晶矿物色做材质区分
      vec3 coreCol = mix(u_emissive_color, u_crystal_tint, 0.40 * u_deploy);
      vec3 cCore = coreCol * (0.10 + 0.85 * neb2) * breathe
                 * (0.30 + 0.70 * pC) * (0.35 + 0.65 * eN)
                 * (0.40 + 0.60 * fall);
      // 断裂侧壁与本体层同步：闭合态隐藏（否则加色侧壁会在裂缝处印出亮线）
      float wallVisC = smoothstep(0.02, 0.30, u_deploy);
      float aC = 0.85 * mix(1.0, wallVisC, vWall);
      gl_FragColor = vec4(cCore * u_core_gain * mix(1.0, wallVisC, vWall), aC);
      return;
    }

    /* —— v5.4 水晶（宝石）光学模型：裂片专属，走完就返回，不再吃板材路径 ——
     * 旧做法（v5.3）是"沿法线浮雕 + 漫反射明暗" → 用户判定为木雕，因为它只是表面凹凸。
     * 这里改为真实晶体该有的四件事：
     *  ① 棱面法线（逐三角面片真实法线，硬边不平滑）→ 灯带像在棱面上锐利跳变；
     *  ② 程序化环境反射（envProc）+ 菲涅尔 → 边缘反射强、正面透射强；
     *  ③ 色散：R/G/B 三档折射率分别折射 → 断口与边缘出现彩色分离（宝石的彩火）；
     *  ④ Beer–Lambert 体积吸收：透射部分按"光在体内走的路程"指数衰减 →
     *     厚处更深更饱和，这是"有体积的晶体"和"贴图薄片"的分水岭。
     */
    if (u_petal > 0.5) {
      vec3 N = normalize(vNormalWorld);
      if (!gl_FrontFacing) N = -N;
      vec3 Vd = normalize(vViewDir);
      float ndv = clamp(dot(N, Vd), 0.0, 1.0);
      float fres = 0.05 + 0.95 * pow(1.0 - ndv, 4.0);

      // ① 表面反射（环境灯带在棱面上的锐利成像）
      vec3 R = reflect(-Vd, N);
      // v5.11：环境反射整体降一档 —— 两条灯带的白是外壳发白成片的主要来源
      vec3 envR = envProc(R) * 0.76;

      // ② 折射进入晶体 + 在底面反弹一次后出射（宝石的"内部火"）
      float ior = 1.62;
      vec3 dR = refract(-Vd, N, 1.0 / (ior - 0.022));
      vec3 dG = refract(-Vd, N, 1.0 / ior);
      vec3 dB = refract(-Vd, N, 1.0 / (ior + 0.022));
      vec3 backN = -N;                                  // 底面近似（板底平整）
      vec3 oR = refract(reflect(dR, backN), N, ior - 0.022);
      vec3 oG = refract(reflect(dG, backN), N, ior);
      vec3 oB = refract(reflect(dB, backN), N, ior + 0.022);
      // 全内反射时 refract 返回 0 → 退回反射方向，避免出现黑块
      if (dot(oG, oG) < 1e-6) { oR = reflect(dR, backN); oG = reflect(dG, backN); oB = reflect(dB, backN); }
      vec3 envT = vec3(envProc(oR).r, envProc(oG).g, envProc(oB).b);

      // ③ Beer–Lambert：路程 = 厚度 / cos(入射角)，逐通道吸收系数不同 → 出彩色
      float path = vThick / max(0.32, ndv);
      // v5.6：吸收改"轻微偏冷"（略吸红）而不是强吸红绿 —— 后者会把晶体染成紫，
      // 与橙色构造体互补撞色。现在透射只是"略偏冷的白"，色相留给能量色去染。
      // v5.11：吸收加强（2.6→4.2）并叠加低频包裹体噪声 —— 薄片也能读出厚薄与杂质，
      // 否则薄棱片的透射几乎处处相同 → 一整片没有结构的亮面。
      vec3 sigma = vec3(1.55, 1.30, 1.05) * 4.2 * (0.72 + 0.62 * fbm3(vObjPos * 7.3 + 11.0));
      vec3 absorb = exp(-sigma * path);
      vec3 tint = mix(u_emissive_color, u_crystal_tint, u_deploy);
      // 体内透射/散射用**能量色**主导（v5.6 融合关键）：水晶不是自带颜色的物体，
      // 而是"被这台机器的能量照亮并透射出来的介质" → 与构造体同源。
      vec3 innerCol = mix(u_emissive_color, tint, 0.35);

      vec3 c = mix(envT * absorb * (0.55 + 0.45 * tint), envR, fres);
      // 晶体自身的色相：随展开度从"环境色"偏向"水晶色"（低饱和矿物色，不撞色）
      c *= mix(vec3(1.0), tint * 1.06 + 0.14, 0.32 * u_deploy);

      /* v5.11：主光 —— 此前水晶**只有**环境反射 + 体吸收，没有任何直接光项，
       * 亮度几乎只随 fresnel 缓慢起伏 → 整壳大面积同亮度（探针 facet.cv 仅 0.07，
       * p10/p90 挤在 0.67/0.79，即用户说的"一片白、看不清结构"）。
       * 加一盏世界空间固定的斜上方主光：12 个五边形面法线不同 → 面与面拉开明暗；
       * 面内刻面（computeVertexNormals 的逐三角法线）再细分 → 水晶棱面硬跳变。
       * 为什么用**乘法**而不是再加一项：加法只会再垫一层底（v5.10 已经证明垫底
       * 正是把暗部填平的元凶）；直接光必须拉开层次。
       * 为什么能穿透多层合成：沿视线重叠的片法线不同、且最前片 alpha 权重最高，
       * 主光因此保留；而纯随机的片级种子会被 N 层合成按 1/√N 平均掉（实测无效）。 */
      vec3 Lw = normalize(vec3(0.42, 0.86, 0.34));
      float key = clamp(dot(N, Lw), 0.0, 1.0);
      c *= 0.26 + 0.74 * pow(key, 1.25);

      /* v5.11：片级明暗档 —— 每片自己的解理/包裹体浓度不同 → 相邻片不同亮度。
       * 这是"外壳读不读得出结构"的直接来源：vObjPos 是**片局部**坐标，基于它的噪声
       * 在 ~285 片上完全重复，只有片内细节；片与片之间必须有差异才成结构。
       * 实测依据（探针 facet.cv）：p=0.30 时片间离散 0.253 → p=1.00 只剩 0.087，
       * 暗面片（p10）从 0.377 被抬到 0.697，整壳挤进 0.70~0.79 这一档
       * —— 用户："外壳还是过亮成一片白色，根本看不清结构"。
       * 幅度随能量**增大**（越高能越戏剧），但均值恒为 1 → 只拉开层次、不整体抬亮。
       * step(0.5, u_petal)：只有裂片档（u_petal=1）吃，内壳 0.35 / 等离子核 0 不受影响。 */
      float shardSeed = fract(sin(vShard * 127.1 + 11.7) * 43758.5453);
      float facetGain = mix(1.0,
        1.0 + (0.24 + 0.34 * pC) * (shardSeed * 2.0 - 1.0), step(0.5, u_petal));
      c *= facetGain;

      /* 体内能量（内芯层之外的第二次体内散射）
       * v5.11：这一项正是"填平元凶" —— 薄片 absorb≈1、正面 (1-fres)≈0.95，故它几乎
       * 处处同值、随 pC 线性增长，把暗面片一路抬到亮面片的水平。乘上 facetGain 之后
       * 它跟着片级明暗一起起伏：不再填平，而是把已有的层次**放大**。 */
      c += innerCol * (0.02 + 0.045 * pC) * (0.35 + 0.65 * eN) * (1.0 - fres) * absorb * facetGain;
      /* v5.11：本体整体降档（0.82 → 0.72 × u_body_gain）—— 亮度余量让给轮廓线 /
       * 脉冲 / 断口，那几项才是要被看见的结构。
       * 关键在于这是**预乘 alpha 混合**：dst = c + dst·(1−alpha)。c 压低而 alpha 不变
       * → 片体从"发亮的薄纱"变成"能遮挡的暗玻璃"，背后的等离子核不再透上来把整壳
       * 顶成一片白；壳体退到中低亮度，刻线/脉冲才有对比空间。 */
      c *= 0.72 * u_body_gain;

      /* —— 分割线（v5.9 修订：阈值后**一次性**渐显，随后亮度呼吸）——
       * v5.5 的做法是"填充前沿随能量 20→80 持续推进"—— 轮廓线的亮度因此一直挂在
       * 能量上，越推越亮，没有"出现"这个事件。用户修订：
       *   ① 能量越过阈值（0.20）→ 触发**一次性**的渐显：前沿沿同一条轨迹推进，
       *      但推进速率是**固定时长**（u_seam_form 由 CPU 按 1/时长 推进），
       *      与能量爬升快慢无关 —— 到点就出现，不再随能量继续增长；
       *   ② 填满之后前沿亮头消失，整条轮廓转为**亮度呼吸**（按方位/径向错相的慢正弦）。
       * 轨迹坐标 s = 面内径向（0=面心 → 1=外缘）+ 方位正弦摆动（连续，无接缝）。 */
      float sTraj = clamp(vCrackUV.x + 0.10 * sin(6.28318 * vCrackUV.y + 1.7), 0.0, 1.0);
      float front = u_seam_form;                                    // 一次性填充前沿 0→1
      float filled = 1.0 - smoothstep(front - 0.02, front + 0.14, sTraj);
      // 前沿亮头：填满后（front→1）自行消失，否则会在外缘留一圈常亮头
      float head = exp(-pow((sTraj - front) / 0.07, 2.0)) * (1.0 - smoothstep(0.86, 1.0, front));
      float appear = smoothstep(0.0, 0.10, u_seam_form);            // 阈值前总闸：全灭
      /* v5.11：明暗呼吸不明显（用户判定）→ 删掉呼吸，改为**亮色脉冲自面心沿轮廓线
       * 向外循环扩散**。不对称核：前沿陡、尾迹长 → 读作能量正沿裂纹往外走，
       * 而不是整条线一起闪。u_pulse_gate：阈值后启用，能量到 0.80（展开）为止。 */
      /* v5.12（用户定标）：脉冲**从五边形面心沿轮廓线向外延伸**，且
       *   ① 高亮环宽**最多 0.1 半径** —— 对称窄高斯 σ=0.035：显著区（>0.25 峰值）
       *      为 |Δu| < 0.0487 → 环宽 ≈0.097 半径，正好压在 0.1 以内；
       *   ② **亮度不能高** —— 亮到盖住轮廓线本身就本末倒置了（用户的原话：完全无法
       *      仔细观察）。故：去掉外缘 vRim 的 1.45× 加成（那正是脉冲推进到五边形
       *      边界时"12 面所有轮廓一起闪一下"的来源），幅度从 2.60 降到 0.95。
       * 尾迹只留很短的一截（0.18 权重、0.045 衰减）用来指示传播方向。 */
      float ph = fract(u_time * u_pulse_speed);
      /* v5.13b：脉冲改用**无摆动的纯径向坐标**（sRad），sTraj 的 ±0.10 方位摆动只留给
       * 渐显前沿。差分实测（tk_pulse on/off @p=0.703）：用 sTraj 时环带被摆动撕成
       * 0.20+ 半径宽 —— 裂片轮廓网本来就密，环带一宽就盖掉小半张面，读作"整个面
       * 变亮"（litP50 +0.023、hot +46%）。换纯径向后环宽回到 ≈0.07 半径。 */
      float sRad = clamp(vCrackUV.x, 0.0, 1.0);
      float dU = sRad - ph;
      float ahead = exp(-pow(dU / 0.035, 2.0));           // 对称窄高斯 → 环宽≈0.1 半径
      float trail = exp(-max(-dU, 0.0) / 0.045) * 0.18;   // 很短的方向尾迹
      /* v5.13：行进包络 —— 起步淡入、**在抵达外缘之前耗散**。
       * 十二个面的轮廓线终点在几何上重合（sTraj=1 都落在五边形边界上），脉冲一旦推进
       * 到边界，12 个面的边界就在同一帧被同时点亮 —— 这正是"脉冲结束之后所有轮廓线
       * 又同时变亮"的来源；且 sTraj 带 ±0.10 方位摆动，边界处的 sTraj 最早可到 0.90，
       * 故包络必须在 ph≈0.88 之前归零，从根上不接触边界。
       * 于是整个循环变成：面心的小亮点自然长出 → 向外铺开 → 抵达边界前耗散 → 面心
       * 重新长出。没有"同时变亮/同时熄灭"的集体事件，循环不再突兀。 */
      float pulse = (ahead + trail)
        * smoothstep(0.0, 0.05, ph)                      // 起步淡入
        * (1.0 - smoothstep(0.62, 0.88, ph));            // 抵达边界前耗散
      // 脉冲色设计：峰 = 能量色向矿物白提亮（mix 到白 0.55，再掺 30% 水晶矿物色），
      // 尾随段自然落回能量色 → 亮头有实体感、又不脱离同源色族。
      vec3 pulseCol = mix(mix(u_emissive_color, vec3(1.0), 0.55), u_crystal_tint, 0.30);
      /* v5.12：0.80 触发的**轮廓线爆发**（蓄势）。
       * 不管此刻脉冲跑到哪儿，都从它当前的位置**向两侧同时延伸**（u_burst_w 由 CPU
       * 从 0.05 推到 1.25）直到铺满整个五边形面的全部轮廓线 → 高亮一下 → 变暗
       * → 之后才开始展开。这是用户指定的展开起手式：先整体点亮宣示，再让碎块飞出。
       * u_burst_c 是触发瞬间冻结的脉冲相位（保证"从哪里开始铺"连续，不会跳）。 */
      float bInst = u_burst
        * (1.0 - smoothstep(u_burst_w - 0.14, u_burst_w, abs(sTraj - u_burst_c)));
      /* v5.11：轮廓环衰减跨度参数化（0.85 → u_seam_w，默认 0.40）。
       * 注：宽度扫参（0.85/0.40/0.28）证明跨度本身不是杠杆 —— 中位数几乎不动，
       * 因为片体内部的 vSeam 早已饱和为 1。真正的杠杆在下面：断裂侧壁被排除。 */
      float seamEdge = 1.0 - smoothstep(0.0, u_seam_w, vSeam);
      /* v5.11：**断裂侧壁不参与轮廓线**。侧壁顶点的 aSeam 恒为 0（线心值）—— 本意是
       * "裂纹面发光"（v5.5），但 p≥0.8 后 285 片被推开、大量断裂面朝向镜头，侧壁便
       * 以**线心满档亮度**成片出现：轮廓线从一条细线退化成覆盖全部断裂面的填充色。
       * 消融实测（tk_crack=0）：壳带亮部中位数 0.69→0.58、面片级 cv 0.09→0.15、
       * hotFrac 0.06→0.016 —— 这正是"外壳糊成一片白"的主因。
       * 侧壁的照明交给下面专属的断口项（受 u_wall_amp 控制，可单独调）。 */
      seamEdge *= 1.0 - vWall;
      /* v5.11：轮廓沟槽 —— 刻线两侧的本体先压暗一档。
       * 亮线是**加**在本体上的：本体已经很亮时再往上加，等于没加（"轮廓看不清"的
       * 成因之一）。先刻出暗槽，亮线才读作"刻进晶体里的光"，而不是浮在表面的一片白。
       * 核取 seamEdge≈0.6（线旁一圈，不含线心）→ 只压暗线的两侧，不削弱线本身。 */
      float groove = pow(seamEdge, 0.8) * (1.0 - pow(seamEdge, 2.0));
      c *= 1.0 - 0.42 * groove * appear;
      /* v5.11：底线再收一档（0.62+0.26·pC → 0.26+0.09·pC，约剩 45%）。
       * 依据：宽度扫参证明轮廓环的宽度不是杠杆（0.85→0.28 中位数只动 0.009）
       * —— 片被碎成 ~285 片后，大部分片体面积本就落在 vSeam 的小值区间里，
       * 也就是说"轮廓环"实际等于铺满整片，它已经从一条线退化成了一种填充。
       * 既然它是事实上的本体色，就只能按本体的预算来给。省下来的亮度全部让给脉冲。 */
      /* ① 底线（常驻）—— v5.13：vRim 落差从 0.55~1.45 压到 0.92~1.12。
       *    之前内裂纹线（vRim=0）比五边形边界（vRim=1）暗 2.6 倍 —— 这就是用户看到的
       *    "脉冲环内部的线明显比外部暗很多"：环内是内裂纹线、环外靠近边界线，静态落差
       *    被误读成脉冲造成的。落差压平后，"轮廓线显现的亮度"在整面上才是同一个值，
       *    脉冲经过前/经过后的线亮度也就一致了（不会再读出"变回暗状态"）。 */
      c += mix(u_emissive_color, tint, 0.30 * u_deploy)
         * pow(seamEdge, 2.2) * mix(0.92, 1.12, vRim)
         * (0.26 + 0.09 * pC) * (0.65 + 0.35 * lambert) * appear
         * u_crack_mul * u_seam_amp
         * (filled * 0.95 + head * 1.5)
         /* ② 循环脉冲 —— v5.12：幅度 2.60→0.95，且**取消 vRim 加成**。
          *    原先 mix(0.55,1.45,vRim) 使脉冲推进到五边形外缘时被放大 1.45 倍，
          *    而 XII 个面的外缘是同时到达的 → 整条线框"闪一下"（用户明确指出的问题）。 */
         /* 幅度 0.95→0.60：配合纯径向坐标把环真正收窄之后，脉冲不该再靠"量"取胜。
          * 用户定标是"亮度不能高，不然完全遮挡轮廓线" —— 它应当只是**轮廓线上多出的
          * 一段微亮**，而不是把刻线整体提亮一档。 */
         + pulseCol * pow(seamEdge, 1.8) * mix(0.90, 1.0, vRim) * pulse * 0.60 * u_pulse_gain * u_pulse_gate
         /* ③ 0.80 爆发 —— 铺满全部轮廓线后的整体高亮。同样受"不能盖住轮廓线"约束，
          *    幅度与循环脉冲同量级，靠**覆盖面积**而不是单点亮度来读作事件。 */
         + pulseCol * pow(seamEdge, 1.8) * mix(0.75, 1.0, vRim) * bInst * 1.05;
      // 断口（断裂侧壁）在展开后要有自己的反光，否则侧面一片死黑；
      // v5.6：反光荣用**能量色**一半 —— 断口被机器自身的光照亮 → 把水晶缝进场景。
      c += mix(vec3(0.85, 0.92, 1.0), u_emissive_color, 0.5)
         * pow(1.0 - ndv, 3.0) * 0.15 * u_deploy * u_crack_mul * u_wall_amp;
      // v5.6 融合项：轮廓边光用能量色 —— 经典"边缘光把物体缝进环境"手法。
      // 强度压在"染色"而不是"发光"档：过强会把水晶和构造体一起冲进白区（实测翻车）。
      c += u_emissive_color * pow(1.0 - ndv, 3.5) * (0.06 + 0.13 * pC) * (0.40 + 0.25 * u_deploy);
      // 轻微星云气流（保留 v5.2 需求，强度压低 —— 主体交给光学）
      vec3 np = vObjPos * 3.1 + vec3(u_time * 0.08, -u_time * 0.13, u_time * 0.05);
      float neb = smoothstep(0.30, 0.88, fbm3(np));
      c += innerCol * neb * (0.02 + 0.05 * pC) * (0.35 + 0.65 * eN) * facetGain;

      float alpha = clamp(0.42 + 0.30 * fres + 0.18 * u_deploy, 0.0, 0.92);
      /* —— 断裂侧壁的显现门控（v5.5，消除低能态暗轮廓线）——
       * 闭合态相邻片的侧壁严丝合缝地对贴在一起，双面叠加会在每条裂缝处
       * 印出一道暗/亮描边（用户圈出的"低能态暗轮廓线"）。侧壁只在展开后
       * 才有意义（那时它就是碎片的断裂面），因此随 u_deploy 淡入。 */
      float wallVis = smoothstep(0.02, 0.30, u_deploy);
      c *= mix(1.0, wallVis, vWall);
      alpha *= mix(1.0, wallVis, vWall);
      gl_FragColor = vec4(c, alpha);
      return;
    }

    vec3 nObj = normalize(vObjNrm);
    if (!gl_FrontFacing) nObj = -nObj;
    vec3 tObj = faceTangent(nObj);
    vec3 bObj = cross(nObj, tObj);

    // 面内 2D 坐标（以五边形面心为原点）
    vec3 q = vObjPos - nObj * dot(vObjPos, nObj);
    vec2 fuv = vec2(dot(q, tObj), dot(q, bObj));

    float pid;
    // 主缝宽按模式区分：装甲板缝要读得出来（太细会被 bloom 吃掉），散热格栅细一些
    float seamW = mix(2.10, 1.45, u_panel_mode);
    float groove = panelHeight(fuv, u_face_apothem, u_panel_mode, seamW, pid);
    float grooveWide = panelHeight(fuv, u_face_apothem, u_panel_mode, seamW + 1.5, pid);
    float bevel = clamp(grooveWide - groove, 0.0, 1.0);      // 凹槽外沿的倒角亮边
    // 每块板给一点随机色差 —— 一整片完全均匀的板看起来就是塑料
    float plateVar = 0.88 + 0.24 * hash11(pid * 1.37 + 3.1);

    // 凹凸法线：让板材在光照下真的"立起来"。
    //  modelMatrix 在片元里不可用（v4 曾因此整段 shader 编译失败、壳面整体消失），
    //  改为把切线基在顶点着色器变换到世界空间带下来，片元里直接拼装凹凸法线。
    vec3 pnObj = panelBumped(nObj, tObj, bObj, fuv, u_face_apothem, u_panel_mode, u_bump);
    // pnObj = nObj + tObj*dhdu + bObj*dhdv（已归一）→ 世界空间同构拼装
    vec3 dObj = pnObj - nObj;
    vec3 nW = normalize(vNormalWorld
        + vTanWorld * dot(dObj, tObj)
        + vBitanWorld * dot(dObj, bObj));
    float lambert = max(dot(nW, normalize(KEY_LIGHT_DIR)), 0.0);

    float rim = pow(1.0 - facing, 2.0);
    vec3 H = normalize(normalize(KEY_LIGHT_DIR) + vViewDir);
    float spec = pow(max(dot(nW, H), 0.0), 44.0);

    // 暗底：板材本体（受板材色差调制）
    float rad = length(fuv);          // 面内径向坐标（能量脉冲沿缝传播用）
    vec3 body = mix(vec3(0.012, 0.028, 0.048), u_emissive_color * 0.26, lambert) * plateVar;

    // v4.1 修正：面朝相机时 alpha 只剩 ~0.06，板材完全读不出来（实测截图证实）。
    // 预乘混合下 alpha 是真正的"遮挡力"——底面必须给到 0.30~0.50，凹槽给到 ~0.9，
    // 板缝才能在亮核前面读成"真的缝"，而不是一条若有若无的暗纹。
    // v5：花瓣档（u_petal=1）再抬一档实心度——展开态的折返装甲板若透光，
    // 近侧向视角就会读成"细长透光薄片"（用户圈出的问题之一）。
    float alpha = clamp((u_shell_alpha + 0.24 * u_petal) * (0.85 + 0.15 * rim)
                      + groove * mix(0.38, 0.52, u_petal), 0.0, 0.97);
    float lit = 1.0 - groove;

    vec3 c = body * u_hard_body * (1.0 - 0.60 * groove);
    // 能量透照：板体带一点自发光，让板材从黑背景里浮出来（叠加项不吃 alpha）
    c += u_emissive_color * (0.05 + 0.07 * pC) * (0.40 + 0.60 * lambert)
       * (1.0 - 0.70 * groove) * u_shell_gain * plateVar;
    // —— v4.1 核心：板缝的「能量渗光」——
    // 缝不应该是黑的：能量从缝里漏出来，五边形缝以亮线勾勒板面，这才是
    // 高端科幻的读法（v3 的白条突兀，是因为它们不跟随几何；现在缝天然贴合五边形）。
    // 沿缝再叠一个慢速能量脉冲，静帧也能读出"活"的感觉。
    float pulse = 0.78 + 0.30 * sin(u_time * 2.1 - rad * 6.5 + pid * 2.3);
    c += u_emissive_color * groove * (0.30 + 0.80 * pC) * pulse
       * (0.55 + 0.45 * lambert) * (0.65 + 0.35 * plateVar);
    // 倒角高光（沿槽沿，随主光方向），这是"金属板材"读感的主要来源
    c += (u_emissive_color * 0.55 + vec3(0.16)) * bevel * u_shell_gain
       * (0.35 + 0.65 * lambert) * (0.30 + 0.55 * pC);
    // v5：花瓣多边形边缘渗光勾边（边缘亮、面略暗 = 金属舱门）。
    // 勾边贴着花瓣几何的真实五边形边界（sdPentagon 以面内切半径求距），
    // 花瓣档全亮；外壳档保留微弱一圈与棱线呼应。
    c += u_emissive_color * pxLine(sdPentagon(fuv, u_face_apothem * 0.985), 2.3)
       * mix(0.28, 1.00, u_petal) * (0.45 + 0.55 * pC) * (0.55 + 0.45 * lambert);

    /* —— v5.2 裂片专属：结构线贴合「片自身的形状」 ——
     * 片外缘（aSeam→1）即裂纹面：能量从裂缝里漏出；其中落在原五边形边界上的
     * （aRim=1）更亮 —— 读作"面框还在"，而内部裂纹只是渗光。
     * aSeam≈0.55 的内嵌环给一道沿片轮廓走的机械刻线，随片形状变化。 */
    if (u_petal > 0.5) {
      // vSeam = 到本片轮廓的距离 / 带宽 W：轮廓（裂纹面）上为 0，≥W 处为 1
      float seamEdge = 1.0 - smoothstep(0.0, 0.85, vSeam);
      // 落在原五边形边界上的（aRim=1）更亮 —— 读作"面框还在"，内部裂纹只是渗光
      c += u_emissive_color * pow(seamEdge, 1.6) * mix(0.65, 1.55, vRim)
         * (0.45 + 0.55 * pC) * (0.40 + 0.60 * lambert);
      // —— 轻微星云状气流涌动（用户要求：结构片上有气流，起伏随能量）——
      //  物体空间 fbm：片几何原点在面心，vObjPos 不随 mesh 平移/旋转变化 → 气流"贴着片走"；
      //  三轴不同速度的时间漂移让云团缓慢翻涌，而不是整片同步呼吸。
      vec3 np = vObjPos * 3.1 + vec3(u_time * 0.08, -u_time * 0.13, u_time * 0.05);
      float neb = smoothstep(0.30, 0.88, fbm3(np));
      c += u_emissive_color * neb * (0.05 + 0.12 * pC) * (0.35 + 0.65 * eN)
         * (1.0 - 0.55 * groove);
    }

    c += u_emissive_color * rim * u_shell_gain * (0.20 + 0.50 * pC) * lit;
    c += vec3(1.0) * spec * u_shell_gain * (0.14 + 0.36 * pC) * lit;

    // v-new：内壳展开淡出 —— premultiplied(OneFactor) 混合下，alpha 缩小不会门控颜色，
    // 必须显式用 u_shell_fade 乘掉 c 与 alpha，基准面才会在 _deploy>0.55 后真正不可见。
    c *= u_shell_fade;
    alpha *= u_shell_fade;
    gl_FragColor = vec4(c, alpha);
    return;
  }

  /* ==================== 约束场（v5.1） ==================== *
   * 场不再用共享着色器渲染：球膜几何（无论多面体还是平滑球）都会在轮廓处
   * 产生一个"完美圆形"的菲涅尔边缘环，且菲涅尔只依赖视角、自转不可见，
   * 必然读作"静止同心圆"。v5.1 起改为面向相机的辉光板 L5_FieldGlow
   * （FIELD_GLOW_VERT/FRAG，环形软剖面 + 旋转亮度瓣），在构造器/sync 里单独驱动。 */

  /* ==================== 内层：体积等离子核（增强 ①） ==================== */
  vec3 plasma;

  if (u_vol_steps > 0) {
    vec3 rd = normalize(u_ray_dir_local);
    float rIn = u_core_inradius;
    float stepLen = (2.0 * u_core_radius) / float(u_vol_steps);
    float t = stepLen * 0.5;
    vec3 acc = vec3(0.0);
    float trans = 1.0;

    for (int i = 0; i < 48; i++) {
      if (i >= u_vol_steps) break;
      vec3 q = vObjPos + rd * t;
      float sd = sdDodeca(q, rIn);
      if (sd > 0.0) break;

      float depth = clamp(-sd / rIn, 0.0, 1.0);               // 0 表面 → 1 中心
      float freq = 5.0 + 6.0 * safeParam;                     // 过载：湍流更细
      vec3 sp = q * freq + vec3(0.0, -u_time * (0.55 + 1.10 * safeParam), u_time * 0.30);
      float n = fbm3(sp);
      float fil = 1.0 - abs(n * 2.0 - 1.0);                   // ridged → 丝状
      fil = pow(clamp(fil, 0.0, 1.0), 2.0);

      float shellFall = 0.30 + 0.70 * smoothstep(0.0, 0.30, depth);
      // —— 密度场：低底噪 + 强丝状 → 让丝之间存在真正的暗区 ——
      // v2 的 (0.30 + 1.60*fil) 底噪太高，暗区也会沿途累积发光，把动态范围压没。
      float dens = (0.10 + 2.70 * fil) * shellFall * (0.55 + 0.75 * depth);
      float a = 1.0 - exp(-u_density * dens * stepLen);       // Beer–Lambert 单步吸收率

      float temp = pow(depth, 1.15);                          // 温度梯度：中心更热
      // 明度的「压缩映射」（关键修正）：E(t) 在 IDLE→OVERDRIVE 之间近乎 3 倍线性增长，
      // 若让发射强度线性跟随，过载态整体会被推进 ACES 的压平区 —— 实测 cv 从
      // IDLE 的 0.135 掉到 OVERDRIVE 的 0.017，即「湍流消失」。这里改为严格单调但
      // 压缩的响应（约 1.0 → 1.35），把能量差额交给「核心亮度」之外的通道表达：
      // 辐射外溢 / 粒子 / 湍流频率 / 色相偏移。63.2 的「明度随 E(t) 呼吸」依然成立。
      float eN = clamp(u_emissive_intensity / 3.5, 0.0, 1.0);
      float eGain = 0.60 + 0.75 * pow(eN, 0.55);
      vec3 emit = u_emissive_color * eGain
                * (0.45 + 1.55 * fil) * (0.70 + 1.00 * temp) * 0.34;
      emit += vec3(1.0) * eGain * 0.07 * fil * temp * temp;  // 白热丝（有节制；v5.7 再降一档防过曝）

      acc += trans * emit * a;                                // 前到后累积
      trans *= 1.0 - a;
      t += stepLen;
      if (trans < 0.02) break;                                // 已不透光，提前退出
    }
    plasma = acc * u_plasma_gain;
  } else {
    plasma = u_emissive_color * u_emissive_intensity * (0.70 + 0.30 * lambert);
  }

  float rim = pow(1.0 - facing, 2.0);
  // 同样走压缩映射，否则过载态的轮廓光会单独把核心边缘推到白点
  float eGainCore = 0.60 + 0.75 * pow(clamp(u_emissive_intensity / 3.5, 0.0, 1.0), 0.55);
  vec3 c = plasma;
  c += u_emissive_color * eGainCore * rim * 0.55 * u_plasma_gain;
  c += vec3(1.0) * specP * eGainCore * 0.08 * u_plasma_gain;
  gl_FragColor = vec4(c, 1.0);
}
