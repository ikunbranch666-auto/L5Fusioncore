/**
 * L5 动力聚变核心 —— 几何与 Prog_HDRCore 着色器
 * 来源：L5 实施说明书 §1（几何）/ §2（材质）/ §7.2 uniform 表 / 附录 B.7
 *
 * 几何（§1.1 / 附录 B.7 / 5.6.1）：
 *  - 内层：固态发光核心，正十二面体，R_core = 0.8u
 *  - 外层：悬浮半透明电磁约束框，外接半径 1.0u，壁厚 0.04u，径向间距 0.20u
 *  - 内外层共用 Prog_HDRCore（57.1：全场景 Shader Program ≤ 5），以 u_shell_id 分支区分
 *
 * ── 视觉增强层 v2（非规格项，见《L5_视觉增强调研报告》§4；可由 stage.setFx(false) 一键回退）──
 *
 * 【v1 的失败与 v2 的修正 —— 逐条对应"为什么之前看不见"】
 *  ① 湍流被平均抹平：v1 用 total/count 沿弦求均值 → 方差衰减 √N≈5.7 倍。
 *     v2 改为**前到后发射-吸收（Beer–Lambert）体积积分**：
 *     acc += T·emit·a; T *= (1-a); a = 1-exp(-σ·ρ·ds)。
 *     近端高密度丝状结构会遮挡其后的一切 → 湍流方差完整保留。
 *  ② 约束壳看不见：v1 用 pow(1-facing, 3.4/5.0) → 面上几乎处处为 0。
 *     v2 改为**低指数宽边缘光** pow(1-facing, 1.5) + 常数底亮 + 移动干涉条纹。
 *  ③ 硬壳无机械感：v1 外壳是纯加色发光，叠在已很亮的核心上被 ACES 压平。
 *     v2 外壳改为**暗色半透明硬壳 + 预乘混合**：暗底着色 + Blinn 镜面高光
 *     + 三轴程序化面板缝（导数抗锯齿，bgolus pristine-grid 思路）+ 宽边缘光。
 *     面板缝 / 边缘光 / 高光以"发光"形式直加，不参与 alpha 稀释 → 在亮核上依然可辨。
 *  ④ 外溢辐射：由 scene.js 的独立辐射链（掩膜 → 半分辨率分离高斯 → 径向光轴）承担。
 *
 *  规格红线（63.2）：任何档位下 L5 的颜色与明度呼吸映射不得关闭。
 *  本文件所有增强项的亮度均由 u_emissive_intensity(E(t)) 与 u_emissive_color 直接驱动。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildFaceFragments, buildFaceFracturePlan } from './dodecaKit.js';

export const R_CORE = 0.8;      // 5.6.1 内层外接半径
export const R_SHELL_OUT = 1.0; // 附录 B.7 外层外接半径
export const SHELL_WALL = 0.04; // 附录 B.7 外层壁厚
export const R_SHELL_IN = R_SHELL_OUT - SHELL_WALL;

/** 内壳展开的 MainParam 阈值区间（激发态切换点） */
// v5.4：用户指定能量档位 —— <20 不显示分割线 / 20~80 显示切割线 / >80 展开
export const DEPLOY_START = 0.80;
// DEPLOY_END 已删除（v5.12）：展开位置不再由 smoothstep(p, 0.80, 0.97) 给出，
// 而是越过 0.80 触发**固定时长**的演出序列（爆发 → 碎块外推），与能量值解耦。

/* v5.12：0.80 之后的**固定时长演出序列**（全部与能量爬升快慢无关）
 *   ① SEAM_BURST_DUR：轮廓线爆发 —— 从脉冲当前位置向两侧铺满整个五边形面的轮廓，
 *      高亮一下再变暗。这是展开的"起手式"，先要把 XII 面体的轮廓线整体点亮宣示，
 *      再让碎块飞出；直接展开的话，观感上缺少这个蓄势。
 *   ② DEPLOY_DUR：碎块外推的长度。原先位置 = smoothstep(p, 0.80, 0.85) 是**能量的
 *      函数**（用户："现在的展开在 0.8-0.85 区间是固定位置的"）→ 改成 1/DUR 的固定
 *      速率推进，与云雾光环的成形同一套调度。 */
export const SEAM_BURST_DUR = 0.72;   // 铺满(0~0.42) → 高亮(0.42~0.62) → 变暗(0.62~1)
export const DEPLOY_DUR = 1.15;       // 碎块缓动到位

/* v5.13：装甲展开后碎块的「齿轮卡位」自转（用户定标）
 *  展开完成后，每块碎片每隔 2~4s（随机）绕**五边形面中心法线**顺/逆时针（随机）
 *  缓动旋转 72°（= 360/5，五边形的一次对称转动），先过冲 5~15° 再缓动回位 ——
 *  像齿轮卡进下一格。实现 = 缓动爬升的目标角 + 欠阻尼弹簧追踪：
 *  弹簧追一个 smoothstep 爬升到 72° 的目标，爬升结束时天然过冲再回位，
 *  过冲量由阻尼比控制（ζ≈0.45 → 过冲约 13~15°）。 */
export const FRAG_ROT_STEP = (Math.PI * 2) / 5;   // 72°
/* v5.13d（用户定标）：**旋转时间太长、过冲太小，体现不出齿轮卡位感**。
 *  ① 时长：基准 0.55s → **0.30s**，且改为"时长 = 基准 / 速率"（速率越大越快），
 *     以便让能量与片位置都作用在**速率**上；
 *  ② 过冲：注意时长与过冲**强耦合** —— 斜坡越接近阶跃输入，过冲越接近理论值
 *     72°·exp(-ζπ/√(1-ζ²))。缩短时长后先用 ζ=0.26~0.34，实测 23.9~26.3°
 *     （≈35% 过冲，偏橡胶感）；回调到 ζ=0.34~0.42 后实测 ~18°（≈25%），
 *     既有明确的卡位顿挫又不至于晃。要再调只动 ζ 一个数即可。 */
export const FRAG_ROT_RAMP = 0.30;                // 基准时长（秒）；实际 = RAMP / (片速率 × 能量加速)
export const FRAG_ROT_K = 180.0;                  // 弹簧刚度
/* v5.13b（用户修订）：旋转改为**按面协同** —— 同一面的所有碎片同一时刻、同方向
 * 转 72°（否则各转各的，碎片再也拼不回五边形）。面内仍保留机械感：
 *  · 每片的**缓动系数**不同 —— 由该片到面中心的距离决定（内圈快、外圈慢，
 *    旋转像一道波从面心扫出去）；
 *  · 每片的**过冲量**不同 —— 各片自己的阻尼比在小区间内随机，过冲约 8~12°
 *    （≈4° 的浮动带宽，压在用户"5 度之内"的带宽要求里），回位时错落收拢，
 *    像一排齿轮齿依次卡进位。
 *    注：ζ 理论过冲 = 72°·exp(-ζπ/√(1-ζ²))，ζ=0.46~0.55 时本应 9~14°，但
 *    smoothstep 斜坡对弹簧是缓输入，实测只剩 2~5°（用户定标 5~15°，不达标）；
 *    ζ 下调到 0.32~0.40 后实测回到 8~12°。 */
export const FRAG_ROT_ZETA_MIN = 0.34;
export const FRAG_ROT_ZETA_MAX = 0.42;
/* v5.13c/d：**缓动速率**（不是时长倍率）—— 走**面内归一化距离** radialN（0=面心 1=外缘）。
 * v5.13c 之前用世界单位 radial 做 `0.70+0.60*radial`，带宽只有 0.79~1.09 ——
 * 用户反馈"每个面的所有碎片缓动系数看起来也是一样的"。
 * v5.13d 起改为速率语义：面心片 1.45、外缘片 0.62（近 2.3× 档差），
 * 旋转读起来是一道从面心扫向边缘的波。 */
export const FRAG_ROT_RATE_MIN = 0.62;            // 外缘片速率（慢）
export const FRAG_ROT_RATE_MAX = 1.45;            // 面心片速率（快）
/** v5.13d：能量超出 0.80 的部分带来的**速率加成**（p=1.0 时 ×(1+0.90)=1.90） */
export const FRAG_ROT_ENERGY = 0.90;
/** v5.13c：回归演出的兜底超时（秒）—— 正常靠"全部碎片停稳"结束 */
export const FRAG_RET_TIMEOUT = 2.2;
/** v5.13d：能量掉下阈值后，**最多**冻结收拢这么久就开始降（用户：等半秒不到就回落） */
export const FRAG_RET_HOLD = 0.45;

/* —— v5.19：首次转动的排期（修"所有面同时转动一次"）——
 * 根因（探针 g16a 实测）：grp.nextAt 是**绝对时刻**，而能量 <80 期间转动触发条件
 * 根本不参与判定，nextAt 就一直停在很久以前的值（实测 1.79~3.79，而展开到位时
 * simTime 已到 6.48）。于是 d 一越过 0.98，12 个面全部满足 simTime >= nextAt
 * → 同一帧一起转（实测 12 个面首次激活时刻全是 6.48，spread = 0）。
 * 修正：在"刚具备资格"的上升沿按**当前时刻**重新排期。
 * · ROT_FIRST_DELAY_BASE：展开到位后最短等多久才允许转（留出"刚升起来"的读秒）；
 * · ROT_FIRST_STAGGER：12 个面首次转动摊开的窗口（分层随机分槽，不是纯随机）。 */
export const ROT_FIRST_DELAY_BASE = 0.30;
export const ROT_FIRST_STAGGER = 2.60;

/** v5.7：能量越过 DEPLOY_START 后，环状雾带的成形动画时长（秒，固定值） */
export const RING_FORM_DUR = 1.0;

/** v5.9：水晶轮廓线的能量阈值（<20 无分割线）与一次性渐显时长（秒，固定值）
 *  v5.16（本轮用户重排阈值）：轮廓线"从中心向外蔓延 + 沿轮廓循环高亮脉冲"整体
 *  后移到 **35** 阈值 —— 那才是用户要的"新 35"。原 20 阈值改由水晶壳的**面心脉冲渐显**
 *  承担（见 SHELL_SHOW_P）。 */
export const SEAM_SHOW_P = 0.35;
export const SEAM_FADE_DUR = 0.9;

/* —— v5.16：20 阈值 —— 完整水晶壳由每个基准面中心向外"不规则脉冲渐显" ——
 * 用户原话："能量上升到达20阈值时：完整的水晶壳通过在每个基准面中心由内向外
 * 不规则脉冲渐显，此时每个面的水晶是完整块。"
 * 与轮廓线（35）分工明确：20 = 晶体壳**出现**（整块、无轮廓线）；35 = 轮廓线**蔓延**。
 * 前沿同样是空间径向的（面内 rt 0=面心 → 1=五边形边界），一次性，固定时长，
 * 反向（能量跌回 20 以下）同速收回。 */
export const SHELL_SHOW_P = 0.20;
export const SHELL_FORM_DUR = 0.75;
/** 水晶壳前沿的软边宽度（半径占比）与推进缓动指数：1.35 次幂 → 面内可见时长占 63% */
export const SHELL_FORM_SOFT = 0.14;
/** 水晶壳前沿自带的一道"脉冲亮边"增益（渐显是"脉冲"，不是单纯淡入） */
export const SHELL_FORM_EDGE = 2.00;
/* v5.21：**前沿脉冲线的周长补偿** —— 修"脉冲线都到达边缘的时候亮度叠加会闪一下"。
 * crystalBand 是逐像素固定峰值 1.0，而折线的**屏幕弧长 ∝ 前沿半径**（面心处几乎是一个点，
 * 五边形边界处是整圈周长）。于是总光通量随前沿线性增长 → 到边缘时最亮 → 一次过冲闪光，
 * 越过 bloom 阈值 1.0 还会把整面糊白（与 v5.20"过曝糊成一团"同一根因）。
 * 补偿后单位长度增益 = 1/(1 + SHELL_ARC_COMP * front01)：front=0 → 1.00，front=1 → 1/(1+C)。
 * 1.15 → 边缘处单位亮度降到 46%，全程总光通量基本持平。 */
export const SHELL_ARC_COMP = 1.15;
/* v5.21：**断裂侧壁在 u_deploy=0 时的反光下限** ——
 * 渐显渐隐（u_shell_form 0→1）整段都发生在 u_deploy=0，而断口反光项原来乘了 u_deploy
 * → 侧壁被乘成 0，晶体板只剩一个没有厚度的平面五边形。
 * 用户原话："你现在渐显渐隐过程中画的两个面中间我没有看到任何侧壁"。
 * 0.55 = 内部裂纹侧壁的常驻档（压住 v5.5 修掉的"低能态暗轮廓线"）；
 * 外圈侧壁另有 1.7 的加成（见片元里 wallOuter），读作五棱柱真正的柱面。 */
export const WALL_AMP_FLOOR = 0.55;
/** v5.21：侧壁显现门控 wallVis 的下限（原 smoothstep(0.02,0.30,u_deploy) 在渐显段恒为 0） */
export const WALL_VIS_FLOOR = 0.60;
/* —— Round G：面内径向「脉冲环 + 半隐扩散」——*
 * ★ v5.16 重构（用户明确指出：这些行为都该在**基准面**上，不该在水晶碎块上）：
 *   原实现把三种触发全部做在 285 片水晶碎块的材质上（_writeFaceRev 只写碎片 uniform），
 *   其中"高能周期"是**无条件自由循环**（REVEAL_PERIOD=2.4s、只判 p≥0.80），
 *   没有事件触发条件 —— 这就是用户看到的"一直循环的粗橙色条环"。
 *   现在碎块只保留 **R4 撞击**一种触发（真事件）；"周期"与"收回显现"整体搬到基准面。
 *  · IMPACT_PULSE_DUR 撞击触发的那一次脉冲环时长（0.9s：清楚但不拖沓）。
 *  · IMPACT_GLOBAL_GAP 全局最小间隔 —— 撞击物理照常发生（储存/冷却不变），
 *                    但**可见的环**限流，否则 285 片 × ~50 次/秒 会糊成一片噪声。 */
export const REVEAL_FRONT_END = 1.35;
export const IMPACT_PULSE_DUR = 0.9;
export const IMPACT_GLOBAL_GAP = 0.42;
export const IMPACT_FACE_GAP = 1.6;
/** 撞击脉冲环的高亮增益（必须"明显"—— 用户否掉了原来的冷光点；由环的覆盖面积+亮度承担事件感）
 *  v5.16：用户要求"保留脉冲环，但变细、挑合适的颜色、不过多占据主视觉" →
 *  环宽 σ 0.085→0.040（见 RING_SIGMA_IMPACT）、增益 0.85→0.55、色相改冷青白。 */
export const IMPACT_RING_GAIN = 0.55;

/* —— v5.17：**片级**撞击脉冲（用户重构）——
 * 用户原话："粒子只会打在最外面一圈的碎片上，打中后，以击中点为中心，碎片形状为脉冲线
 *   形状向外扩散，直到覆盖满整个碎片，脉冲不改变碎片任何特性。"
 * 与 v5.16 的面级环彻底区分开：行程、中心、覆盖范围全部是**片级**的。 */
/** 脉冲行程时长：从击中点推到片最远顶点。太快看不清、太慢会堆叠 */
export const HIT_PULSE_DUR = 0.46;
/** 全局节流 —— 可见脉冲的密度（撞击物理照常，只限可见脉冲）。
 * 实测撞击频率 ~50 次/秒，全放出来会糊成噪声；0.14s ≈ 每秒 7 道，读得清是"一道道" */
export const HIT_GLOBAL_GAP = 0.14;
/** 同一片的最小重触发间隔 */
export const HIT_FRAG_GAP = 0.9;
/** 命中脉冲线的高亮增益（线很细，可以给得比面级环高一点） */
/* v5.18：0.62 → 1.05 —— 线宽砍到 0.024·u_hitR（原 0.055）后总光通量下降，
 * 用峰值补回，保证"更细但更锐"而不是"更细也更暗"。 */
export const HIT_LINE_GAIN = 2.10;
/** 只有 radialN ≥ 此值的碎片才进撞击捕集池 —— "粒子只会打在最外面一圈的碎片上" */
export const HIT_OUTER_RADIAL = 0.86;

/* —— v5.16：基准面（shellInner）的「细线环脉冲 + 擦除式半隐」——
 * 用户原话："上升到达80阈值：……同时每个基准面从中心向外扩散不规则、极薄的细线环脉冲，
 * 脉冲扫过的部分变得半隐，没扫过的部分照旧，最后时整个基准面变得半隐。"
 * 以及 Impact 修订："不要环内半隐，保留脉冲环，但是变细，挑选合适的颜色，
 * 不过多占据主视觉。"
 *
 * ★ 与碎块侧的原语差异（这是本次重构的核心）：
 *   · **没有环内半隐** —— HIDE_DEPTH 那条暗区直接删除。半隐由**擦除前沿**表达：
 *     前沿之内 = 已扫过 = 半隐，前沿之外 = 照旧。环只是前沿上那道细线。
 *   · **环极薄**：BASE_RING_SIGMA 0.038（碎块侧是 0.085，实测被读作"粗橙色条环"）。
 *   · **冷青白**：mix(vec3(0.62,0.86,1.0), u_emissive_color, 0.25) —— 从暖色主视觉里
 *     跳出来，又不跟核心的橙抢戏；增益压到 0.30（碎块侧曾是 0.42/0.62/0.85）。
 *   · **面间错相**：shellInner 是单 Mesh 单材质（12 面共 uniform），故在**片元里**
 *     由面法线 hash 出 face seed，做黄金比错相（BASE_FACE_STAGGER）。
 *
 * ★ 时长约束（用户定标）："基准面脉冲扩散完全时间应小于水晶碎块的脉冲高亮开始蔓延
 *   ～ 水晶碎块开始升起的时间"。碎块那段 = SEAM_BURST_DUR(0.72s) → 取 0.42s，
 *   与爆发**并发**起跑，基准面先扫完，碎块才升起。 */
export const BASE_PULSE_DUR = 0.42;

/* —— v5.19：撞击队列（用户定标）——
 * 用户原话："保证每个水晶碎块面的最外围一圈碎片，在转动间隔时间内至少各被打中一次
 *   （不能固定击打顺序，可以每个转动间隔内随机一个 n+1 ~ n+2 长度的队列
 *   （n 为每个面最外围一圈碎片个数），将最外围的所有碎片先随机各排列一个到队列的
 *   随机位置，空位继续随机碎片，这样能保证间隔内一定都各被击中一次）"
 * · HIT_QUEUE_MIN_SPAN：排期窗口的最短跨度（防止 nextAt 太近导致队列挤成一团）；
 * · HIT_QUEUE_EXTRA_*：队列长度 = n + 1 ~ n + 2（多出来的 1~2 个是"重复命中"，
 *   让节奏不机械 —— 每片至少一次，少数片被击中两次）。 */
/* —— v5.19：储能态能量粒子流 ——
 * · CHARGE_PER_FRAG：每片的能量粒子数。相位按 2π/K 均分 → "**规律**流动"；
 * · CHARGE_OMEGA：环流角速度（rad/s），匀速 → 读作有组织的能量环流；
 * · CHARGE_RADIUS_LO/HI：轨道半径（× 片包围半径 boundR）。必须 <1，粒子才在片内；
 * · CHARGE_MIN_STORED：进入储能态所需的最少命中次数（1 = 打中一次就亮）。 */
export const CHARGE_PER_FRAG = 3;
export const CHARGE_OMEGA = 2.2;
export const CHARGE_RADIUS_LO = 0.38;
export const CHARGE_RADIUS_HI = 0.72;
export const CHARGE_MIN_STORED = 1;

export const HIT_QUEUE_MIN_SPAN = 1.10;
export const HIT_QUEUE_EXTRA_MIN = 1;
export const HIT_QUEUE_EXTRA_MAX = 2;

/* ==================== v5.20：脉冲柱面（真正的立体侧壁） ====================
 * 用户原话（v5.19）：「脉冲线往下打出的两个面之间的**柱面**现在和上下两个面完全一样，
 *   或者我猜你根本没有画这个柱面……只能看出上下两个面，并且两个面还会互相遮挡，
 *   根本看不出上下关系，加上柱面会好很多，同时**柱面的颜色就和脉冲线颜色一样**，
 *   因为本质是这个柱面在向外扩张，柱面内是水晶材质。」
 * 用户原话（v5.20）：「柱面还是没有显现。我怀疑你把柱面加到了**那个贴片上面的那个面**上，
 *   而不是**上下两个五边形脉冲面之间**的那个柱面上。」→ **用户判断完全正确**。
 *
 * 根因（读几何代码定案）：
 *   · 晶体板本身是**实体**：`dodecaKit.js` 里 CRYST_Z0 = −0.012、CRYST_Z1 = +0.018
 *     → 每面是一块厚 0.030 的五边形板（顶面/底面/4 面断裂侧壁）。
 *     "上下两个五边形脉冲面" = **这块板的上表面与下表面**。
 *   · 而 v5.19 我把"柱面"写成了 `crystalWall(sdShell, 0.045)` —— 那是**面内的一道环带**
 *     （sdShell 是面内归一化半径），所以它必然跟顶面处在**同一个平面**上 →
 *     用户看到的就是"和上下两个面完全一样"，一点立体感都没有。
 *   · 结论：柱面**必须是真实几何**——面内色带无论怎么调都不可能产生"上下关系"，
 *     因为深度信息只存在于几何里，不存在于同一个 fragment 的着色里。
 *
 * 做法：每个面一根**五边形管**（CylinderGeometry，5 边、无端盖），
 *   · 轴向 = 该面法线；
 *   · 半径 = 该面五边形外接半径 × COLUMN_R_GAIN（与板边缘对齐）；
 *   · 下沿钉在**基准面**（R_SHELL_IN，含 u_lift 抬升），
 *     上沿钉在**晶体板顶面**（面半径 + 板自身抬升 off + CRYST_Z1），
 *     高度随"板上升 + 基准面抬升"一起长 → 板越高、柱面越高（"柱面在向外扩张"）；
 *   · 颜色 = 脉冲线颜色（与 shellPulseCol 同源），更暗（侧壁受光少）→ 亮顶面 + 同色暗侧壁
 *     = 读得出"这是一个有厚度的体"；
 *   · 用 DoubleSide + 加色，正反两面都发光（管是开口的，只能看到侧壁）。
 * 为什么用真实几何而不是继续在 shader 里画：**遮挡关系只能由深度缓冲产生**。
 *   顶面能挡住柱面、柱面能挡住背面的柱面 —— 这是"上下关系"的唯一来源。 */
export const COLUMN_R_GAIN = 1.000;   // 柱面半径 = 该面五边形外接半径 × 此值（与板边缘齐平）
/* 柱面管朝向的基准轴：CylinderGeometry 经 rotateX(π/2) 后轴为局部 +Z。
 * 逐帧要把它转到该面的法线方向 —— 用 quaternion.setFromUnitVectors(+Z, normal)。
 * 放模块级常量（类方法体里的方法名不是可访问标识符，写成 updatePulseColumns._z 会 ReferenceError）。 */
const COL_AXIS_Z = new THREE.Vector3(0, 0, 1);
/* ★ 必须 > 1：实测（隔离探针）柱面半径取 0.995（与板轮廓重合）时，
 *   柱面的侧壁与晶体板的**轮廓完全共面** → 板把它整个盖住，合成画面里 Δ≈0.0001 = 看不见。
 *   取 1.03 让侧壁比板边缘**多露 3%** → 任何视角都能看到一条厚度边。 */
/* v5.21c：1.45 → **0.85**，并配 COLUMN_H0 / COLUMN_H_COMP 做柱高归一。
 * 1.45 是在"看不到侧壁"时拍出来的；后来发现真因是**朝向 bug**（见 updatePulseColumns），
 * 朝向修好之后 1.45 就过头了 —— 展开时 12 根加色管一起变长，直接"超新星爆发"。
 * 现在口径：静止态 0.85（读得出是壁、不越 bloom 阈值），展开态由高度归一压回去。 */
export const COLUMN_GAIN = 0.85;      // 柱面亮度（相对脉冲线峰值）
/** 静止态柱高（= R_SHELL_IN→板顶 的自然间隙），柱高归一的基准 */
export const COLUMN_H0 = 0.038;
/** 柱高归一系数：超出基准的高按 1/(1 + k·超量) 收回单位亮度（1.10 → 满展开约剩 0.18） */
export const COLUMN_H_COMP = 1.10;
export const COLUMN_MIN_H = 0.0;      // v5.20b：不再兜底 —— 柱高**就是**线框划定的壁厚，不做人为放大
export const PLATE_LIFT0 = 0.0;       // v5.20b：**保留为 0 且不再使用**（见下方说明）
/* ★★ v5.20b：**整个"浮起高度"概念被用户否决并删除**。
 *   用户原话："为什么要推开，水晶面底部正好和基准面贴合，只有上面和基准面有一定距离，
 *     就是线框划定的厚度。现在直接就是在现线框框定的厚度的外面推离，然后再画两个面，
 *     这不搞笑吗。"
 *   教训（已写入 skill §75）：新增位移量必须与既有位移一起算峰值；更根本的是 ——
 *   **不要为了"造出"一个效果而凭空加位移**。板底面本来就在基准面上，
 *   厚度是 R_SHELL_IN → R_SHELL_OUT 那一层壁（= 线框划定的厚度），
 *   柱面只是这层壁**本来就有的侧壁**，把它画出来即可。
 *   值保留为 0：`off` 里已不再引用它，仅作历史记录。 */
/* ★★ 这是让柱面**看得见**的关键（实测三轮才定案）：
 *   柱面的侧壁与晶体板轮廓共面时，板会在屏幕空间把它完全盖住 ——
 *   gain 拉到 8.0、半径放大到 1.03，合成画面里 Δmean 依然只有 ±0.0001（隔离视图 P2 却清清楚楚）。
 *   根因：晶体板用预乘混合（dst 乘 1−alpha，alpha 高到 0.92），任何与它共面/在其后的层都被乘掉。
 *   要让"上下两个五边形脉冲面之间的柱面"真的看得见，两个面必须**真的分开** ——
 *   故给晶体块一个浮起高度：板在上、基准面在下，中间的空隙由柱面填满且**四面可见**。 */
export const COLUMN_TOP_FADE = 0.30;  // 顶沿渐隐比例（0=硬边；越大越像从板底漫出来的光）
/** 面间错相占用的行程比例：0.35 → 各面起跑错开 0.147s，但都在 BASE_PULSE_DUR 内扫完 */
export const BASE_FACE_STAGGER = 0.35;
/* v5.18：基准面擦除环（= 用户说的"渐隐渐显脉冲线"）同步收细 ——
 * 半宽 0.038 → 0.018（显著区从 ≈0.09 半径收到 ≈0.043），增益 0.30 → 0.52 补回峰值。
 * 依据：用户"撞击和渐隐渐显的脉冲线宽度都过于大了，完全不符合精细、科技感的要求"。 */
export const BASE_RING_SIGMA = 0.011;
export const BASE_RING_GAIN = 0.52;
/** 擦除前沿的软边（半径占比）与推进缓动指数 */
export const BASE_WIPE_SOFT = 0.16;
export const BASE_WIPE_POW = 1.35;
/** 擦除前沿的不规则扰动幅度（方位向）—— "不规则脉冲"，不是正圆 */
export const BASE_WIPE_JIT = 0.10;
/* —— A1（用户拍板）：基准面在展开态保留 **~20% 幽灵态**，不再完全隐藏 ———
 * 实现上拆成两级相乘，避免"擦除"与"展开淡出"两次相乘把基准面压到看不见：
 *   · BASE_HIDE_LEVEL  = 擦除前沿扫过后基准面保留的比例（0.50 = "半隐"）
 *   · BASE_GHOST_FLOOR = 碎块外推（_deploy→0.55）后 innerFade 的下限（0.40）
 *   两级乘积 = 0.50 × 0.40 = **0.20** —— 正是用户要的"20% 不透明度左右"。
 * 注：2026-09-25 的"水晶外推后基准面完全隐藏、核心暴露"设定**已由用户本轮舍弃**。 */
export const BASE_HIDE_LEVEL = 0.50;
export const BASE_GHOST_FLOOR = 0.40;
/* —— v5.17：幽灵态结构线亮度补偿 ——
 * 起因：`u_shell_fade` 同时乘 c 与 alpha → 高能态把基准面的发光结构线也压暗了，
 * 用户判定"核心+半隐基准面的颜色就变得很暗，一点不像高能状态该有的样子"。
 * 补偿只作用颜色、不作用 alpha → 基准面仍是"能看穿的幽灵框架"，但框架的线是亮的。
 *
 * ★ 关键修正（探针 g14c/g14d 实测）：补偿必须由**时间量**驱动，不能只由 p 驱动。
 *   变暗是两段时间链路的乘积：擦除前沿 bVis(1→BASE_HIDE_LEVEL，随 _baseProg)
 *   × 幽灵态 innerFade(1→BASE_GHOST_FLOOR，随 _deploy)。而 p 是**瞬间**到位的。
 *   若 boost 只跟 p 走，刚过阈值时 p 已到顶、暗化却尚未发生 → 先炸亮再回落，
 *   读出来仍然是用户抱怨的"过一会儿变暗"。故这里对**瞬时衰减求倒数**，
 *   让补偿与暗化同步升起（见 sync 内的实现）。
 * · BASE_BOOST_MIX：补偿强度。1.0 = 刚好补平到"阈值前的亮度"；
 *   >1 = 高能态比阈值前更亮（用户要的"像高能状态"）。实测 1.25 → 约 1.18×。
 * · BASE_BOOST_MAX：硬上限，防 _atten 极小时补偿失控。
 * 实测（g14d，settled 态，画面中心区域均值 vs 阈值前基线）：
 *   boost 1.0→0.598×｜2.6→0.786×｜4.0→0.940×｜5.0→1.070×｜6.5→1.232×｜8.0→1.325×
 *   且 hotFrac(>0.95 的像素占比) 全程为 0、max 仅 0.809→0.853 —— 片元里 _lc>1.25
 *   的预算上限把峰值兜住了，提亮不会炸白。 */
export const BASE_BOOST_MIX = 1.25;
export const BASE_BOOST_MAX = 8.0;

/* —— v5.18：基准面（shellInner）在高能态沿面法线抬升 + 上下浮动 ——
 * 用户原话："能量大于80的时候，基准面外壳都是严丝合缝的，实际上都看不出来有一层面包着……
 *   外壳基准面也沿着法线方向抬升一定距离，并在一定范围内上下浮，这样可以同时看到
 *   基准面遮掩下的内部核心，也可以直接看到核心内部的部分高亮溢出。"
 * · BASE_LIFT：抬升距离。参照基准面内切半径 R_SHELL_IN × 0.79465 ≈ 0.763，
 *   0.10 ≈ 13% —— 足以读出"这是一层包着的面"，又不至于让 12 块板看起来散架。
 * · BASE_FLOAT_AMP：浮动幅度，相对抬升量的比例 → 实际在 0.068 ~ 0.132 之间起伏。
 * · 收回时序（关键约束）：用户要求"渐显 + 下落 ≤ 目前碎片面回位 + 下落的时间"。
 *   做法是把"回到严丝合缝"塞进**已存在的渐显冻结窗口**内 —— BASE_PULSE_DUR(0.42s)
 *   期间 _deployT 本来就被 holdDeploy 冻住，让 u_lift 随同一个 _baseProg 归零，
 *   碎片开始下落时基准面早已合拢 → **总时长一分不增**（见 sync 内实现）。 */
export const BASE_LIFT = 0.10;
export const BASE_FLOAT_AMP = 0.32;

/* v5.18：内芯层（白雾源）的结构窗口下移量。
 * 0 = 最稀疏（冷光几乎消失，实测 Δmean 只剩 0.00026、壳体均亮 0.126→0.093 —— 过头）；
 * 越大 = 典型值越进入窗口，冷光越多，但仍是高对比的丝状结构而非均匀毯子。
 * 由探针 g15e 扫描定标（目标：壳体均亮回到 ~0.12，同时均匀度保持 ≥8）。 */
export const CORE_STRUCT_K = 0.30;

/* v5.18：数据流拖尾（冰蓝粒子方格细流）增益。GLSL 侧走 uniform u_data_trail，
 * 这样既能被探针消融验证，也能后续调参，不再需要镜像 #define。 */
export const DATA_TRAIL_GAIN = 0.35;

/* —— v5.14：收回显现不再"硬切" ——
 * 用户原话："碎片的光亮突然消失，变得暗淡无光……现在的收回是碎片回位后，从内向外
 * 沿着轮廓线再来一次脉冲，然后脉冲突兀的消失，实际应该这次脉冲覆盖完全之后快速渐隐，
 * 至少也要有一个亮度的过渡阶段，之后才降下去。"
 *
 * 根因（G9 实测，p=0.955 冻帧扫 showT 0→1，逐面 rt∈[0,1] 方位平均亮度）：
 *   showT  0.00 → 0.68 → 1.00
 *   亮度   0.4224 → 0.3147 → 0.4232
 *   即：暗波在 ~0.6s 内铺满整面（−0.108），然后**最后一帧** showT 触 1 → showAmt
 *   由 1 硬跳到 0 → 整面 +0.1085 弹回。这一帧的跳变幅度等于整段渐变的全部幅度 ——
 *   这就是"突兀的消失"。原代码 `showAmt = showT < 1 ? 1 : 0` 是**布尔台阶**，没有尾。
 *
 * 修法：把 showT 的行程从 [0,1] 延到 [0, 1+FADE_FRAC]，showT>1 的部分专门走渐隐尾：
 *   · 扫阶段（0→1）：  showAmt = 1，前沿 easeFront 由 0 推到 1.35（铺满整面）；
 *   · 渐隐尾（1→1+FRAC）：showAmt = (1−fadeU)^FADE_POW，前沿**冻结**在 1.35。
 *     幂 >1 → 起步即快速下坠（"快速渐隐"），末端导数归零 → 稳稳落回空闲基线，
 *     不会在收尾处又出现一个折点。
 * 并让收回显现也带上脉冲环（REVEAL_RING_GAIN），使"从内向外的一次脉冲"真的能被看见，
 * 环与暗区共用同一条 showAmt 包络 → 一起渐隐，不会各自消失。 */
/* ★ v5.16：上述"收回显现"原语整体**搬到基准面**（BASE_PULSE_DUR / BASE_* 一组）。
 * 留在碎块上的那段 1.30s 冻结（RETRACT_REVEAL_DUR×SPAN）正是用户抱怨的
 * "比之前版本要多等将近半秒"的元凶（实测：v5.13d 只冻结 FRAG_RET_HOLD=0.45s，
 * v5.14 变成 1.30s，**多出 0.85s**）。现在冻结时长 = max(FRAG_RET_HOLD, BASE_PULSE_DUR)
 * = max(0.45, 0.42) = **0.45s**，回到 v5.13d 的基线。
 * 以下旧常量已删除：RETRACT_REVEAL_DUR / RETRACT_REVEAL_FADE / RETRACT_FADE_POW /
 * REVEAL_RING_GAIN / REVEAL_SHOW_SPAN。 */
/** 收回时轮廓线爆发的**单调熄灭**时长。原实现把 _burstT 从 1 递减回 0，包络被倒放
 *  重播一次（0→1→0）→ 轮廓线在收回时又整体亮一下，与收回显现的暗波叠在一起，
 *  读作"光亮突然消失、变得暗淡无光"。改为单调衰减，收回期间不再有第二次起手式。 */
export const RETRACT_BURST_FADE = 0.34;

// 增强层：两层加色约束场（不参与规格几何判定）
// v3：由「内核与硬壳之间 0.86 / 0.92」外移到硬壳之外。
//     原因（量化）：默认视口 1u ≈ 81px，0.86/0.92 仅比内核轮廓外扩 5px / 10px，
//     两层壳在径向上挤在一起完全不可分辨；外移后层间距 ≥13px，才谈得上层次。
export const R_FIELD_A = 1.16;
export const R_FIELD_B = 1.38;

/** 正十二面体内切半径 / 外接半径 = 0.79465447…（SDF 支撑函数距离） */
export const DODEC_INRADIUS_RATIO = 0.79465447;

/* —— 共享 GLSL：3D value noise + fbm（100% 程序化，38.5 无外部贴图）——
 * v5.7：能量环雾带同样需要噪声，抽成公共块注入各着色器，杜绝第二份实现漂移。 */
const NOISE_GLSL = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3(0.0, 0.0, 0.0)), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
float fbm3(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return s;
}
`;

/* ------------------------------------------------------------------ *
 *  顶点着色器
 * ------------------------------------------------------------------ */
const VERT = /* glsl */ `
precision highp float;
uniform vec3 u_cam_forward;      // 世界空间相机朝向（由 CPU 每帧写入）
/* v5.18：基准面（shellInner）沿面法线抬升 —— 高能态把"包着核心的那层面"顶起来，
 * 才能同时看到面下的内部核心、以及从缝里溢出的高亮。
 * shellInner 是 DodecahedronGeometry(radius, 0)：three.js 在 detail=0 时走
 * computeVertexNormals() → 法线是**逐面常量**（每个五边形一个法线），
 * 于是"沿 normal 位移"就等于"每个面沿自己的法线整体抬升"，正合需求。
 * u_lift = 0 → 严丝合缝（闭合态/收回后）。 */
uniform float u_time;
uniform float u_lift;            // 抬升距离（物体空间）；0 = 严丝合缝
uniform float u_float_amp;       // 抬升态下的上下浮动幅度（相对 u_lift 的比例）
#define BASE_FLOAT_FREQ 1.9      // 浮动角频率（rad/s）
/* 面级种子：与片元侧 hash13 同构，但 VERT 不注入 NOISE_GLSL，故自带一份 */
float vertHash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
varying vec3 vNormalView;
varying vec3 vNormalWorld;
varying vec3 vObjNrm;        // 物体空间法线 = 五边形面法线
varying vec3 vTanWorld;      // 面切线（世界空间，顶点着色器里已变换）
varying vec3 vBitanWorld;    // 板材凹凸法线在片元里拼装；modelMatrix 只在顶点可用
varying vec3 vViewDir;
varying vec3 vObjPos;
// v5.2 面裂片：片自身的轮廓环。非裂片几何不提供这两个属性 → WebGL 通用属性默认 0，无害。
/* v5.18 修正：本行旧注释把语义写反了，与生成器 dodecaKit.js:250 冲突。
 * 以生成器为准：aSeam = 「到本片轮廓的距离 / 带宽 W」——
 *   **0 = 线心（片外缘/裂纹面）**，≥W = 板面本体。
 * 故 seamEdge = 1 - smoothstep(0, W, vSeam) 才是"线心为 1、本体为 0"。（旧注释已废） */
attribute float aSeam;      // 0 = 线心(片外缘/裂纹面)，≥W = 板面本体
attribute float aRim;       // 1 = 该轮廓点落在原五边形边界上（原边比内部裂纹更亮）
attribute float aThick;     // v5.4：该点处晶体板厚度（顶−底）→ Beer–Lambert 体积吸收
attribute float aWall;      // v5.5：1 = 断裂侧壁（展开后才显现，闭合态隐藏 → 无暗轮廓线）
attribute float aCrackU;    // v5.5：裂缝轨迹坐标 u = 面内归一化半径（0=面心，1=外缘）
attribute float aCrackAz;   // v5.5：裂缝轨迹坐标 v = 方位角/2π（供前沿摆动）
attribute float aShard;     // v5.11：片级种子（0..1）→ 每片自己的明暗档
varying float vSeam;
varying float vRim;
varying float vThick;
varying float vWall;
varying float vShard;
varying vec2  vCrackUV;
void main() {
  vNormalView = normalize(normalMatrix * normal);
  vNormalWorld = normalize(mat3(modelMatrix) * normal);
  vObjNrm = normalize(normal);
  // 面内正交基（与片元 faceTangent 同构），变换到世界空间供凹凸法线使用
  vec3 tUp = abs(vObjNrm.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tObj = normalize(cross(tUp, vObjNrm));
  vTanWorld = normalize(mat3(modelMatrix) * tObj);
  vBitanWorld = normalize(mat3(modelMatrix) * cross(vObjNrm, tObj));
  // 正交相机下 normalize(-mvPosition.xyz) 是错误的：相机在 z=50 处、物体横向偏离时
  // 会得到最多 ~5° 的视线偏角，恰好把边缘光算歪。正确做法是用真实的前向向量。
  vViewDir = -normalize(mat3(viewMatrix) * u_cam_forward);
  vObjPos = position;
  vSeam = aSeam;
  vRim = aRim;
  vThick = aThick;
  vWall = aWall;
  vShard = aShard;
  vCrackUV = vec2(aCrackU, aCrackAz);
  /* v5.18：抬升 + 浮动。只改 gl_Position，**不动 vObjPos** ——
   * 面板/擦除花纹锁在面自身坐标上，面抬起来时花纹跟着走而不是在面上滑动。
   * 浮动幅度乘在 u_lift 上：u_lift=0 时严格归零，闭合态绝不破坏严丝合缝。
   * 面级相位只错开 1.2 rad（不是整周期随机）→ 读作"整体起伏 + 轻微错相"，
   * 而不是 12 块板各自乱飘。 */
  vec3 _nrm = normalize(normal);
  float _fseed = vertHash13(floor(_nrm * 16.0 + 0.5));
  float _lift = u_lift * (1.0 + u_float_amp * sin(u_time * BASE_FLOAT_FREQ + _fseed * 1.2));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + _nrm * _lift, 1.0);
}
`;

/* ------------------------------------------------------------------ *
 *  片元着色器（Prog_HDRCore）
 * ------------------------------------------------------------------ */
const FRAG = /* glsl */ `
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
uniform vec4  u_impact;              // Phase1c：xyz = 片内物体空间命中位置, w = 受击强度(命中后衰减)
uniform float u_cool;                // Phase1c：冷色调量 0..~0.5（随碎片储存粒子量升高，封顶）
/* Round G（R4/R5 共用原语）：**面内径向**脉冲。
 * 坐标不是"碎片"，而是每片自身的面内归一化半径 t = vCrackUV.x（0=面心 → 1=五边形边界，
 * 由 dodecaKit 的 aCrackU 提供）→ 脉冲环是逐像素连续环，不会读成一格一格。
 *   x = 半隐前沿（环内半隐；≥1.35 视为未启用）
 *   y = 半隐量（0..1 → 环内乘到 1−0.62y ≈ 0.38）
 *   z = 显现前沿（未扫到处保持半隐，前沿扫过即恢复）
 *   w = 显现量（0..1） */
uniform vec4  u_rev;
uniform float u_revGain;             // 脉冲环高亮强度（v5.16：只剩撞击一种触发）
/* v5.17：**片级撞击脉冲** —— 命中点在片局部（= 面局部，片几何原点在面心）坐标，
 * 行程 −1 = 空闲；线形走全局水晶破碎折线规则（crystalLineSDF）。 */
uniform vec3  u_hitP;
uniform float u_hitT;
uniform float u_hitR;
uniform float u_hitGain;
/* v5.16：20 阈值 —— 完整水晶壳"由每个面心向外不规则脉冲渐显"的前沿（0→1.35）。
 * 0 = 整壳不显示（用户定标："初始0能量时：水晶碎块不显示，仅留外壳基准面包裹住核心"）；
 * ≥1.35 = 整面完全显现。是一条**空间径向**前沿，不是全局淡入。 */
uniform float u_shell_form;
/* v5.16：**基准面（shellInner）**的「细线环脉冲 + 擦除式半隐」。
 * 用户定标：这些行为属于基准面，不属于水晶碎块；且"不要环内半隐"。
 *   x = 全局擦除行程 0→1（1 = 全部面扫完；静止态恒 1）
 *   y = 方向：+1 = 擦除（扫过→半隐，上升 80）；−1 = 渐显（扫过→恢复，跌破 80）
 *   z = 细线环增益（仅在扫的过程中 >0，扫完即归零 → 不会常驻）
 *   w = 保留（0） */
uniform vec4  u_revB;
uniform float u_revBGain;            // 基准面细线环的高亮强度（BASE_RING_GAIN 量级，冷青白）
uniform float u_base_boost;          // v5.17：幽灵态下的结构线亮度补偿（只作用颜色，不作用 alpha）

/* —— Round G-fix：半隐的两个系数（G2 实测标定，勿随手改）——
 * HIDE_DEPTH       环内砍掉的亮度比例：0.62 → 环内保留 0.38（用户基准面要求"半隐到 ~38%"）。
 * HIDE_ALPHA_FOLLOW alpha 跟随 rk 的比例。**必须远小于 1**：预乘混合下 c 与 alpha 同乘会让
 *                  背景亮层透出来补偿掉自发光，实测"半隐"反而更亮（见下方片元处长注释）。 */
#define HIDE_DEPTH 0.62
#define HIDE_ALPHA_FOLLOW 0.28
/* —— v5.16：与 JS 侧同名导出常量**一一对应**的 GLSL 镜像 ——
 * 改 JS 常量时必须同步改这里（GLSL 读不到 JS 的 export）。
 * 只用在不需探针 A/B 的地方；需要 A/B 的一律走 uniform（如 u_seam_glow_fade）。 */
#define SHELL_FORM_SOFT  0.14   // 水晶壳渐显前沿的软边（半径占比）
#define SHELL_FORM_EDGE  2.00   // 水晶壳渐显前沿自带的脉冲亮边增益（v5.20：线 0.006 太细被抗锯齿抹暗 → 线放到 0.009 + 峰值再补）
/* v5.21：与 JS 侧 SHELL_ARC_COMP / WALL_AMP_FLOOR / WALL_VIS_FLOOR 一一对应（改 JS 需同步改这里）。
 * SHELL_ARC_COMP = 前沿折线的周长补偿，防"到达边缘时闪一下"（详见 JS 侧同名常量注释）。 */
#define SHELL_ARC_COMP   1.15
#define WALL_AMP_FLOOR   0.55   // 断口侧壁在 u_deploy=0 时的反光下限
#define WALL_VIS_FLOOR   0.60   // 侧壁显现门控 wallVis 的下限
/* v5.18：数据流拖尾（冰蓝粒子方格细流）。
 * 增益走 **uniform u_data_trail**（JS 侧 DATA_TRAIL_GAIN=0.35），不用 #define ——
 * 这样探针能消融验证"拖尾到底画出来没有"，后续也能直接调，不需要镜像两份常量。
 * 用户要的是"**少量**"—— 起点 0.35，宁可少了再加，不要一上来就糊成一片。
 * 另外拖尾固定用**冰蓝**（不随能量色变暖）：数据 = 冷色，与主视觉的暖色分族。 */
#define DATA_TRAIL_DUTY  0.26   // 有多少比例的方格真的亮（越小越稀疏）
#define SHELL_FORM_END   1.35   // 前沿终点（>1 = 越过五边形边界）
#define SHELL_FORM_START -0.20  // 前沿起点（<0 → u_shell_form=0 时整壳完全不显示）
/* v5.18：0.038 → 0.018（与 JS export BASE_RING_SIGMA 镜像，改一边必须改另一边） */
#define BASE_RING_SIGMA  0.011  // 基准面细线环的高斯半宽（"极薄"）
#define BASE_WIPE_SOFT   0.16   // 基准面擦除前沿软边
#define BASE_WIPE_JIT    0.10   // 擦除前沿的方位不规则扰动
#define BASE_WIPE_END    1.35
#define BASE_WIPE_POW    1.35   // 擦除前沿推进缓动指数
#define BASE_HIDE_LEVEL  0.50   // 擦除扫过后基准面保留的比例（"半隐"）
#define BASE_FACE_STAGGER 0.35  // 12 面起跑错相占用的行程比例
/* v5.17：核心透屏 —— 闭合态把热封在壳内（防"面心白团"），展开态核心暴露 → 炽亮。
 * 方向由"随展开变暗"改为"随展开变亮"（用户本轮报的高能态变暗根因）。 */
/* ★★ v5.21c：这两个因子原来是**相乘**的，叠起来 ×2.465 → 满能量核心糊成一坨白。
 * 用户原话："嗯对，所以我又把能量调到1，然后又看见了这坨屎。"
 * 教训与 skill §75（"新增位移量之前必须核对与既有位移的叠加总量"）**同一类错误**：
 *   v5.17 为修"能量>80 核心太暗"把 CONTAIN_HI 从 0.14 翻到 1.45；
 *   后来又加了独立的高能曝光 EXPOSE_HI = 1.70 —— 两个都是"调亮"，没人核对乘积。
 * 现在把**总量**当唯一口径来定：闭合 0.22 → 满能量 1.15（≈ ×5.2，v5.17 的"太暗"仍然修好），
 * 而不再是 ×2.465。以后要再调亮/调暗，改的是这个**乘积**，不要再各改一个。 */
#define CORE_CONTAIN_LO  0.22   // 闭合态（_deploy=0）：把热封在壳内，防"每个面心白团"
#define CORE_CONTAIN_HI  1.00   // 展开态（_deploy=1）：核心暴露 → 提亮（原 1.45）
#define CORE_EXPOSE_HI   1.15   // p≥1.0 时的额外曝光（p≤0.70 时为 1.0；原 1.70）
/* v5.21c：核心亮度上限改为**软拐点**。
 * 原来是 "if (_lc > 2.6) c *= 2.6/_lc;" —— 硬钳会把所有越界像素压成**同一个值**
 * （2.6 的平板），相对结构在这一步就被抹平，再经 bloom 就是一张均匀白盘 = 用户说的"一坨"。
 * 软压保留亮度**序关系**（2.0 与 4.0 仍映射到不同值）→ 只有最亮的丝越过 bloom 阈值，
 * 湍流结构活得下来。渐近峰值 = CORE_KNEE + CORE_HEAD = 1.70。 */
#define CORE_KNEE   0.95        // 软拐点：此亮度以下不动
#define CORE_HEAD   0.75        // 拐点以上的压缩头room（渐近上限 1.70）
/* 调参口径（探针 l5-verify/probe_g14.cjs 的 D2_coreIsolated）：
 *   _deploy=1 且隐藏碎块时，画面中心区亮度 mean ≈ 0.36（0.62/1.40 档）
 *   → 0.74/1.55 档约为 ×1.42。另有 ?tk_core=<v> 可直接改 u_plasma_gain 现场试。 */
uniform float u_seam_form;           // v5.9：轮廓线一次性渐显进度 0→1（阈值触发，定时长）
/* —— v5.15：轮廓线「总闸」的过渡宽度（用户报「<20 轮廓线收回后，整个构造体瞬间变得很暗」）——
 * u_seam_form 由 CPU 按 1/SEAM_FADE_DUR 线性推进（0.9s）。旧代码的总闸是
 * smoothstep(0.0, 0.10, u_seam_form)：>0.10 时恒为 1，于是整段 0.9s 的收回里，
 * **前 0.81s 亮度完全不动，最后 0.09s（≈2.7 帧）把全部亮度一次砍掉** —— 读作"瞬间跳变"。
 * 改成本 uniform 控制过渡宽度：1.0 = 在整个 0.9s 行程上均匀过渡（收回与变暗同步完成）。
 * 保留为 uniform（不是 #define）是为了能让探针在**同一次运行内**做 0.10 vs 1.00 的 A/B。 */
uniform float u_seam_glow_fade;      // 总闸的过渡宽度：0.10 = 旧行为（尾端悬崖），1.0 = 全程平滑
uniform float u_crack_mul;            // v5.10：水晶加色项（轮廓线/断口）消融系数
uniform float u_pulse_gate;           // v5.11：轮廓线脉冲闸门（0.20 阈值后开 → 0.80 展开止）
uniform float u_pulse_speed;          // v5.11：脉冲循环速度（圈/秒）
uniform float u_core_gain;            // v5.11：裂片内芯加色层强度（诊断/调参）
uniform float u_core_struct_k;        // v5.18：内芯层结构窗口下移量（0=最稀疏，越大冷光越多）
uniform float u_data_trail;           // v5.18：数据流拖尾增益（提升为 uniform 以便消融验证与调参）
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
varying float vSeam;        // 0 = 线心(片外缘/裂纹面)，≥W = 板面本体（同 aSeam，见其注释）
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

/* ==================== v5.17：水晶破碎脉冲线（**全局规则**） ====================
 * 用户定标：
 *   "现在水晶壳的不规则脉冲显现的脉冲边缘线太粗，而且看起来雾蒙蒙的，完全不是水晶块
 *    那种增生蔓延的感觉。我想要的是以脉冲线为底，向基准面打下去形成的柱体的感觉，
 *    脉冲线本身也不能均匀，要有足够的水晶破碎感折线，之后**所有的脉冲线都要遵循
 *    这个规则**。"
 *
 * 于是把「脉冲线」抽象成一条共用规则，三条脉冲（水晶壳显现 / 撞击 / 基准面环）
 * 全部改走同一组函数：
 *   ① **折线化**：把方位切成 N 段，每段取一个随机半径偏移，段内**线性**插值
 *      （不是 smoothstep）→ 出现尖角，读作"晶体断口"而不是"平滑的波"。
 *      两层叠加：N=7 大尺度断裂 + N=19 小尺度碎屑。
 *   ② **极细**：线宽由调用方按几何尺度给（外壳显现取 0.022 半径），不用宽高斯软带。
 *   ③ **柱体感**：线之后紧跟一条"侧壁暗带"（wallShade），读作从基准面立起来的墙 ——
 *      亮折线（顶面）+ 暗带（侧壁）+ 块体（已增生部分），三者叠起来才有厚度。
 */

/** 分段随机偏移：把方位切成 segs 段，每段一个随机值，段内线性 → 折线（有尖角） */
float crystalSegJitter(float az, float segs, float seed) {
  float a = az * 0.15915494 * segs;            // az/2π × segs
  float i0 = floor(a);
  float f0 = fract(a);
  float j0 = hash11(i0 * 1.317 + seed * 11.3);
  float j1 = hash11((i0 + 1.0) * 1.317 + seed * 11.3);
  return (mix(j0, j1, f0) * 2.0 - 1.0);        // −1..1，段内线性 = 折线
}

/** 水晶破碎线的有符号距离：0 = 线上。<0 = 前沿之后（已扫过），>0 = 尚未扫到。
 *  两层折线叠加；amp1/amp2 建议按几何尺度给（如 0.24·R 与 0.09·R）。 */
float crystalLineSDF(float r, float az, float front, float seed, float amp1, float amp2) {
  float j = crystalSegJitter(az, 7.0, seed) * amp1
          + crystalSegJitter(az, 19.0, seed + 3.7) * amp2;
  return r - (front + j);
}

/** 窄带（线上的亮度）：w 应为几何尺度的 ~5%，避免"雾蒙蒙"的宽软带 */
float crystalBand(float sd, float w) {
  return exp(-pow(sd / max(w, 1e-5), 2.0));
}

/** 柱体侧壁：紧贴线**之后**（已扫过那一侧）的一条暗带 —— 亮线 + 暗侧壁 = 有厚度 */
float crystalWall(float sd, float w) {
  float back = smoothstep(0.0, -w, sd);              // 线后侧
  return back * (1.0 - smoothstep(-w * 3.4, -w, sd)); // 只取紧邻的一段
}

/* v5.18：数据流拖尾 —— 脉冲线**内侧**的冰蓝粒子方格细流。
 * 用户原话："脉冲线可以适当往内少量做一些数据流拖尾（冰蓝粒子方格组成的细流），
 *   表现出数据的感觉。"
 * · inDist：到线的**内侧**距离（>0，即线已经扫过的那一侧）。"往内"= 指向面心/击中点的方向。
 * · lineU：沿线的参数坐标（方位角换算），决定粒子被切成多少列。
 * · 方格沿 inDist 方向**向内流动**；flow 越大流得越快。
 * · duty：真正有粒子的格子比例（越小越稀疏）；reach：拖尾的衰减长度。
 * 返回 0..1 的叠加权重，颜色与增益由调用方给（这样"少量"可控）。
 *
 * 实现要点：格子图案在 v 方向是**周期为 1** 的，所以流动偏移用 fract(u_time·flow)
 * 就等价于加 u_time·flow —— 但避免了 u_time 变大后 hash 退化、以及浮点精度流失。
 * 包络 fade 只由 inDist 决定 → 粒子是在一条**静止的**拖尾里往内流，而不是拖尾整体在动。 */
float dataTrail(float inDist, float lineU, float cellSize, float flow,
                float seed, float reach, float duty) {
  if (inDist <= 0.0) return 0.0;
  float fade = exp(-inDist / max(reach, 1e-5));
  if (fade < 0.02) return 0.0;
  float v = inDist / max(cellSize, 1e-5) + fract(u_time * flow);
  vec2 g = vec2(floor(lineU), floor(v));
  if (hash13(vec3(g, seed)) > duty) return 0.0;      // 稀疏：多数格子是空的
  vec2 f = fract(vec2(lineU, v));
  vec2 d = abs(f - 0.5);
  float sq = 1.0 - smoothstep(0.16, 0.32, max(d.x, d.y));  // 方格（不是圆点 → 数据感）
  return sq * fade;
}

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
      /* ★★ v5.19：整个水晶壳体的白雾**已删除** ★★
       * 用户原话："白雾和整个系统都很割裂，这个构造体是由精密粒子和水晶面组成的，
       *   白雾会带来混乱、雾蒙蒙的感觉，请删掉整个水晶壳体的白雾，换一种水晶发光效果。"
       * 历代实测：这一层从 v5.3 起就是"体内冷光"，为治"面心白团"被压成**均匀毯子**
       *   （g15c 消融：Δmean 0.0318 / 均匀度 3.11，而轮廓线只有 0.0072 / 11.6），
       *   v5.18 改成丝状脉络后降到 0.0077 / 9.94 —— 但用户判定：脉络也还是雾。
       * 结论：**任何基于低频 fbm 的体内加色都会读作雾**。故彻底弃用 fbm 云团。
       *
       * 换成的"水晶发光"= **棱面冷光**：
       *   裂片几何是**非索引 + computeVertexNormals()** → vNormalWorld 在**每个三角面内
       *   是常量** → dot(棱面法线, 主光) 是逐棱面常量 → 每个小棱面各自亮一档。
       *   于是发光跟着晶体的**真实棱面**走（硬边、锐利、随转动跳变），
       *   而不是一团浮在体内的雾 —— 这才是"水晶面在发光"。 */
      float facet = pow(clamp(dot(normalize(vNormalWorld), normalize(KEY_LIGHT_DIR)), 0.0, 1.0), 1.6);
      float rad2 = length(vObjPos);
      float fall = smoothstep(u_face_apothem * 1.10, 0.0, rad2);
      /* Round G（R1 修复，实测定位）：这一层就是"面心白团 + 周期往外扩散"的主犯之一。
       *  ① 原 breathe = 0.72 + 0.28·sin(u_time·1.7 − rad2·7.0)：相位里**带了面内半径**，
       *     波峰沿半径以 1.7/7 ≈ 0.24 u/s 向外跑；而 fall 又恰在面心最高（rad2=0 时为 1）
       *     → 12 个面心各一团、团还周期往外扩。改为**无空间相位的整体慢呼吸**，
       *     不再产生"扩散"读数。
       *  ② 原式只有 (0.30+0.70·pC)(0.35+0.65·eN) 的弱门控 —— p=0 时仍有 0.39 的常驻加色，
       *     这正是"能量 0 也照样亮、且不随能量变"的原因。改乘 gate：<0.20 能量整层全灭，
       *     20 能量以上随"轮廓线一次性渐显"（u_seam_form）一起出现。
       *  ③ 面心集中的 fall 权重从 0.40+0.60·fall 压到 0.55+0.45·fall —— 峰值不变、
       *     边缘抬起来，面心不再是一个"团"，而是一层均匀的体内冷光。 */
      float breath = 0.80 + 0.20 * sin(u_time * 0.85);
      float gate = smoothstep(0.0, u_seam_glow_fade, u_seam_form);
      // 碎片=吸收冷却能量的结构：内芯是冰蓝能量核（不随能量色变暖），呈现"封在晶体里的冷光"
      /* v-fix：内芯发光层峰值从 1.44 砍到 ~0.74——原值随 ~285 片加色叠加 + bloom 把整壳
       * 顶成白雾（用户："总体还是糊成一片"）。限制在 bloom 阈值内，保留"封在晶体里的
       * 冷光"读感，但不再越界发光。 */
      /* ★ v5.18：白雾根因修复（探针 g15c 消融实测，p=0.95，壳体像素口径）
       *   内芯层   Δmean=0.0318  均匀度 std/mean=3.11   ← 均匀抬亮 = 雾
       *   轮廓线   Δmean=0.0072  均匀度 11.6            ← 稀疏尖峰 = 线
       *   轮廓脉冲 Δmean=0.0006  均匀度 147.8           ← 稀疏尖峰 = 线
       * → 白雾不是"线画粗了"，而是这一层本身就是**一张均匀的毯子**：
       *     (0.10 + 0.85·neb2) 的均匀底噪 + 常驻 aC=0.60 的不透明加色，
       *     再乘上 285 片各自的加色叠加 → 35 阈值一开就糊在每一片上。
       *   改法：从"均匀体内冷光"改成**丝状脉络** ——
       *     ① 删掉 0.10 的均匀底噪；neb2 用更陡的 smoothstep 拉出高对比
       *        → 有亮丝、也有**真正的空隙**；
       *     ② 再叠一层更高频的细丝，让冷光读作"封在晶体里的能量脉络"而不是雾；
       *     ③ alpha 跟着结构走（空隙处真正透空），不再是常驻 0.60。 */
      /* 棱面冷光 = 棱面明暗 × 边缘菲涅尔。
       * · facet：逐棱面常量 → 硬边、随齿轮转动**跳变**（水晶的"活光"）；
       * · facing：视线掠射处更亮 → 读作棱边透光，而不是体内泛白；
       * · 两者相乘且**没有均匀的常数底** → 一定存在暗棱面，不可能糊成一片。 */
      float rimC  = pow(1.0 - facing, 2.2);
      float glowC = (0.30 + 0.70 * facet) * (0.40 + 0.60 * rimC);
      vec3 coreCol = vec3(0.36, 0.54, 0.80) * 0.92;
      vec3 cCore = coreCol * glowC * breath * gate
                 * (0.30 + 0.70 * pC) * (0.35 + 0.65 * eN)
                 * (0.55 + 0.45 * fall);
      // 断裂侧壁与本体层同步：闭合态隐藏（否则加色侧壁会在裂缝处印出亮线）
      float wallVisC = smoothstep(0.02, 0.30, u_deploy);
      /* alpha 也跟着棱面结构走 —— 暗棱面处真正透空，不再有常驻的不透明毯子。
       * 峰值 0.30（原 0.60 的一半）→ 即便最亮处也不会把背后的轮廓线冲掉。 */
      float aC = 0.30 * glowC * mix(1.0, wallVisC, vWall);
      gl_FragColor = vec4(cCore * u_core_gain * mix(1.0, wallVisC, vWall), aC);
      return;
    }

    /* 函数级作用域：下列变量供下方「晶体分支」与「基准面分支」两个 return 前的
     * 作用域共用，必须在此声明，否则基准面分支引用会触发 GLSL 未定义变量 → 整段
     * shader 编译失败 → 碎片与基准面全部不渲染（只剩线框）。 */
    float closed = 1.0 - smoothstep(0.0, 0.18, u_deploy);   // 闭合度：d≈0=闭合
    vec3  frost  = vec3(0.45, 0.72, 1.05);                  // 冷却冰蓝调基准

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
      // 碎片恒为冷却冰蓝调（frost，已在函数级作用域声明），不再随全局暖色 u_emissive_color 漂移 —— 它是吸收冷却能量的结构
      vec3 tint = frost;
      // 体内透射/散射用**能量色**主导（v5.6 融合关键）：水晶不是自带颜色的物体，
      // 而是"被这台机器的能量照亮并透射出来的介质" → 与构造体同源。
      vec3 innerCol = mix(frost, frost * 1.12, 0.35);

      vec3 c = mix(envT * absorb * (0.55 + 0.45 * tint), envR, fres);
      // 晶体自身的色相：随展开度从"环境色"偏向"水晶色"（低饱和矿物色，不撞色）
      /* v-fix：晶体色相迁移钳在 bloom(1.0) 以下——原 tint*1.06+0.14 把蓝通道推到 1.253，
       * 使每个完全展开的碎片整体越界触发 bloom，整壳糊成白雾。改为上限 0.95 的冷偏移项，
       * 只偏色不到 1.0，色相仍来自 frost / 能量色。 */
      c *= mix(vec3(1.0), clamp(tint * 1.02 + 0.06, 0.0, 0.95), 0.32 * u_deploy);

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
      float appear = smoothstep(0.0, u_seam_glow_fade, u_seam_form);   // 阈值前总闸：全灭（宽度见 u_seam_glow_fade）
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
      /* v5.17（全局规则）：轮廓脉冲线也**折线化** —— 旧式是等半径的正圆环（"太均匀"）。
       * 用同一套分段随机偏移把环半径按方位切成折线段。 */
      dU -= crystalSegJitter(vCrackUV.y * 6.2831853, 9.0, 2.7) * 0.045;
      float ahead = exp(-pow(dU / 0.07, 2.0));            // v-fix：环宽拓宽 ≈0.2 半径（用户要求更明显）
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
      vec3 pulseCol = mix(u_emissive_color * 1.55, vec3(1.0), 0.35);   // 恢复脉冲色相叙事：能量色向白提亮（青→橙随能量迁移）
      /* v5.12：0.80 触发的轮廓线爆发（蓄势）—— 从脉冲当前位置向两侧同时延伸，
       * u_burst_w 由 CPU 从 0.05 推到 1.25 直到铺满全部轮廓线 → 高亮一下 → 变暗。
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
       * 既然它是事实上的本体色，就只能按本体的预算来给。省下来的亮度预算留给稳态轮廓辉光与一次性展开爆发（往复脉冲已删除）。 */
      /* ① 底线（常驻）—— v5.13：vRim 落差从 0.55~1.45 压到 0.92~1.12。
       *    之前内裂纹线（vRim=0）比五边形边界（vRim=1）暗 2.6 倍 —— 这就是用户看到的
       *    "脉冲环内部的线明显比外部暗很多"：环内是内裂纹线、环外靠近边界线，静态落差
       *    被误读成脉冲造成的。落差压平后，"轮廓线显现的亮度"在整面上才是同一个值，
       *    脉冲经过前/经过后的线亮度也就一致了（不会再读出"变回暗状态"）。 */
      /* v-fix：结构层亮度预算——在叠加发光导管（轮廓/边光）之前把"晶体本体"钳到
       * bloom(1.0) 以下（≤0.85），本体绝不触发 bloom；发光项随后叠加可越界产生细线辉光。
       * 这是"冷色暗玻璃 + 发光线条"与"整壳白雾"的分水岭。 */
      {
        float _slc = max(max(c.r, c.g), c.b);
        if (_slc > 0.85) c *= 0.85 / _slc;
      }
      /* v5.19：白雾删除 + 用户定标"35-80 阶段的轮廓线太淡、脉冲高亮不明显"
       * → 底线幅度 (0.26+0.09·pC) → (0.46+0.20·pC)，脉冲 0.60 → 1.05。
       * 之所以现在才敢提亮：以前提亮会被白雾的均匀底噪吃掉（抬的是底噪不是线），
       * 现在底噪没了，提的每一分都落在**线上**，对比度直接转化成"看得清"。 */
      c += mix(u_emissive_color * 1.25, tint, 0.42)
         * pow(seamEdge, 2.2) * mix(0.92, 1.12, vRim)
         * (0.46 + 0.20 * pC) * (0.65 + 0.35 * lambert) * appear
         * u_crack_mul * u_seam_amp
         * (filled * 0.95 + head * 1.5)
         /* 轮廓线循环脉冲（20–80 能量区间，沿轮廓由内向外扩散；幅度受控，不糊面） */
         + pulseCol * pow(seamEdge, 1.8) * mix(0.90, 1.0, vRim) * pulse * 1.05 * u_pulse_gain * u_pulse_gate
         /* ③ 0.80 爆发 —— 铺满全部轮廓线后的整体高亮；靠覆盖面积而非单点亮度读作事件。 */
         + pulseCol * pow(seamEdge, 1.8) * mix(0.75, 1.0, vRim) * bInst * 1.05;
      // 断口（断裂侧壁）在展开后要有自己的反光，否则侧面一片死黑；
      // v5.6：反光荣用**能量色**一半 —— 断口被机器自身的光照亮 → 把水晶缝进场景。
      /* v5.21：断口反光**不再随 u_deploy 归零**。
       * 用户原话："你现在渐显渐隐过程中画的两个面中间我没有看到任何侧壁。"
       * 根因：渐显渐隐（u_shell_form 0→1）全程 u_deploy=0，而这里原来乘了 u_deploy
       * → 侧壁唯一专属的照明项被乘成 0；下面的 wallVis 同样在 u_deploy=0 时为 0，
       * 又把侧壁的 c 与 alpha 一起抹掉。两道门控叠加 = 晶体板只剩一个没有厚度的平面
       * 五边形 —— 正是示意图里那个五棱柱缺掉的侧壁。
       * 修法：① 断口反光给下限 WALL_AMP_FLOOR（下面 wallVis 同步给 WALL_VIS_FLOOR）；
       *       ② 只有落在**五边形外边界**上的侧壁才读作"棱柱的柱面" —— 内部裂纹侧壁
       *          若同样提亮，会在每条裂缝上印出描边（v5.5 已经修掉的老问题）。
       *          用面内归一化半径 vCrackUV.x 挑出外圈侧壁，单独加成 wallOuter。 */
      float wallOuter = vWall * smoothstep(0.86, 0.99, vCrackUV.x);
      c += mix(vec3(0.85, 0.92, 1.0), frost, 0.35)
         * pow(1.0 - ndv, 3.0) * 0.15
         * mix(WALL_AMP_FLOOR + 1.7 * wallOuter, 1.0 + 0.9 * wallOuter,
              smoothstep(0.0, 0.30, u_deploy))
         * u_crack_mul * u_wall_amp;
      // v5.6 融合项：轮廓边光用能量色 —— 经典"边缘光把物体缝进环境"手法。
      // 强度压在"染色"而不是"发光"档：过强会把水晶和构造体一起冲进白区（实测翻车）。
      c += u_emissive_color * pow(1.0 - ndv, 3.5) * (0.10 + 0.20 * pC) * (0.40 + 0.25 * u_deploy);   // 恢复边光能量色（结构冷、能量暖）
      // 轻微星云气流（保留 v5.2 需求，强度压低 —— 主体交给光学）
      vec3 np = vObjPos * 3.1 + vec3(u_time * 0.08, -u_time * 0.13, u_time * 0.05);
      float neb = smoothstep(0.30, 0.88, fbm3(np));
      c += innerCol * neb * (0.02 + 0.05 * pC) * (0.35 + 0.65 * eN) * facetGain;

      /* ==================== v5.16：20 阈值「水晶壳由面心向外不规则脉冲渐显」 ====================
       * 用户定标："初始0能量时：水晶碎块不显示，仅留外壳基准面包裹住核心……
       *   能量上升到达20阈值时：完整的水晶壳通过在每个基准面中心由内向外不规则脉冲渐显，
       *   此时每个面的水晶是完整块。"
       * 与轮廓线（35 阈值，u_seam_form）是**两件事**：
       *   · u_shell_form（这里）：整块晶体**出现**（空间径向前沿，无轮廓线）
       *   · u_seam_form（35）：轮廓线在已出现的晶体上**蔓延**
       * ★ 空间前沿而非全局淡入：前沿之内已显现、之外仍未显现，读作"由内向外扩散的脉冲"。
       * ★ 预乘混合下必须 **c 与 alpha 同乘**（只乘 alpha → 只是遮挡力下降、颜色照旧叠加，
       *   碎片背后的基准面亮层透出来，画面反而变亮 —— G2 实测已证）。 */
      float rt = clamp(vCrackUV.x, 0.0, 1.0);
      /* v5.17：20 阈值的水晶壳显现前沿 —— 改为**水晶破碎折线**（全局规则 crystalLineSDF）。
       * 旧实现是「±0.14 半径的 smoothstep 软带 + σ=0.10 的宽高斯亮边」，
       * 用户判定："边缘线太粗，而且看起来雾蒙蒙的，完全不是水晶块那种增生蔓延的感觉。" */
      float azF = vCrackUV.y * 6.2831853;
      float shellFront = mix(SHELL_FORM_START, SHELL_FORM_END, u_shell_form);
      // 两层折线：大尺度断裂 0.055 + 小尺度碎屑 0.020（面内归一化半径）
      float sdShell = crystalLineSDF(rt, azF, shellFront, vShard * 3.1, 0.055, 0.020);
      // 前沿判定：几乎硬边（±0.012 抗锯齿）—— 不再是 ±0.14 的软过渡（那正是"雾气"来源）
      float shellVis = smoothstep(0.012, -0.012, sdShell);
      /* 顶面亮折线（脉冲线本体）：v5.18 0.022→0.011，**v5.19 再收到 0.006**。
       * 用户两轮都在说太粗："宽度都过于大了，完全不符合精细、科技感的要求"、
       * "还是过粗了……一定要细，这样才能显现出脉冲线精密地覆盖整个面的效果"。
       * 线变细会掉总光通量 → 峰值由 SHELL_FORM_EDGE 补（0.55→0.90→**1.35**），
       * 保证"更细但更锐"，而不是"更细也更暗"。 */
      /* v5.21：修「脉冲线都到达边缘的时候亮度叠加会闪一下」。三个叠加成因逐个堵：
       *  ① **周长效应**（主因）：crystalBand 是逐像素固定峰值 1.0，而折线的屏幕弧长
       *     ∝ 前沿半径 —— 面心处几乎是一个点、五边形边界处是整圈周长。于是总光通量
       *     随前沿线性增长，到边缘时最亮 → 一次过冲闪光；越过 bloom 阈值 1.0 后还会
       *     把整面糊白（与 v5.20"过曝糊成一团白色"是同一根因）。
       *     → shellArc 周长补偿：线越长，单位长度增益越低，全程总光通量基本持平。
       *  ② **退出太晚**：原来按 u_shell_form 收（0.80→1.0），折算成前沿位置是
       *     front 1.04→1.35 —— 线**已经压到边界上**才开始收，峰值被完整放过才衰减。
       *     → 改按前沿半径 shellFront 直接收：0.78 起收、1.06 收完（对应
       *       u_shell_form 0.63→0.81），收在"到达边缘之前"。
       *  ③ **同像素多段折线堆叠**：jag 折线在 azimuth 上抖得厉害时相邻两段可能落进
       *     同一像素、crystalBand 的值相加。用 min(.., 1.0) 封顶，单像素峰值恒为 1。 */
      float shellFront01 = clamp(shellFront, 0.0, 1.0);
      float shellArc  = 1.0 / (1.0 + SHELL_ARC_COMP * shellFront01);
      float shellExit = 1.0 - smoothstep(0.78, 1.06, shellFront);
      float shellLine = min(crystalBand(sdShell, 0.009), 1.0)
        * smoothstep(0.03, 0.14, u_shell_form) * shellExit;
      /* v5.18：往内的数据流拖尾。内侧 = 面心方向 = sdShell < 0 的那一侧。
       * v5.19：方格尺寸 0.055→**0.032**、拖尾长度 0.26→**0.17** —— 用户说"数据细尾本身
       * 还是过粗了"，细尾要能读作"细流"而不是一片方格地毯。 */
      /* v5.21：拖尾同样要周长/面积补偿 —— 它铺开的是**面积**（∝ front²），比线更容易
       * 在"前沿抵达边缘、整个面都被铺满"的那一刻冲到峰值。故按 shellArc² 收（比线更狠），
       * 读作"数据流随前沿推远而退去"，而不是一张越铺越亮的地毯。同样用 min(..,1.0) 封顶。 */
      float shellTrail = min(dataTrail(-sdShell, azF * 2.5, 0.032, 0.50, vShard * 9.1, 0.17, DATA_TRAIL_DUTY), 1.0)
        * smoothstep(0.03, 0.14, u_shell_form) * shellExit * shellArc * shellArc;
      /* ★ v5.20：这里原来（v5.19）是 float shellWall = crystalWall(sdShell, 0.045);
       * —— 一个**面内环带**，然后当作"柱面"加色。用户第二轮实测直接指出：
       *   「柱面还是没有显现。我怀疑你把柱面加到了那个贴片上面的那个面上，
       *     而不是上下两个五边形脉冲面之间的那个柱面上。」→ 判断全中。
       * 面内色带与顶面**共面**，永远不可能产生"上下关系"；
       * 真正的柱面已改为**真实几何**（五边形管，见 _buildPulseColumns / COLUMN_*），
       * 由深度缓冲负责遮挡 → 这里不再需要任何"假柱面"项。
       * （保留 shellVis 门控，它管的是"板本身显不显现"。） */

      // 闭合态(d≈0)压低 alpha → 透出背后 R=0.96 基准面的五边形轮廓外壳（用户：20–80 能量要看到带轮廓线的外壳）；
      // 展开(d→1)升为实心晶片。碎片 depthWrite=false，基准面先渲染，故透明碎片处轮廓可透出。
      // （closed 已在函数级作用域声明，晶体/基准面两分支共用）
      float alpha = clamp(0.42 + 0.30 * fres + 0.18 * u_deploy, 0.0, 0.92);
      // v5.16：水晶壳渐显前沿 —— c 与 alpha 同乘，未显现处真正不显示
      // v5.19：删掉「1 − 0.55·shellWall」的压暗 —— 柱面改为**画出来**（同色带），
      // 不再靠压暗暗示。柱面在下方单独加色，不受这次门控影响。
      c *= shellVis;
      alpha *= shellVis;
      // v-new（用户选 A）：闭合态碎片退为半透晶纱 —— 预乘(OneFactor)混合下只降 alpha
      // 不压 c 时颜色仍整强度叠加，基准面五边形轮廓照样被冲掉；必须两者同乘。
      float reveal = mix(0.42, 1.0, smoothstep(0.0, 0.40, u_deploy));
      c *= reveal;
      alpha *= reveal;
      /* —— 断裂侧壁的显现门控（v5.5，消除低能态暗轮廓线）——
       * 闭合态相邻片的侧壁严丝合缝地对贴在一起，双面叠加会在每条裂缝处
       * 印出一道暗/亮描边（用户圈出的"低能态暗轮廓线"）。侧壁只在展开后
       * 才有意义（那时它就是碎片的断裂面），因此随 u_deploy 淡入。 */
      /* v5.21：显现门控也要有下限 —— 原 smoothstep(0.02,0.30,u_deploy) 在渐显渐隐
       * 全程（u_deploy=0）恒为 0，把侧壁的 c 与 alpha 一起抹成 0。给 WALL_VIS_FLOOR
       * 后闭合/渐显态侧壁保持可见；内部裂纹侧壁双面贴合的叠加量被压到 0.60 档，
       * 不会重现 v5.5 修掉的"低能态暗轮廓线"。 */
      float wallVis = mix(WALL_VIS_FLOOR, 1.0, smoothstep(0.02, 0.30, u_deploy));
      c *= mix(1.0, wallVis, vWall);
      alpha *= mix(1.0, wallVis, vWall);

      /* —— Round G：撞击的可见化方式彻底换掉（用户定标：不是整片变白、不是冷光）——
       * 旧实现是「命中点一圈冷蓝光斑」（exp(−d²·260)·0.22）。实测撞击频率其实不低
       * （p=0.955 下 ~50 次/秒、同时 69~71 片带 u_impact>0.05），但因为它是 σ≈0.06u
       * 的极细冷点、又被上层结构盖住 —— 用户读成"过几秒才看得见一个碎片被撞"。
       * 新实现：撞击不再直接改这片碎片的颜色，而是**触发本面的脉冲环**（见下面 u_rev
       * 的径向环 + 环内半隐），在 CPU 侧统一排程（_animateDeploy 的面级脉冲）。
       * 因此这里删掉冷光项；u_impact 仅保留为"命中登记"（CPU 侧仍写，供探针观测）。 */
      // 冷色调：随储存粒子量升高，碎片整体轻微变冷（深蓝偏移，封顶）
      vec3 coolShift = vec3(0.74, 0.86, 1.00);          // v-fix：变冷=红绿压暗（更蓝更沉），蓝通道封顶 1.0 —— 旧值 1.45 会把蓝推到 1.22 越过 bloom，储存越多整面越白
      c *= mix(vec3(1.0), coolShift, u_cool);
      alpha = clamp(alpha * (1.0 + 0.12 * u_cool), 0.0, 0.97);

      /* ==================== v5.17：片级撞击脉冲（用户重构） ====================
       * 用户定标："现在粒子打在碎块上，整个碎块面的中心出来一道脉冲，这是完全错误的。
       *   我的构思是：粒子只会打在最外面一圈的碎片上，打中后，以**击中点为中心**，
       *   碎片形状为脉冲线形状向外扩散，直到覆盖满整个碎片，**脉冲不改变碎片任何特性**。"
       *
       * 旧实现的两个错：① 用**面级**径向坐标 vCrackUV.x → 同一面 285 片共享一条前沿，
       * 环从**面心**扫出，正是用户否定的"整个碎块面的中心出来一道脉冲"；
       * ② 带 HIDE_DEPTH 半隐通道 → 会改变碎片（已删，见 v5.16）。
       *
       * 新实现：
       *  · **片级**：u_hitP / u_hitT / u_hitR 是每片私有的（材质逐片克隆）；
       *  · **以击中点为中心**：用 3D 距离 |vObjPos − u_hitP|（两者同为面局部坐标，
       *    片是薄板 → 3D 距离即面内距离，无需构造切空间）；
       *  · **覆盖满整片**：前沿 = u_hitT × u_hitR，u_hitR 由 CPU 按"命中点到最远顶点"
       *    给出 → 走到 1 时线恰好压到最远顶点，整片被扫过；
       *  · **碎片形状为线形**：线本身只在**本片的几何**上绘制，因此天然被片的外形裁切；
       *    另外前沿接近片边界时（u_hitT>0.5）沿**片自身轮廓**（seamEdge）再醒一道条纹，
       *    "碎片形状即脉冲线形状"这一读法由此成立；
       *  · **不改变碎片任何特性**：纯**加色**，不乘 c 的乘性项、不碰 alpha。 */
      if (u_hitT >= 0.0) {
        vec3 hrel = vObjPos - u_hitP;
        float hd = length(hrel);
        float haz = atan(hrel.z, hrel.x);       // 片是薄板 → rel 基本在面内，该角即可用
        float hFront = u_hitT * u_hitR;
        float hsd = crystalLineSDF(hd, haz, hFront, vShard * 5.3,
                                   0.26 * u_hitR, 0.10 * u_hitR);
        /* v5.18：线宽 0.055·u_hitR → **0.024·u_hitR**（用户："撞击……脉冲线宽度都过于大了"）。
         * 峰值由 HIT_LINE_GAIN 0.62 → 1.05 补回 → 更细但更锐，不是更细也更暗。 */
        float hLine = crystalBand(hsd, 0.016 * u_hitR)
          * smoothstep(0.0, 0.12, u_hitT) * (1.0 - smoothstep(0.90, 1.0, u_hitT));
        /* v5.18：往内（指向击中点）的数据流拖尾 —— hsd<0 的一侧是线已扫过的区域。 */
        float hTrail = dataTrail(-hsd, haz * 2.2, 0.042 * u_hitR, 0.62, vShard * 4.7,
                                 0.34 * u_hitR, DATA_TRAIL_DUTY)
          * smoothstep(0.0, 0.12, u_hitT) * (1.0 - smoothstep(0.90, 1.0, u_hitT));
        // 前沿接近片边界 → 沿片自身轮廓再醒一道（"碎片形状即脉冲线形状"）
        float hShape = seamEdge * smoothstep(0.45, 0.90, u_hitT) * (1.0 - smoothstep(0.94, 1.0, u_hitT));
        c += mix(vec3(0.66, 0.88, 1.0), u_emissive_color, 0.22)
           * (hLine + hShape * 0.55) * u_hitGain * (0.45 + 0.55 * lambert);
        // 冰蓝数据细流：冷色、低增益（"少量"）
        c += vec3(0.42, 0.80, 1.0) * hTrail * u_data_trail * (0.35 + 0.65 * lambert);
      }

      /* v5.17：水晶壳显现的**顶面亮折线** —— 放在最末尾叠加，避开上面对 c 的乘性压暗
       * （reveal / shellVis / coolShift），保证"脉冲线"本身是干净锐利的细线。 */
      /* 脉冲线颜色抽出来 —— 柱面必须与顶面**同色**，否则就读成两块不相干的面。 */
      vec3 shellPulseCol = mix(u_emissive_color, vec3(0.82, 0.93, 1.0), 0.45);
      /* v5.21：乘上 shellArc（周长补偿） —— 前沿越长单位亮度越低，抹掉到达边缘时的过冲。 */
      c += shellPulseCol * shellLine * SHELL_FORM_EDGE * shellArc * (0.45 + 0.55 * lambert);
      /* v5.20：柱面（侧壁）**不在这里画** —— 它是真实几何（见 _buildPulseColumns）。
       * 面内加色永远只是"同一平面上的第二道亮带"，用户实测两轮都判为"和面一样"。 */
      /* v5.18：冰蓝数据细流 —— 固定冷色，不掺能量色（数据感与主视觉的暖色分族）。 */
      c += vec3(0.42, 0.80, 1.0) * shellTrail * u_data_trail * (0.35 + 0.65 * lambert);

      // v-fix：最终亮度预算——结构层已钳到 0.85（不触发 bloom），此处仅作安全网，
      // 允许细发光导管（轮廓/边光）越过 1.0 产生辉光但防止失控；阈值从 1.25 提到 1.5
      // 让轮廓线辉光更明显，同时仍远低于原"整壳白雾"量级。
      float _lc = max(max(c.r, c.g), c.b);
      if (_lc > 1.5) c *= 1.5 / _lc;

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
    vec3 body = mix(vec3(0.012, 0.028, 0.048), vec3(0.085, 0.135, 0.205), lambert) * plateVar;   // 冷钢蓝板体（结构冷、能量暖）

    // v4.1 修正：面朝相机时 alpha 只剩 ~0.06，板材完全读不出来（实测截图证实）。
    // 预乘混合下 alpha 是真正的"遮挡力"——底面必须给到 0.30~0.50，凹槽给到 ~0.9，
    // 板缝才能在亮核前面读成"真的缝"，而不是一条若有若无的暗纹。
    // v5：花瓣档（u_petal=1）再抬一档实心度——展开态的折返装甲板若透光，
    // 近侧向视角就会读成"细长透光薄片"（用户圈出的问题之一）。
    float alpha = clamp((u_shell_alpha + 0.24 * u_petal) * (0.85 + 0.15 * rim)
                      + groove * mix(0.38, 0.52, u_petal), 0.0, 0.97);
    float lit = 1.0 - groove;

    /* Round G（R1 修复，实测定位的**主犯**）——
     * 这一支是「基准面 / 内壳」（u_petal≈0.35 走板材路径，panel_mode=1 = 边框+内圈+
     * **中央枢纽**+五条角部锁扣刻线）。下面四条"能量渗光"项**全都没有接能量门控**：
     *   · 缝隙渗光（下面的 pulse 正弦）用 (0.30+0.80·pC)，p=0 时还有 0.74 的功率；
     *   · 且 pulse = 0.78+0.30·sin(u_time·2.1 − rad·6.5) 的相位里带了面内半径 rad
     *     → 亮环沿半径 6.5/2.1 ≈ 3.1 rad/s 向外跑 = 用户看到的"周期往外扩散"；
     *   · mode-1 面板在面心处正好有一圈 apo·0.17 的中央枢纽小五边形 + 5 条锁扣刻线
     *     → 12 个面心各一个常亮小团，且不随能量变。
     * 实测（p=0，1280×900，face-centered 采样）：隐藏 shellInner 后壳带中段亮度
     * 0.422→0.219（−48%），而面心/中段比值 1.35→2.14 —— 即"面心白团"的底噪来自它。
     * 规格本来就要求「<20 能量不显示分割线、整块无痕水晶」，这里补上这道闸：
     * 把所有"能量渗光"乘 appearB（= 轮廓线一次性渐显进度），<0.20 能量整组熄灭。 */
    float appearB = smoothstep(0.0, u_seam_glow_fade, u_seam_form);
    /* —— B1（用户拍板）：把「花纹构造」拆成**静态结构**与**能量渗光**两路 ——
     * 用户定标："初始0能量时：……此时基准面的面上有花纹构造"。
     * 而 R1 修「面心白团」时，把所有项**一并**乘了 appearB（= u_seam_form 总闸），
     * 于是 <0.20 能量下基准面的花纹也是**全灭**的 —— 与用户要求冲突。
     *
     * 拆法：白团的元凶是**时间脉动项**（pulse = 0.78+0.30·sin(u_time·2.1…)，
     * 且功率 (0.30+0.80·pC) 在 p=0 时仍有 0.74），不是静态结构本身。故：
     *   · 静态结构（倒角高光 bevel / 五边形边框 pxLine）→ 改为**部分常亮**
     *     （mix 下限 0.62 / 0.50），0 能量也读得出花纹，且无任何时间脉动；
     *   · 能量渗光（pulse 项 / 能量透照）→ 继续受 appearB 全门控，白团不会复活。 */
    vec3 c = body * u_hard_body * (1.0 - 0.60 * groove);
    // 能量透照：板体带一点自发光，让板材从黑背景里浮出来（叠加项不吃 alpha）
    c += mix(frost, u_emissive_color, 0.5) * (0.05 + 0.07 * pC) * (0.40 + 0.60 * lambert)
       * (1.0 - 0.70 * groove) * u_shell_gain * plateVar * mix(0.14, 1.0, appearB);
    // —— v4.1 核心：板缝的「能量渗光」——
    // 缝不应该是黑的：能量从缝里漏出来，五边形缝以亮线勾勒板面，这才是
    // 高端科幻的读法（v3 的白条突兀，是因为它们不跟随几何；现在缝天然贴合五边形）。
    // 沿缝再叠一个慢速能量脉冲，静帧也能读出"活"的感觉。
    // Round G：脉冲的**空间相位去掉**（原来 rad·6.5 让它沿半径外跑），只留时间脉动，
    // 且整项受 appearB 门控 —— "扩散"这一读法从此只由下面 R4/R5 的脉冲环承担。
    float pulse = 0.78 + 0.30 * sin(u_time * 2.1 + pid * 2.3);
    c += u_emissive_color * groove * (0.30 + 0.80 * pC) * pulse
       * (0.55 + 0.45 * lambert) * (0.65 + 0.35 * plateVar) * appearB;
    // 倒角高光（沿槽沿，随主光方向）—— 这是"金属板材"读感的主要来源，
    // 也是 B1 里**静态花纹**的主力（中央枢纽小五边形 + 5 条角部锁扣刻线的亮边）。
    c += (u_emissive_color * 0.55 + vec3(0.14, 0.17, 0.21)) * bevel * u_shell_gain
       * (0.35 + 0.65 * lambert) * (0.30 + 0.55 * pC) * mix(0.62, 1.0, appearB);
    // v5：花瓣多边形边缘渗光勾边（边缘亮、面略暗 = 金属舱门）。
    // 勾边贴着花瓣几何的真实五边形边界（sdPentagon 以面内切半径求距），
    // 花瓣档全亮；外壳档保留微弱一圈与棱线呼应。
    // B1：同样降为**部分常亮**（0.50）—— 0 能量时五边形边框仍可读。
    c += u_emissive_color * pxLine(sdPentagon(fuv, u_face_apothem * 0.985), 2.3)
       * mix(0.28, 1.00, u_petal) * (0.45 + 0.55 * pC) * (0.55 + 0.45 * lambert)
       * (1.0 + 1.15 * closed) * mix(0.50, 1.0, appearB);   /* 闭合态(20-80 能量)轮廓加亮（冰蓝）—— 透过半透碎片读出带轮廓线的外壳 */

    /* —— v5.2 裂片专属：结构线贴合「片自身的形状」 ——
     * 片外缘（aSeam→1）即裂纹面：能量从裂缝里漏出；其中落在原五边形边界上的
     * （aRim=1）更亮 —— 读作"面框还在"，而内部裂纹只是渗光。
     * aSeam≈0.55 的内嵌环给一道沿片轮廓走的机械刻线，随片形状变化。 */
    if (u_petal > 0.5) {
      // vSeam = 到本片轮廓的距离 / 带宽 W：轮廓（裂纹面）上为 0，≥W 处为 1
      float seamEdge = 1.0 - smoothstep(0.0, 0.85, vSeam);
      // 落在原五边形边界上的（aRim=1）更亮 —— 读作"面框还在"，内部裂纹只是渗光
      c += u_emissive_color * pow(seamEdge, 1.6) * mix(0.65, 1.55, vRim)
         * (0.45 + 0.55 * pC) * (0.40 + 0.60 * lambert) * (1.0 + 0.9 * closed);
      // —— 轻微星云状气流涌动（用户要求：结构片上有气流，起伏随能量）——
      //  物体空间 fbm：片几何原点在面心，vObjPos 不随 mesh 平移/旋转变化 → 气流"贴着片走"；
      //  三轴不同速度的时间漂移让云团缓慢翻涌，而不是整片同步呼吸。
      vec3 np = vObjPos * 3.1 + vec3(u_time * 0.08, -u_time * 0.13, u_time * 0.05);
      float neb = smoothstep(0.30, 0.88, fbm3(np));
      c += frost * neb * (0.05 + 0.12 * pC) * (0.35 + 0.65 * eN)
         * (1.0 - 0.55 * groove);
    }

    c += u_emissive_color * rim * u_shell_gain * (0.20 + 0.50 * pC) * lit;
    c += vec3(1.0) * spec * u_shell_gain * (0.14 + 0.36 * pC) * lit;

    /* ==================== v5.16：基准面的「细线环脉冲 + 擦除式半隐」 ====================
     * 用户定标："上升到达80阈值：……同时每个基准面从中心向外扩散不规则、极薄的细线环脉冲，
     * 脉冲扫过的部分变得半隐，没扫过的部分照旧，最后时整个基准面变得半隐。"
     * 以及 Impact 修订："不要环内半隐，保留脉冲环，但是变细，挑选合适的颜色，不过多占据主视觉。"
     *
     * ★ 这是把原先做在水晶碎块上的「高能周期 / 收回显现」整体搬过来的落点 ——
     *   用户原话："这些行为其实都是要在包裹住核心的基准面上动作的"。
     * ★ 与碎块侧的关键差异：**没有环内暗区**（HIDE_DEPTH 那条已删）。半隐由**擦除前沿**
     *   表达：前沿之内 = 已扫过 = BASE_HIDE_LEVEL，前沿之外 = 照旧；环只是前沿上那道细线。
     * ★ shellInner 是**单 Mesh 单材质**，12 面共一份 uniform —— 面级错相只能在片元里做：
     *   由面法线 vObjNrm 量化后 hash 出 faceSeed（正十二面体每面法线是常量，且面间差异
     *   远大于 1/16 量化步长 → 12 面取值两两不同），再按黄金比错开起跑时刻。 */
    float faceSeed = hash13(floor(normalize(vObjNrm) * 16.0 + 0.5));
    float rb = clamp(length(fuv) / max(u_face_apothem, 1e-6), 0.0, 1.4);
    float azb = atan(fuv.y, fuv.x);
    // v5.17（全局规则）：擦除前沿也走水晶破碎折线 —— 旧式是正弦扰动（平滑、读不出"碎"）
    float bJit = BASE_WIPE_JIT * crystalSegJitter(azb, 8.0, faceSeed * 3.0 + 1.9);
    float bU = clamp((u_revB.x - faceSeed * BASE_FACE_STAGGER)
                     / (1.0 - BASE_FACE_STAGGER), 0.0, 1.0);
    float bFront = (1.0 - pow(1.0 - bU, BASE_WIPE_POW)) * BASE_WIPE_END;
    // bBehind：0 = 已被前沿扫过；1 = 前沿尚未扫到
    float bBehind = smoothstep(bFront - 0.05, bFront + BASE_WIPE_SOFT + bJit, rb);
    // dir=+1 擦除（扫过→半隐，上升 80）；dir=−1 渐显（扫过→恢复，跌破 80）
    float bTarget = (u_revB.y > 0.0) ? bBehind : (1.0 - bBehind);
    float bVis = mix(BASE_HIDE_LEVEL, 1.0, bTarget);
    // 预乘混合：c 与 alpha 同乘，才能真正"半隐"（只降 alpha → 背后亮层透出来反而更亮）
    c *= bVis;
    alpha *= bVis;
    /* 极薄细线环：冷青白（从暖色主视觉里跳出来，又不跟核心的橙抢戏）、σ=0.038、
     * 低增益（BASE_RING_GAIN=0.30，远低于碎块侧曾用过的 0.42/0.62/0.85）。
     * 每面自己的前沿快出界时环自行熄灭 → 不会在外缘留一圈常亮头。 */
    float bBand = exp(-pow((rb - bFront) / BASE_RING_SIGMA, 2.0))
       * u_revB.z * (1.0 - smoothstep(0.80, 1.0, bU));
    c += mix(vec3(0.62, 0.86, 1.0), u_emissive_color, 0.25) * bBand * u_revBGain
       * (0.40 + 0.60 * lambert);

    // v-new：内壳展开淡出 —— premultiplied(OneFactor) 混合下，alpha 缩小不会门控颜色，
    // 必须显式用 u_shell_fade 乘掉 c 与 alpha，基准面才会在 _deploy>0.55 后真正不可见。
    // v5.16（A1）：下限由 0 改为 BASE_GHOST_FLOOR(0.40) —— 用户本轮舍弃了
    // "展开后基准面完全隐藏"的旧设定，改为保留 ~20% 幽灵态（0.40 × BASE_HIDE_LEVEL 0.50）。
    /* v5.17：幽灵态下再给一层**结构线亮度补偿**（u_base_boost）。
     * 起因是用户本轮的问题③："核心+半隐基准面的颜色就变得很暗，一点不像高能状态该有的样子。"
     * u_shell_fade 同时乘 c 与 alpha，于是高能态把基准面的**发光结构线**也一起压暗了。
     * 补偿只作用在颜色（c）上、不作用在 alpha 上 —— 基准面依然是"能看穿的幽灵框架"，
     * 但框架的线是亮的。这就是"半隐但亮"与"半隐且黑"的分界。 */
    c *= u_shell_fade * u_base_boost;
    alpha *= u_shell_fade;

    // v-new：同晶体分支的亮度预算上限，板材同样防炸白
    float _lc = max(max(c.r, c.g), c.b);
    if (_lc > 1.25) c *= 1.25 / _lc;

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
      emit += vec3(1.0) * eGain * 0.10 * fil * temp * temp;  // 白热丝（有节制；提一档增强湍流结构可读性）

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
  /* —— v5.17：核心透屏系数 contain 的**方向反了**（用户本轮报的问题③）——
   * 用户原话："能量大于80后，内部核心的颜色非常暗，同时我发现，能量刚到阈值的时候
   *   整体还是亮的，但是过一会儿之后核心+半隐基准面的颜色就变得很暗，
   *   一点不像高能状态该有的样子。"
   *
   * 根因：旧式 contain = mix(0.26, 0.14, smoothstep(0, 1, _deploy)) ——
   * **展开进度越大，核心越暗**（0.26 → 0.14，−46%）。而 _deploy 正是"跨过 0.80 之后
   * 花 ~1.9s 才爬到 1 的" → 用户看到的就是"刚跨阈值（_deploy≈0）整体还亮，
   * 过一会儿（_deploy→1）核心变暗"。这是纯时间效应，与能量值无关。
   *
   * 语义本来就该相反：闭合态要把热**封在壳内**（避免"每个面心白团"—— 碎块是加色半透，
   * 亮核会 50% 透染整个构造体）；**展开后核心暴露，就该炽亮**。故改为随 _deploy 上抬。
   * 另叠一个仅在高能段生效的曝光补偿（safeParam 越高越亮）。 */
  float contain = mix(CORE_CONTAIN_LO, CORE_CONTAIN_HI, smoothstep(0.0, 1.0, u_deploy));
  float coreExpose = mix(1.0, CORE_EXPOSE_HI, smoothstep(0.70, 1.0, safeParam));
  vec3 c = plasma * contain * coreExpose;
  c += u_emissive_color * eGainCore * rim * 0.55 * u_plasma_gain * contain * coreExpose;
  c += vec3(1.0) * specP * eGainCore * 0.08 * u_plasma_gain;
  /* v5.21c：核心亮度上限 —— 硬钳（旧式 if (_lc>2.6) c *= 2.6/_lc，注意旧式那句
   * 本身写在模板字符串里，注释里绝不能再用反引号包代码 —— 会直接截断 GLSL 字符串）
   * 换成**软拐点**。
   * 硬钳把所有越界像素压成同一个值（2.6 的平板），相对结构在这一步就被抹平，
   * 再经 bloom 就是一张均匀白盘 = 用户说的"这坨屎 / 超新星爆发变成一团白色光团"。
   * 软压保留亮度序关系 → 只有最亮的湍流丝越过 bloom 阈值，结构活得下来。 */
  float _lc = max(max(c.r, c.g), c.b);
  if (_lc > CORE_KNEE) {
    float _k = CORE_KNEE + CORE_HEAD * (1.0 - exp(-(_lc - CORE_KNEE) / CORE_HEAD));
    c *= _k / _lc;
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

/* ------------------------------------------------------------------ *
 *  约束场辉光（v5.1）：面向相机的环形软辉光板
 *  球膜方案的失败教训：菲涅尔边缘环 = 完美圆形 + 自转不可见 = "两个静止同心圆"。
 *  辉光板全剖面无硬边（不可能读成圆环），旋转由亮度瓣承担（真正可见）。
 * ------------------------------------------------------------------ */
const FIELD_GLOW_VERT = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FIELD_GLOW_FRAG = /* glsl */ `
precision highp float;
uniform float u_time;
uniform vec3 u_color;
uniform float u_gain;
uniform float u_pC;
uniform float u_eN;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 4.6;              // 世界单位坐标（板宽 4.6u）
  float r = length(p);
  // 环形软剖面：内圈 0.9u 前几乎为 0（不糊核心），峰值 ~1.25u，2.05u 衰减到 0
  float band = smoothstep(0.80, 1.20, r) * (1.0 - smoothstep(1.30, 2.05, r));

  /* —— 两层反向旋转的亮度瓣 ——
   * v5.1 的失败：lobeA/lobeB 只有 ±20% / ±12% 的**浅调制**，乘在一片本就很暗的
   * 加色辉光上 → 绝对亮度差只有 ~0.05，经 ACES 压平后彻底不可见（用户："完全没看出来"）。
   * v5.2 改为**深调制**：瓣谷压到 0.22（几乎是黑的缺口），瓣峰接近 1.2，
   * 再叠 3 瓣逆时针 / 5 瓣顺时针的异速拍频 —— 亮度差达到 8 倍以上，必然可读。 */
  float az = atan(p.y, p.x) + 0.35 * r;    // 轻微螺旋剪切：臂是弯的，不可能读作同心圆
  float l3 = pow(0.5 + 0.5 * sin(az * 3.0 - u_time * 0.62), 1.7);
  float l5 = pow(0.5 + 0.5 * sin(az * 5.0 + u_time * 0.41 + 1.7), 2.2);
  float lobes = 0.22 + 0.95 * (0.62 * l3 + 0.38 * l5);

  // 沿半径向外流的波纹（v5.1 的 0.06 对比度实测完全不可见 → 提到 0.28 / 0.14 双频）
  float ripple = (0.72 + 0.28 * sin(r * 9.0 - u_time * 1.35))
               * (0.86 + 0.14 * sin(r * 21.0 - u_time * 2.10));

  float a = u_gain * band * lobes * ripple * u_pC;   // Round F：去掉 0.30 基线 —— 能量为 0 时 u_pC=0 整层熄灭，消除周期白团扩散
  a = clamp(a, 0.0, 1.4) * 0.48;
  // v5.7：eN 项由 0.55 压到 0.26 —— 高能量态这一层是最容易把整帧顶进白区的贡献者
  vec3 c = u_color * a * (0.80 + 0.26 * u_eN);
  gl_FragColor = vec4(c, a);
}
`;

/* ------------------------------------------------------------------ *
 *  能量环流（v5.7 重写）：星云雾带 + 粒子 —— 没有任何「导管」
 *  用户判定：① 高能量态一片白（导管白热芯线是元凶之一）；
 *          ② 环状区域不该由管道标明，应由**粒子 + 星云雾气共同形成**；
 *          ③ 覆盖半径要继续增大；④ 能量到 0.8 时走一段固定 ~1s 的成形动画。
 *  本版删除 RING_TUBE（精密导管）全部代码，改为粗管径环体上的雾丝着色。
 * ------------------------------------------------------------------ */


/* 粒子：GPU 顶点着色器解算环行位置；粒子散布在**雾带的整个截面**内（不是排成一条线），
 * 与雾丝共同构成环状构造 —— 没有管道，粒子本身就是环的一部分。 */
const RING_FLOW_VERT = /* glsl */ `
precision highp float;
attribute float aTheta0;     // 初相
attribute float aSpeed;      // 角速度（含随机分布 → 有层次但连续的流）
attribute float aCrossA;     // 截面相位（雾带横截面内的角度）
attribute float aCrossR;     // 截面半径 [0,1)（sqrt 分布 → 面内均匀，不堆在芯部）
attribute float aSpin;       // 截面内缓慢漂移角速度 → 粒子在雾里游走
attribute float aSize;       // 点精灵尺寸（像素）
attribute float aSeed;       // [0,1) 随机种子
uniform float u_time;
uniform float u_form;
uniform float u_ringR;
uniform float u_outerR;
uniform float u_tubeR;
uniform float u_gain;
varying float vA;
float easeOutCubic(float x) { x = clamp(x, 0.0, 1.0); return 1.0 - pow(1.0 - x, 3.0); }
void main() {
  // 入场：每颗粒子按 aSeed 错峰汇入（u_form*1.25 - aSeed*0.25）
  float form = easeOutCubic(clamp(u_form * 1.25 - aSeed * 0.25, 0.0, 1.0));
  float Rr = mix(u_outerR, u_ringR, form);
  // 螺旋汇入：u_form 越小附加偏转角越大，随贴合消失；方向与该环流向一致
  float swirl = (1.0 - form) * (1.4 + 2.2 * fract(aSeed * 7.31)) * sign(aSpeed);
  float theta = aTheta0 + swirl + u_time * aSpeed;
  // 截面内位置：沿环向的雾丝里均匀分布 + 缓慢漂移（读作"雾中的尘埃"而非"轨道上的车"）
  float ca = aCrossA + u_time * aSpin;
  float cr = aCrossR * u_tubeR * (0.55 + 0.45 * form);
  float dr = cr * cos(ca);
  float dy = cr * sin(ca) + (1.0 - form) * (fract(aSeed * 3.97) - 0.5) * 0.85;
  vec3 pos = vec3(cos(theta) * (Rr + dr), dy, sin(theta) * (Rr + dr));
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.60 + 0.40 * sin(u_time * (1.8 + 2.6 * fract(aSeed * 5.13)) + aSeed * 61.7);
  // 外缘淡出：与雾带剖面同步，避免出现一圈"粒子壳"硬边
  float edge = 1.0 - smoothstep(0.58, 1.0, aCrossR);
  vA = tw * edge * (0.20 + 0.80 * form) * u_gain;
  gl_PointSize = aSize;
}
`;

const RING_FLOW_FRAG = /* glsl */ `
precision highp float;
uniform vec3 u_color;
varying float vA;
void main() {
  // 软圆点精灵（径向衰减）—— 绝不允许 PointsMaterial 默认的方块点
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float fall = pow(1.0 - r * 2.0, 2.1);
  gl_FragColor = vec4(u_color, fall * vA);
}
`;

/* ==================== Phase1b：环境能量粒子（吸附/冷却载体） ====================
 * 环绕构造体漂浮的能量粒子；逐帧向随机碎片吸附，命中即回收重生并令该碎片 stored++。
 * 软圆点精灵 + 加色辉光（绝不出现 PointsMaterial 默认方块点）。 */
const AMBIENT_VERT = /* glsl */ `
precision highp float;
attribute float aAlpha;
attribute float aSize;
uniform float u_time;
uniform float u_zoom;             // 正交放大倍率：粒子像素尺寸随结构同步放大，缩放后相对大小不变
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // 轻微闪烁，读作"活的能量尘"而非死点
  float tw = 0.70 + 0.30 * sin(u_time * 3.0 + position.x * 5.3 + position.y * 2.1);
  vA = aAlpha * tw;
  gl_PointSize = aSize * u_zoom;  // v-fix：4× 放大下不再缩成看不见的细点
}
`;

const AMBIENT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 u_color;
uniform float u_gain;
varying float vA;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float fall = pow(1.0 - r * 2.0, 2.4);
  gl_FragColor = vec4(u_color, fall * vA * u_gain);
}
`;

/* 流星拖尾：每粒子一条 prev→curr 的线段（aFade：head=1 / tail=0），加色极细 */
const TRAIL_VERT = /* glsl */ `
precision highp float;
attribute float aFade;
uniform float u_fade;
varying float vF;
void main() {
  vF = aFade * u_fade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRAIL_FRAG = /* glsl */ `
precision highp float;
uniform vec3 u_color;
varying float vF;
void main() {
  gl_FragColor = vec4(u_color, vF * 0.5);  // 极细微流星拖尾
}
`;

function dodeca(radius) {
  const g = new THREE.DodecahedronGeometry(radius, 0);
  g.computeVertexNormals(); // 非索引几何 → 逐面法线，保留多面体棱面
  return g;
}

/**
 * 沿正十二面体 30 条棱生成加色管体（硬表面发光棱）
 * @param {number} radius 外接半径
 * @param {number} tube 管半径（u）
 */
function edgeRods(radius, tube) {
  const base = dodeca(radius);
  const edges = new THREE.EdgesGeometry(base, 1);
  const pos = edges.attributes.position;
  const parts = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();

  for (let i = 0; i < pos.count; i += 2) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    dir.subVectors(b, a);
    const len = dir.length();
    if (len < 1e-6) continue;
    const g = new THREE.CylinderGeometry(tube, tube, len, 6, 1, true);
    q.setFromUnitVectors(up, dir.clone().normalize());
    mid.addVectors(a, b).multiplyScalar(0.5);
    g.applyQuaternion(q);
    g.translate(mid.x, mid.y, mid.z);
    parts.push(g);
  }
  base.dispose();
  edges.dispose();
  return parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
}

/** 水晶矿物底色（冰白）：水晶的"材质身份"，低饱和 → 不参与撞色 */
const CRYSTAL_ICE = new THREE.Color(0xe2ecff);

export class L5Core {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'L5_FusionCore';

    this.uniforms = {
      u_main_param: { value: 0.0 },
      u_time: { value: 0.0 },
      u_phase: { value: 0.0 },
      u_emissive_intensity: { value: 1.2 },
      u_emissive_color: { value: new THREE.Color(0x00f2fe) },
      u_shell_alpha: { value: 0.35 },
      u_shell_id: { value: 0.0 },
      u_roughness: { value: 0.05 },
      u_metalness: { value: 0.10 },
      // 体积等离子核
      u_ray_dir_local: { value: new THREE.Vector3(0, 0, -1) },
      u_core_radius: { value: R_CORE },
      u_core_inradius: { value: R_CORE * DODEC_INRADIUS_RATIO },
      u_vol_steps: { value: 32 },
      u_density: { value: 7.0 },
      // 约束场 / 硬壳
      u_ring_axis: { value: new THREE.Vector3(0.35, 1.0, 0.15) },
      u_ring_freq: { value: 3.2 },
      u_ring_speed: { value: 0.55 },
      u_layer_gain: { value: 0.0 },
      u_panel_freq: { value: 5.0 },
      u_panel_freq2: { value: 11.0 },
      u_seam_px: { value: 1.10 },
      u_seam2_px: { value: 0.70 },
      u_hard_body: { value: 1.0 },
      // v4 面局部板材
      u_face_apothem: { value: R_SHELL_OUT * 0.491105 },
      u_panel_mode: { value: 0.0 },
      u_bump: { value: 0.85 },
      u_petal: { value: 0.0 },
      u_core_layer: { value: 0.0 },   // v5.3：裂片内芯发光层（多层绘制的第 2 层，加色）
      // v5.6：水晶色**不写死** —— 每帧由强调色派生（同色相、低饱和、高明度 → 再向冰白拉）。
      // 之前固定紫罗兰与橙色几乎互补，撞色最狠（用户："根本不融合"）。
      u_crystal_tint: { value: new THREE.Color(0xdfeaff) },
      u_deploy: { value: 0.0 },       // v5.4：展开进度 → 驱动水晶色差与断口亮度
      u_shell_fade: { value: 1.0 },   // v-new：内壳整体淡出系数（0=完全不可见；与 u_shell_alpha 解耦，真正门控颜色）
      u_seam_form: { value: 0.0 },    // v5.9：轮廓线渐显进度（阈值触发、固定时长，与能量无关）
      u_seam_glow_fade: { value: 1.0 },  // v5.15：总闸过渡宽度（1.0=全程平滑；0.10=旧的尾端悬崖）
      u_crack_mul: { value: 1.0 },     // v5.10：水晶加色项消融系数（诊断用，默认 1）
      u_pulse_gate: { value: 0.0 },     // v5.11：轮廓线脉冲（阈值后循环扩散）
      u_pulse_speed: { value: 0.55 },
      u_core_gain: { value: 1.0 },
      u_core_struct_k: { value: CORE_STRUCT_K },   // v5.18：内芯层结构窗口下移量
      u_data_trail: { value: DATA_TRAIL_GAIN },     // v5.18：数据流拖尾增益
      u_body_gain: { value: 1.0 },      // v5.11：裂片本体亮度档（调参/消融用，默认 1）
      u_seam_w: { value: 0.40 },        // v5.11：轮廓环衰减跨度（原硬编码 0.85）
      u_seam_amp: { value: 1.0 },       // v5.11：轮廓线底线幅度倍率
      u_wall_amp: { value: 1.0 },       // v5.11：断口反光倍率
      u_burst: { value: 0.0 },          // v5.12：0.80 轮廓线爆发包络
      u_burst_c: { value: 0.5 },        // v5.12：爆发中心（触发瞬间冻结的脉冲相位）
      u_burst_w: { value: 0.05 },       // v5.12：爆发已向两侧铺开的半宽
      u_pulse_gain: { value: 1.0 },     // v5.13：循环脉冲幅度倍率
      // Round G：面内径向脉冲（v5.16：只剩 R4 撞击一路）—— 默认"未启用"，由裂片各自覆盖
      u_rev: { value: new THREE.Vector4(REVEAL_FRONT_END, 0, 0, 0) },
      u_revGain: { value: 0.0 },
      // v5.16：20 阈值 —— 水晶壳"由每个面心向外不规则脉冲渐显"的前沿进度 0→1
      u_shell_form: { value: 0.0 },
      // v5.16：基准面（shellInner）的细线环脉冲 + 擦除式半隐
      u_revB: { value: new THREE.Vector4(1.0, -1.0, 0.0, 0.0) },  // x=行程 y=方向 z=环增益
      u_revBGain: { value: BASE_RING_GAIN },
      u_base_boost: { value: 1.0 },     // v5.17：幽灵态结构线亮度补偿（基准面专属）
      /* v5.18：抬升/浮动写在顶点着色器里，VERT 被**所有**材质共用，
       * 因此必须在主 uniform 里给出默认 0 —— 除基准面外的一切都保持不动。
       * 基准面用的是 shellInnerUniforms 里的独立副本（见下方），不共享引用。 */
      u_lift: { value: 0.0 },
      u_float_amp: { value: 0.0 },
      // v5.17：片级撞击脉冲（每片材质克隆后独立）
      u_hitP: { value: new THREE.Vector3(0, 0, 0) },
      u_hitT: { value: -1.0 },
      u_hitR: { value: 0.1 },
      u_hitGain: { value: 1.0 },
      // v3 光照预算（默认值由无头像素探针标定得出）
      u_plasma_gain: { value: 0.12 },           // v-fix：再降亮（0.28→0.12）—— 用户要求移除面心白团/雾气，核心只保留极暗余烬
      u_field_gain: { value: 1.90 },           // 差分实测提升后两层薄壳才够可见（原 0.85 只有 +8%）
      u_shell_gain: { value: 1.00 },
      u_rod_gain: { value: 1.00 },
      u_cam_forward: { value: new THREE.Vector3(0, 0, -1) }
    };

    /** 复制共享 uniform 引用后覆盖本层私有项（共享项仍同步） */
    const fork = (overrides) => Object.assign({}, this.uniforms, overrides);

    /** 硬壳材质：预乘 alpha 混合（spec §2 半透明手写着色，非 three 标准材质） */
    const _shellMaterial = (uniforms) => new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,                  // 预乘：color 已含 alpha
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation
    });
    this._shellMaterial = _shellMaterial;

    /* ---------- 内层：等离子核 ---------- */
    this.coreMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: false,
      depthWrite: true,
      depthTest: true
    });
    this.coreMesh = new THREE.Mesh(dodeca(R_CORE), this.coreMaterial);
    this.coreMesh.name = 'L5_Core_Inner';
    this.coreMesh.renderOrder = 30;

    /* ---------- 规格外层：硬壳（0.96 / 1.00，预乘混合） ---------- */
    // v5.2：这一套 uniform 现在只服务于「外甲裂片」（外壳已被裂片完全取代）
    this.shellUniforms = fork({
      u_shell_id: { value: 1.0 },
      u_panel_freq: { value: 5.0 },
      u_panel_freq2: { value: 11.5 },
      u_seam_px: { value: 1.10 },
      u_seam2_px: { value: 0.70 },
      u_hard_body: { value: 1.0 },
      u_layer_gain: { value: 0.0 },
      u_panel_mode: { value: 2.0 },   // 裂片档：结构线由片自身轮廓环承担
      u_petal: { value: 1.0 }        // 裂片档：更实心 + 轮廓渗光 + 星云气流
    });
    // 内壁只是壁厚的内表面。若内外壁共用一套 uniforms，双面 + 双层几何会在同一区域
    // 叠加两层面板缝噪声，既抬亮又糊。故内壁用独立的、低得多的 shell_gain。
    this.shellInnerUniforms = Object.assign({}, this.uniforms, {
      u_shell_id: { value: 1.0 },
      u_shell_alpha: { value: this.uniforms.u_shell_alpha.value },  // v5.13e：独立副本，供展开时淡出（不再与裂片共享）
      u_panel_freq: { value: 5.0 },
      u_panel_freq2: { value: 11.5 },
      u_seam_px: { value: 1.10 },
      u_seam2_px: { value: 0.70 },
      u_hard_body: { value: 1.0 },
      u_layer_gain: { value: 0.0 },
      u_shell_gain: { value: 0.28 },
      u_shell_fade: { value: 1.0 },  // v-new：独立副本 —— 内壳展开淡出（不共享引用，避免误伤其他材质）
      u_petal: { value: 0.35 },     // 内壳：略实心、有边缘勾边，但不吃裂片专属的星云气流
      /* v5.16：基准面的细线环脉冲 —— **必须独立副本**。
       * shellInnerUniforms 是 Object.assign 的浅拷贝，若沿用 this.uniforms.u_revB，
       * 基准面与裂片会共享同一个 Vector4 实例（基准面根本没有裂片那一路，但
       * fork 出去的其他材质会读到同一对象）→ 必须隔离。 */
      u_revB: { value: new THREE.Vector4(1.0, -1.0, 0.0, 0.0) },
      u_revBGain: { value: BASE_RING_GAIN },
      u_base_boost: { value: 1.0 },   // v5.17：独立副本 —— 只给基准面，不污染其他材质
      /* v5.18：抬升/浮动的独立副本 —— 只有基准面抬升，碎片与内芯层必须纹丝不动。
       * shellInnerUniforms 是 Object.assign 浅拷贝，若沿用 this.uniforms.u_lift
       * 就会和所有 fork 出去的材质共享同一个对象 → 整个外壳一起抬起来。 */
      u_lift: { value: 0.0 },
      u_float_amp: { value: BASE_FLOAT_AMP }
    });
    this.shellMaterial = this._shellMaterial(
      this.shellUniforms
    );
    this.shellInnerMaterial = this._shellMaterial(this.shellInnerUniforms);

    /* ---------- 内壳（0.96u）：完整不变形 ---------- *
     * v5.2 起，展开动作由**外甲**承担（用户："外甲打开…"）。外甲裂片推开后，
     * 这一层就是被显露出来的内层结构，与散热鳍/能量环一起构成"打开后的内部"。 */
    this.shellInnerUniforms.u_face_apothem.value = R_SHELL_IN * 0.491105;
    this.shellInnerUniforms.u_panel_mode.value = 1.0;
    this.shellInner = new THREE.Mesh(dodeca(R_SHELL_IN), this.shellInnerMaterial);
    this.shellInner.name = 'L5_Shell_Inner';
    this.shellInner.renderOrder = 31;

    /* ---------- 外甲（1.00u）：沿结构线裂开的结构片（v5.2 设计 / v5.3 修订） ----------
     * 每个五边形面沿其结构线裂成 20~26 片大小不一的结构片（v5.3 加密碎化，
     * 12 面共 ~285 片），闭合态严丝合缝拼回完整十二面体外甲。
     * 激发态：沿面法线**平行向外推开**（用户明确否决铰链翻转与绕轴旋转），
     * 只保留上下浮动 —— 同频行波，相位 ∝ 片到面中心距离，见 _animateDeploy。
     *
     * v5.3 水晶质感 = **每片两层绘制叠加**（不再一次成型）：
     *  · 第 1 层（本体，本材质）：几何棱面起伏（zOf）+ 逐面片真实法线 → 硬高光随
     *    棱面跳变，读作水晶棱面而不是玻璃平板；
     *  · 第 2 层（fragCoreMaterial，同一几何缩放 0.86、加色叠加）：体内能量核，
     *    fbm 云团呼吸，透过半透明本体渗出 → "晶体里封着光"的层次感。 */
    this.fragCoreUniforms = fork({
      u_shell_id: { value: 1.0 },
      u_panel_mode: { value: 2.0 },
      u_petal: { value: 1.0 },
      u_core_layer: { value: 1.0 }
    });
    this.fragCoreMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.fragCoreUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending
    });
    this.fragments = buildFaceFragments(R_SHELL_OUT).map((f) => {
      // Phase1c：每片克隆材质，持有独立的 u_impact / u_cool（共享 uniform 经 fork 引用同步）。
      // v-fix（关键回归修复）：克隆基准必须是**裂片预设 shellUniforms**（u_petal=1 → 晶体分支），
      // 而不是主 uniforms（u_petal=0 → 装甲/等离子分支）。首版所有片直接共享 this.shellMaterial
      // （晶体分支生效）；Phase1c 引入逐片克隆时误以 fork(主 uniforms) 为基准，导致全部 285 片
      // 静默掉进装甲/等离子分支 —— 晶体分支里所有"碎片恒为冰蓝"的修正从未在碎片上运行，
      // 高能量时被 u_emissive_color 染成橙色（用户"水晶碎片被染成橙色"的真正根因，探针实测定案）。
      const fUniforms = Object.assign({}, this.shellUniforms, {
        u_impact: { value: new THREE.Vector4(0, 0, 0, 0) },
        u_cool: { value: 0.0 },
        /* Round G（v5.16 起碎块侧已无面级事件，保留字段以兼容探针探针读取） */
        u_rev: { value: new THREE.Vector4(REVEAL_FRONT_END, 0, 0, 0) },
        u_revGain: { value: 0.0 },
        /* v5.17：**片级撞击脉冲**（用户重构：以击中点为中心、沿碎片形状向外扩散、
         * 直到覆盖满整片，且**不改变碎片任何特性**）。
         * u_hitP = 命中点（片局部/面局部坐标，与 vObjPos 同系）
         * u_hitT = 行程 −1 = 空闲，0→1 = 前沿自击中点推进到 u_hitR */
        u_hitP: { value: new THREE.Vector3(0, 0, 0) },
        u_hitT: { value: -1.0 },
        u_hitR: { value: 0.1 },
        u_hitGain: { value: HIT_LINE_GAIN }
      });
      const fMat = this._shellMaterial(fUniforms);
      const mesh = new THREE.Mesh(f.geo, fMat);
      mesh.name = 'L5_FaceFragment';
      mesh.renderOrder = 32;
      mesh.position.copy(f.faceCenter);
      const core = new THREE.Mesh(f.geo, this.fragCoreMaterial);
      core.name = 'L5_FragCore';
      core.renderOrder = 34;          // 本体(32)之后画：内芯叠在晶体表面之下
      core.scale.setScalar(0.86);     // 相对面心缩小 → 藏在晶体体内
      mesh.add(core);
      this.group.add(mesh);
      return { ...f, mesh, core, mat: fMat, stored: 0, impactW: 0 };
    });

    /* Phase1e：外缘环吸附目标 —— 粒子只撞"每个面边缘的那一环碎片"（轮廓线把面分成的环）。
     * ① 预计算每片在面局部坐标里的质心：几何原点在面心，mesh.position 只是面心位置，
     *    直接拿它当目标 = 全部粒子涌向面中心（上一版的根因）；
     * ② radialN² 累积权重：外缘环碎片被捕获的概率占绝对主导。 */
    this._fragW = [];
    this._fragRingIdx = [];
    this._fragRingW = [];
    this._faceShards = [];          // Round G：按面索引的裂片表（面级脉冲一次写全这一面）
    for (let k = 0; k < 12; k++) this._faceShards.push([]);
    /* v5.19：按面索引的**最外圈**碎片表 —— 撞击队列按面组织，
     * 才能做"每个转动间隔内本面外圈每片至少一次"的保证（全局池做不到）。 */
    this._faceRing = [];
    let _wAcc = 0, _ringWAcc = 0;
    for (let fi = 0; fi < this.fragments.length; fi++) {
      const f = this.fragments[fi];
      const c = new THREE.Vector3();
      const pa = f.geo.getAttribute('position');
      /* ★ Round G-fix（真 bug，实测定位）：这里原先是
       *     for (k…) c.fromBufferAttribute(pa, k);
       *   —— `fromBufferAttribute` 是**赋值**不是**累加**，循环结束后 c 只剩最后一个顶点，
       *   再乘 1/顶点数 → |centroid| ≈ 5e-4，等于质心恒为 0。
       *   实测（probe_g5attrs）：285 片的 |centroid| ∈ [0, 0.0008]，而 radialN ∈ [0,1]。
       *   后果有两个，都不是小事：
       *     ① R3「撞击点改到每个面最外一圈碎片」形同未实现 —— 1864 行的撞击目标是
       *        `f.mesh.position + f.centroid`，mesh.position 正是**面心**，加上 ~0 之后
       *        目标还是面心：粒子依旧全部汇聚到面心（这正是 R3 要修的现象）。
       *        注意 _pickFragmentIndex 选中的**索引**确实是外圈片（radialN≥0.72），
       *        所以 old 探针只看索引就"验证通过"了 —— 位置却没用上，是个假阳性。
       *     ② u_impact 的命中坐标恒为 (0,0,0) → 命中登记点永远在面心。
       *   顶点平均 = 片质心（碎片是薄凸板，顶点平均足够），原点与几何一致 = 面心。 */
      for (let k = 0; k < pa.count; k++) { c.x += pa.getX(k); c.y += pa.getY(k); c.z += pa.getZ(k); }
      f.centroid = c.multiplyScalar(1 / Math.max(1, pa.count));   // 片局部坐标（原点 = 面心）
      f.faceSeed = (fi * 0.6180339887) % 1.0;                     // 每片确定性相位种子（半隐扩散用）
      /* v5.17（撞击脉冲重构）：预计算**片包围半径** = 质心到最远顶点的距离。
       * 用途：粒子命中时以"命中点到最远顶点"为脉冲行程 → 走到 1 时恰好覆盖满整片
       * （用户定标："向外扩散，直到覆盖满整个碎片"）。 */
      {
        let r2max = 0;
        for (let k = 0; k < pa.count; k++) {
          const dx = pa.getX(k) - f.centroid.x;
          const dy = pa.getY(k) - f.centroid.y;
          const dz = pa.getZ(k) - f.centroid.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2max) r2max = d2;
        }
        f.boundR = Math.sqrt(r2max);
      }
      /* v5.19（储能粒子流）：预计算**片内正交基** t1/t2（都垂直于面法线）。
       * 能量粒子要"在水晶里面绕圈"，轨道平面就必须躺在碎片所在的面平面上；
       * 每帧现算正交基太浪费，且会引入不一致 → 建片时算一次。 */
      {
        const nx = f.normal.x, ny = f.normal.y, nz = f.normal.z;
        let ax = 0, ay = 1, az = 0;
        if (Math.abs(ny) > 0.9) { ax = 1; ay = 0; az = 0; }
        let t1x = ay * nz - az * ny, t1y = az * nx - ax * nz, t1z = ax * ny - ay * nx;
        const l1 = Math.hypot(t1x, t1y, t1z) || 1e-6;
        t1x /= l1; t1y /= l1; t1z /= l1;
        const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
        f.t1 = new THREE.Vector3(t1x, t1y, t1z);
        f.t2 = new THREE.Vector3(t2x, t2y, t2z);
      }
      /* v5.19（撞击队列）：预取 3 个**片内**采样点（质心 → 随机顶点 的 35%~85% 处），
       * 供队列定时发射的命中脉冲当作"击中点"。
       * 目的：命中点必须**逐次不同**（否则每次都在同一处，一眼假），
       * 且必须落在片内（否则脉冲覆盖不到整片）。用顶点内插而不是纯随机方向 ——
       * 后者会落到片外，脉冲半径仍然覆盖，但读起来像"从空气里冒出来的"。 */
      {
        f.hitPts = [];
        for (let s = 0; s < 3; s++) {
          const k = (Math.random() * pa.count) | 0;
          const t = 0.35 + Math.random() * 0.50;
          f.hitPts.push(new THREE.Vector3(
            f.centroid.x + (pa.getX(k) - f.centroid.x) * t,
            f.centroid.y + (pa.getY(k) - f.centroid.y) * t,
            f.centroid.z + (pa.getZ(k) - f.centroid.z) * t));
        }
      }
      if (this._faceShards[f.faceIdx]) this._faceShards[f.faceIdx].push(f);
      _wAcc += 0.06 + f.radialN * f.radialN;
      this._fragW.push(_wAcc);
      // Round F：粒子只被每个面最外一圈碎片吸附。
      // v5.17：阈值 0.72 → HIT_OUTER_RADIAL(0.86) —— 用户定标"粒子只会打在最外面一圈的
      // 碎片上"。0.72 会把"中间环"的片也纳进来，撞击点就散布到面中部了。
      if (f.radialN >= HIT_OUTER_RADIAL) {
        this._fragRingIdx.push(fi);
        _ringWAcc += f.radialN * f.radialN;
        this._fragRingW.push(_ringWAcc);
        /* v5.19：**按面**分组的外圈池 —— 撞击队列是"每个转动间隔内，本面外圈每片至少
         * 一次"，所以必须按面组织，全局池做不到"每面各一次"这个保证。 */
        (this._faceRing[f.faceIdx] ?? (this._faceRing[f.faceIdx] = [])).push(fi);
      }
    }
    /* 兜底：若阈值抬高后池为空（radialN 分布不达预期），退回 0.72，
     * 否则 _pickFragmentIndex 会走全池分支 → 粒子撞到面心片，正是本轮要修的现象。 */
    if (this._fragRingIdx.length === 0) {
      _ringWAcc = 0;
      for (let fi = 0; fi < this.fragments.length; fi++) {
        const f = this.fragments[fi];
        if (f.radialN >= 0.72) {
          this._fragRingIdx.push(fi);
          _ringWAcc += f.radialN * f.radialN;
          this._fragRingW.push(_ringWAcc);
        }
      }
    }
    this._ringPoolN = this._fragRingIdx.length;
    this._ringMinRadial = this._fragRingIdx.length
      ? Math.min(...this._fragRingIdx.map((i) => this.fragments[i].radialN)) : -1;
    this._fragWTotal = _wAcc;
    this._fragRingWTotal = this._fragRingW.length ? this._fragRingW[this._fragRingW.length - 1] : 0;

    /* ---------- 能量环流 ×2（v5 全新实现：精密导管 + 粒子流 + 入场汇聚） ---------- */
    // 环几何平铺在 XZ 平面（环轴 = Y），倾斜/进动全部由 Group 的欧拉角控制。
    //  v5.7 —— 环状构造由「星云雾带 + 粒子」共同形成，**没有任何管道**：
    //  · 雾带：粗管径环体（tube = 0.26·R）上的雾丝着色 —— 截面软剖面 + 沿环向拉长的
    //    ridged 噪声 → 一缕缕雾气；外缘 smoothstep 归零 → 数学上不存在管壁轮廓。
    //  · 粒子：分布在雾带的**整个截面**内并缓慢漂移，与雾丝互为表里。
    //  · 覆盖半径：1.30u → 1.95u（用户要求继续增大）。
    //  · 成形：能量越过 0.80 触发一段**固定 1.0s** 的变换动画（雾气自外围汇聚收束），
    //    成形结束后进入正常环绕旋转（见 _animateDeploy）。
    this.ringGroups = [];
    const RING_R = R_SHELL_OUT * 1.95;
    const WISP_TUBE = RING_R * 0.26;
    const FLOW_COUNT = 420;
    const ringDefs = [
      { tilt: 0.42, speed: 0.55, phase: 0.0, formPhase: 0.00, flow: 0.055, flowDir: 1.0 },
      { tilt: -0.62, speed: -0.40, phase: 2.1, formPhase: 0.22, flow: -0.042, flowDir: -1.0 }
    ];
    for (const def of ringDefs) {
      const g = new THREE.Group();
      g.name = 'L5_ConstraintRing';
      g.visible = false;

      const uColor = { value: new THREE.Color(0x00f2fe) };   // 雾带与粒子共享，每帧同步强调色


      // —— 粒子（散布于雾带截面内）——
      const theta0 = new Float32Array(FLOW_COUNT);
      const spd = new Float32Array(FLOW_COUNT);
      const crossA = new Float32Array(FLOW_COUNT);
      const crossR = new Float32Array(FLOW_COUNT);
      const spin = new Float32Array(FLOW_COUNT);
      const size = new Float32Array(FLOW_COUNT);
      const seed = new Float32Array(FLOW_COUNT);
      for (let i = 0; i < FLOW_COUNT; i++) {
        const r1 = Math.random(), r2 = Math.random(), r3 = Math.random();
        theta0[i] = (i / FLOW_COUNT) * Math.PI * 2 + (r1 - 0.5) * 0.10;
        spd[i] = def.flowDir * (0.45 + 0.75 * r2 * r2);   // 平方分布：多数慢、少数快 → 层次感
        crossA[i] = r1 * Math.PI * 2;
        crossR[i] = Math.sqrt(r3);                        // sqrt → 截面内均匀，不堆在芯部
        spin[i] = (r2 - 0.5) * 0.22;                      // 截面内缓慢漂移
        // 尺寸平方分布：多数中小、少数大 —— 密而不糊
        size[i] = 2.6 + 3.6 * r2 * r2;
        seed[i] = r3;
      }
      const flowGeo = new THREE.BufferGeometry();
      flowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FLOW_COUNT * 3), 3));
      flowGeo.setAttribute('aTheta0', new THREE.BufferAttribute(theta0, 1));
      flowGeo.setAttribute('aSpeed', new THREE.BufferAttribute(spd, 1));
      flowGeo.setAttribute('aCrossA', new THREE.BufferAttribute(crossA, 1));
      flowGeo.setAttribute('aCrossR', new THREE.BufferAttribute(crossR, 1));
      flowGeo.setAttribute('aSpin', new THREE.BufferAttribute(spin, 1));
      flowGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      flowGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      const flowUniforms = {
        u_time: { value: 0 },
        u_form: { value: 0 },
        u_ringR: { value: RING_R },
        u_outerR: { value: RING_R * 1.55 },
        u_tubeR: { value: WISP_TUBE },
        u_gain: { value: 0 },
        u_color: uColor
      };
      const flowMat = new THREE.ShaderMaterial({
        vertexShader: RING_FLOW_VERT,
        fragmentShader: RING_FLOW_FRAG,
        uniforms: flowUniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending
      });
      const flow = new THREE.Points(flowGeo, flowMat);
      flow.name = 'L5_Ring_Flow';
      flow.renderOrder = 34;
      flow.frustumCulled = false;      // 位置由顶点着色器解算，包围球不可信
      g.add(flow);

      this.group.add(g);
      this.ringGroups.push({ group: g, def, flow, flowUniforms, uColor });
    }

    /* ---------- 约束场辉光（v5.1：取代双层球膜） ----------
     * v5 失败教训：球体菲涅尔的"锐利边缘环"在轮廓处就是一个**完美圆形**，且菲涅尔
     * 只依赖视角 —— 球体自转在视觉上完全不可见，必然读作"两个静止同心圆"。
     * v5.1 改为一块始终面向相机的辉光板：
     *   · 环形软剖面：内圈 0.9u 前几乎为 0（不糊核心），峰值 ~1.25u，2.05u 衰减到 0
     *     —— 全剖面无一条硬边，数学上不可能读成圆环；
     *   · 两层反向旋转的亮度瓣（3 瓣 / 2 瓣，异速）—— 自转真正可见；
     *   · 沿半径的极低对比细波纹（0.06）随时间外流，给"场"以活性。 */
    this.fieldGlowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        u_time: { value: 0 },
        u_color: { value: new THREE.Color(0x00f2fe) },
        u_gain: { value: 1.0 },
        u_pC: { value: 0.55 },
        u_eN: { value: 0.60 }
      },
      vertexShader: FIELD_GLOW_VERT,
      fragmentShader: FIELD_GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    this.fieldGlow = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), this.fieldGlowMaterial);
    this.fieldGlow.name = 'L5_FieldGlow';
    this.fieldGlow.renderOrder = 29;      // 先于核心(30)绘制：核心/外壳从深度上盖住内圈
    this.fieldGlow.userData.noGlowMask = true;  // 方形平面绝不能进辐射掩膜（会被糊成方形光晕）
    this.group.add(this.fieldGlow);
    this._qGlow = new THREE.Quaternion(); // 广告牌反向旋转专用

    /* ---------- Phase1b：环境能量粒子（吸附/冷却载体） ---------- */
    this._ambientLayerOn = true;  // 层级开关：能量粒子层是否启用（setLayer 可关）
    this._ambFade = 0;            // v-fix：能量粒子层入场/退场透明度（>0.80 阈值渐显，避免突兀）
    this._COOL_PER = 0.011;       // 每储存 1 粒子 → 冷色调增量
    this._COOL_MAX = 0.5;         // 冷色调封顶（轻微变冷，不过度）
    this._FRAG_STORE_CAP = 60;    // 单碎片粒子储存上限（冷色调饱和后不再增）
    this._IMPACT_FADE = 0.55;     // v-fix：受击冷光衰减时长（秒）—— 略延长使撞击可读，仍不糊面
    this._faceAbsorbed = new Array(12).fill(0);  // Phase1d：每面吸收粒子之和
    this.buildAmbientParticles();
    this._buildChargeField();   // v5.19：储能态能量粒子流（依赖 fragments / t1 / t2，须在其后）

    /* ---------- v5.20：脉冲柱面（真实几何侧壁） ---------- */
    this.pulseColumnMaterial = new THREE.ShaderMaterial({
      uniforms: {
        u_color: { value: new THREE.Color(0.82, 0.93, 1.0) },
        u_gain: { value: 0.0 }
      },
      vertexShader: `
        varying float vZ;
        void main() {
          vZ = uv.y;                       // 0 = 下沿（基准面），1 = 上沿（晶体板顶面）
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 u_color;
        uniform float u_gain;
        varying float vZ;
        void main() {
          /* 顶沿最亮、向下渐隐 —— 读作"从板底漫下来的光"。
           * 没有任何均匀常数底：越靠近基准面越暗 → 与"雾"彻底分家。 */
          float g = mix(0.34, 1.0, smoothstep(0.0, 1.0, vZ));
          g *= smoothstep(0.0, 0.10, vZ);
          gl_FragColor = vec4(u_color * u_gain * g, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });
    // 每面几何计划（含 e1/e2 面内基、apo、五边形顶点方位、板的 z 范围）
    this._facePlans = [];
    for (let fi = 0; fi < 12; fi++) this._facePlans.push(buildFaceFracturePlan(R_SHELL_OUT, fi));
    this._faceApoUnit = this._facePlans[0] ? this._facePlans[0].apo / R_SHELL_OUT : 0;
    this._buildPulseColumns();


    /* ---------- ★ v5.21e：「棱线光导管」L5_Rods_Core 已**整体移除** ----------
     * 它原是沿核心正十二面体（R_core = 0.8u）30 条棱铺的加色实体圆柱
     * （`edgeRods(R_CORE, 0.015)`，管径 0.03u）。历次用户反馈：
     *   · "这一堆莫名其妙加上去的粗线是什么"（v5.21 全量视角）
     *   · "我很好奇这些白色的刻线是什么……我记得我从来没要求过这种刻线吧"（只留基准面）
     *   · "这个光导管已经严重影响视觉效果了"（v5.21e）
     * 判定：该元素从未在任何一轮定标里被要求，且在 30 棱 + 加色 + 跟随核心微抖动
     * 的组合下必然读作"与面无关的乱线"。故**不留开关、不留死代码**，整体删除；
     * 相关引用（材质 / 逐帧颜色驱动 / 抖动跟随 / 层级开关 / dispose）一并清掉。
     * 若将来真要做"硬表面发光棱"，重做时须：贴在**基准面的棱**上（与外甲对齐）、
     * 线宽 ≤2px、亮度压在 bloom 阈值以下、且不跟随核心抖动。 */

    /* ---------- 约束框骨架：前框 + 后框幽灵 ---------- */
    const cageGeo = new THREE.EdgesGeometry(dodeca(R_SHELL_OUT), 1);
    this.cageMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(0x38bdf8),
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.cage = new THREE.LineSegments(cageGeo, this.cageMaterial);
    this.cage.name = 'L5_Cage';
    this.cage.renderOrder = 33;

    this.cageGhostMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(0x38bdf8),
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
    this.cageGhost = new THREE.LineSegments(cageGeo, this.cageGhostMaterial);
    this.cageGhost.name = 'L5_Cage_Ghost';
    this.cageGhost.renderOrder = 29;

    this.group.add(
      this.coreMesh,
      this.shellInner, ...this.fragments.map((f) => f.mesh),
      this.cage, this.cageGhost
    );

    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._deploy = 0;    // 内壳展开进度 0→1（带缓动，见 sync()）
    this._faceRot = [];  // v5.13b：齿轮卡位自转的面级状态机（按 faceIdx 索引）
    this._rotBusy = false;       // v5.13c：仍在走格/回归中 → 冻结收拢（先回原位再降）
    this._retHoldT = 0;          // v5.13d：掉能后的收拢冻结计时（上限 FRAG_RET_HOLD）

    /* —— Round G：面级「脉冲环 + 半隐扩散」状态（R4/R5 共用）——
     * 每面一条：半隐脉冲（一 shot，前沿 0→1.35）与显现脉冲（一 shot，前沿 0→1.35）。
     * 相位按面错开（黄金比）→ 12 个面不同时做同一件事（用户否掉过"整壳同时变亮"）。 */
    this._faceRev = [];
    for (let k = 0; k < 12; k++) {
      this._faceRev.push({
        phase: (k * 0.6180339887) % 1.0,   // 高能周期的面间错相（黄金比 → 12 面不同时做同一件事）
        /* 撞击脉冲（一次性）。impT = -1 表示空闲；impDur 由 triggerImpactPulse 填。
         * 注：旧版这里叫 hideT/hideDur/hideAmt/ringGain，_animateDeploy 重写后已不用，
         * 留着会让"哪些字段是真的"看不出来 —— 直接清掉。 */
        impT: -1,
        impDur: IMPACT_PULSE_DUR,
        // 输出到 u_rev / u_revGain 的面级状态（_writeFaceRev 读）
        front: REVEAL_FRONT_END, amt: 0, ring: 0, kind: 'idle',
        lastImpactAt: -99
      });
    }
    /* v5.16 基准面脉冲状态：prog = 擦除/渐显行程（1 = 已完成），dir = +1 擦除 / −1 渐显。
     * 初始 (1, −1) = "渐显已完成" = 基准面完全可见 —— 这就是 <0.80 的静止态。 */
    this._baseProg = 1;
    this._baseDir = -1;
    this._basePulseBusy = false;
    this._revImpGap = 0;       // 撞击可见环的全局限流计时
    this._revStats = { cycling: 0, impacting: 0, frontAvg: 0, hiddenFrac: 0 };
  }

  /* ==================== Phase1b：环境能量粒子系统 ==================== */
  buildAmbientParticles() {
    const COUNT = 600;
    const pos = new Float32Array(COUNT * 3);
    const aAlpha = new Float32Array(COUNT);
    const aSize = new Float32Array(COUNT);
    const A = {
      COUNT, pos, aAlpha, aSize,
      /* Round G（R2）：粒子状态机
       *   0 = INBOUND  —— 从**场外**（3.1~4.5u）缓动汇聚进环流带（入场）
       *   1 = CRUISE   —— 在环流带里公转巡航（1.75~2.70u）
       *   2 = CAPTURE  —— 被外缘环碎片捕获，螺旋俯冲 → 撞击
       *   3 = RETURN   —— 撞击后从命中点**缓动**回到环流带（回收）
       *   （离场不是 mode：退场由 updateAmbientParticles 里的 exitK 分支统一接管，
       *     对**所有** mode 生效并由 u_gain 渐隐 —— 所以 mode 4 从未被赋值，
       *     这里把旧的 "4 = EXIT" 声明去掉，避免"声明有 5 态、实际只有 4 态"的假象。
       *     modeHisto 的第 5 桶恒为 0 属正常。）
       * 用户要求："入场、离场、回收都应从场外缓动汇聚到构造体周围"——
       * 关键是**任何状态切换都不许改位置**，只有缓动轨迹。 */
      mode: new Int8Array(COUNT),           // 0=inbound 1=cruise 2=capture 3=return
      target: new Int32Array(COUNT).fill(-1),
      timer: new Float32Array(COUNT),
      orbR: new Float32Array(COUNT),        // 环流轨道半径
      orbTh: new Float32Array(COUNT),       // 环流相位
      orbW: new Float32Array(COUNT),        // 角速度（含方向，与环流同量级）
      orbY: new Float32Array(COUNT),        // 轨道高度基线
      orbSeed: new Float32Array(COUNT),     // 摆动种子
      inT: new Float32Array(COUNT),         // 入场计时
      inDur: new Float32Array(COUNT),       // 入场时长
      retT: new Float32Array(COUNT),        // 回收计时
      retDur: new Float32Array(COUNT),      // 回收时长
      retSX: new Float32Array(COUNT), retSY: new Float32Array(COUNT), retSZ: new Float32Array(COUNT),  // 回收起点
      retTX: new Float32Array(COUNT), retTY: new Float32Array(COUNT), retTZ: new Float32Array(COUNT)   // 回收终点（环上）
    };
    this._amb = A;
    this._ambPrev = new Float32Array(A.COUNT * 3);  // v-fix：流星拖尾上一帧位置
    for (let i = 0; i < COUNT; i++) this._spawnAmbient(i);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        u_time: { value: 0 },
        u_zoom: { value: 1.0 },   // v-fix：正交缩放倍率（setZoom 注入），粒子尺寸随结构同步放大
        u_color: { value: new THREE.Color(0x66c2ff) },   // v-fix：冷青蓝（旧 0x9ad8ff 偏白）
        u_gain: { value: 1.0 }
      },
      vertexShader: AMBIENT_VERT,
      fragmentShader: AMBIENT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.ambientPoints = new THREE.Points(geo, mat);
    this.ambientPoints.name = 'L5_AmbientParticles';
    this.ambientPoints.frustumCulled = false;
    this.ambientPoints.renderOrder = 33;
    this.group.add(this.ambientPoints);

    /* v-fix：流星拖尾几何（每粒子 2 顶点：tail / head） */
    const tgeo = new THREE.BufferGeometry();
    const tpos = new Float32Array(COUNT * 2 * 3);
    const tfade = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) { tfade[i * 2] = 0.0; tfade[i * 2 + 1] = 1.0; }
    tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
    tgeo.setAttribute('aFade', new THREE.BufferAttribute(tfade, 1));
    const tmat = new THREE.ShaderMaterial({
      uniforms: {
        u_time: { value: 0 },
        u_color: { value: new THREE.Color(0x66c2ff) },
        u_fade: { value: 0.0 }
      },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.ambientTrails = new THREE.LineSegments(tgeo, tmat);
    this.ambientTrails.name = 'L5_AmbientTrails';
    this.ambientTrails.frustumCulled = false;
    this.ambientTrails.renderOrder = 32;
    this.ambientTrails.visible = false;
    this.group.add(this.ambientTrails);
  }

  /* ==================== v5.19：储能态能量粒子流 ==================== *
   * 用户原话："粒子撞击水晶碎块后，脉冲覆盖的同时，水晶进入储能态，表现是水晶内有
   *   能量粒子在规律流动和发光（**需要粒子来模拟能量粒子流**）。"
   *
   * 设计要点：
   *  · 必须是**真实粒子**（Points），不是着色器里的假流动 —— 用户明确点名要粒子；
   *  · "**规律**流动" = 匀速圆周 + 等分相位（每片 CHARGE_PER_FRAG 颗，相位均分 2π/K）
   *    → 读作有组织的环流，而不是乱窜的尘埃；
   *  · 轨道平面 = 碎片所在的**面平面**（法线 = f.normal，片内正交基 t1/t2 预计算），
   *    再加一点沿法线的起伏 → 粒子真的"在水晶里"，不是贴在表面；
   *  · 只有被击中过（stored ≥ 1）的片才亮 → 储能态是**逐片**的，不是整个壳一起。 */
  _buildChargeField() {
    const K = CHARGE_PER_FRAG;
    const N = this.fragments.length * K;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const al = new Float32Array(N);
    const sz = new Float32Array(N);
    for (let i = 0; i < N; i++) sz[i] = 1.6 + Math.random() * 1.4;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(al, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: {
        u_time: { value: 0 },
        u_zoom: { value: 1.0 },
        u_color: { value: new THREE.Color(0.42, 0.80, 1.0) },  // 冰蓝能量色
        u_gain: { value: 1.0 }
      },
      vertexShader: AMBIENT_VERT,
      fragmentShader: AMBIENT_FRAG,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending
    });
    this.chargePoints = new THREE.Points(g, m);
    this.chargePoints.name = 'L5_ChargeFlow';
    this.chargePoints.frustumCulled = false;
    this.chargePoints.renderOrder = 41;      // 在碎片之上叠加（碎片 depthWrite=false）
    this.group.add(this.chargePoints);
    // 每片一个确定性相位偏移，避免所有片的粒子同步（否则读作"整体一起转"）
    this._chargePhase = new Float32Array(this.fragments.length);
    for (let i = 0; i < this.fragments.length; i++) {
      this._chargePhase[i] = ((i * 0.6180339887) % 1.0) * Math.PI * 2.0;
    }
  }

  /** 逐帧推进储能粒子：位置随碎片（平移 + 齿轮自转）走，亮度随储存量渐入。 */
  updateChargeField(simTime, zoom) {
    const pts = this.chargePoints;
    if (!pts) return;
    const pa = pts.geometry.attributes.position;
    const aa = pts.geometry.attributes.aAlpha;
    pts.material.uniforms.u_time.value = simTime;
    if (zoom) pts.material.uniforms.u_zoom.value = zoom;
    const K = CHARGE_PER_FRAG;
    const v = this._cv || (this._cv = new THREE.Vector3());
    let active = 0;
    for (let fi = 0; fi < this.fragments.length; fi++) {
      const f = this.fragments[fi];
      const st = f.stored || 0;
      const on = st >= CHARGE_MIN_STORED;
      if (on) active++;
      // 亮度随储存量渐入（6 次打满），避免"刚中一发就全亮"
      const lvl = Math.min(1, st / 6);
      const bw = f.boundR || 0.05;
      for (let k = 0; k < K; k++) {
        const i = fi * K + k;
        if (!on) { aa.array[i] = 0; continue; }
        const ang = this._chargePhase[fi] + simTime * CHARGE_OMEGA + k * (Math.PI * 2 / K);
        const rr = bw * (CHARGE_RADIUS_LO
          + (CHARGE_RADIUS_HI - CHARGE_RADIUS_LO) * (((fi + k) % 3) / 2));
        /* 片内坐标 → 世界：先按片自身旋转（齿轮自转），再加上 mesh 位置。
         * 用 matrixWorld 一步到位最稳（含父级 Group 变换），代价是滞后一帧，不可见。 */
        v.set(
          f.centroid.x + f.t1.x * Math.cos(ang) * rr + f.t2.x * Math.sin(ang) * rr
            + f.normal.x * Math.sin(ang * 2.0) * bw * 0.14,
          f.centroid.y + f.t1.y * Math.cos(ang) * rr + f.t2.y * Math.sin(ang) * rr
            + f.normal.y * Math.sin(ang * 2.0) * bw * 0.14,
          f.centroid.z + f.t1.z * Math.cos(ang) * rr + f.t2.z * Math.sin(ang) * rr
            + f.normal.z * Math.sin(ang * 2.0) * bw * 0.14
        );
        f.mesh.localToWorld(v);
        pa.array[i * 3] = v.x; pa.array[i * 3 + 1] = v.y; pa.array[i * 3 + 2] = v.z;
        aa.array[i] = lvl * (0.55 + 0.45 * (k === 0 ? 1 : 0.7));
      }
    }
    pa.needsUpdate = true;
    aa.needsUpdate = true;
    this._chargeStats = { active, total: this.fragments.length, gain: 1 };
  }

  /* ==================== v5.20：脉冲柱面（真实几何的侧壁） ==================== *
   * 见文件顶部 COLUMN_* 的说明。要点：
   *  · 每面一根**五边形管**（5 边、无端盖），轴向 = 该面法线；
   *  · 半径取该面五边形**外接半径**（与晶体板边缘对齐），方位对齐该面第 0 个顶点；
   *  · 下沿钉在基准面（R_SHELL_IN + u_lift），上沿钉在晶体板顶面
   *    （R_SHELL_OUT 面半径 + 该面平均抬升 off + CRYST_Z1）→ 高度随板上升而长；
   *  · 颜色与脉冲线同源（u_emissive_color ↔ 冰蓝的 0.45 混合），更暗 → 亮顶面 + 同色暗侧壁；
   *  · renderOrder = 30（在基准面 31 / 碎片 32 之前）→ 柱面画在板的**后面**，
   *    加色合成下读作"板下面的一圈厚度"，而不是糊在板顶面上。 */
  _buildPulseColumns() {
    this.pulseColumns = [];
    if (!this._faceApoUnit) return;
    for (let fi = 0; fi < 12; fi++) {
      const P = this._facePlans[fi];
      if (!P) { this.pulseColumns.push(null); continue; }
      const Rc = P.apo / Math.cos(Math.PI / 5) * COLUMN_R_GAIN;   // 五边形外接半径
      const g = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);   // 无端盖 → 只见侧壁
      g.rotateX(Math.PI / 2);                                      // 轴 +Y → +Z（局部 Z = 面法线）
      g.rotateZ(P.vertAz[0] + Math.PI / 2);                        // 顶点 0 对齐该面五边形顶点
      g.scale(Rc, Rc, 1);                                          // 半径定型；高度留给 scale.z
      const mesh = new THREE.Mesh(g, this.pulseColumnMaterial);
      mesh.name = 'L5_PulseColumn_' + fi;
      /* ★★ 绘制次序是这里最容易翻车的地方（实测踩了两次，见 skill）：
       *   · 全场景 depthWrite:false，遮挡完全由**绘制顺序**决定；
       *   · 更狠的是**晶体板用预乘混合**（blendDst = OneMinusSrcAlpha）——
       *     板会把**它之前画的所有像素**按 (1−alpha) 乘一遍，而板 alpha 高达 0.42~0.92
       *     → 任何画在板**之前**的层等于被整片抹掉。
       * 实测：renderOrder 给 30 / 31.5（板 32 之前）时，柱面 gain 拉到 6.0，
       *   全屏 Δmean 只有 ±0.0001（等于没有），甚至因为"板压暗"而更暗。
       * 故必须画在板**之后**：取 33（碎片 32 之后、片内芯 34 之前）。
       * 柱面本来就在板的外围/下方，画在板之后不会遮住板的顶面。 */
      mesh.renderOrder = 33;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.pulseColumns.push({
        mesh, normal: P.center.clone().normalize(), apoUnit: P.apo / R_SHELL_OUT,
        z0: P.CRYST_Z0, z1: P.CRYST_Z1
      });
    }
  }

  /** 逐帧：把柱面钉在两块板之间。gap 由「基准面抬升 + 晶体板上升」共同决定。 */
  updatePulseColumns(simTime) {
    const cols = this.pulseColumns;
    if (!cols) return;
    const sf = this.uniforms.u_shell_form ? this.uniforms.u_shell_form.value : 0;
    // 板（= 水晶壳）出现后柱面才存在；不随脉冲前沿回落 → 它是板的"厚度"，不是脉冲
    const env = THREE.MathUtils.smoothstep(sf, 0.05, 0.45);
    const lift = this.shellInnerUniforms ? this.shellInnerUniforms.u_lift.value : 0;
    const rotGate = THREE.MathUtils.smoothstep(this._deploy, 0.60, 0.95);
    const em = this.uniforms.u_emissive_color ? this.uniforms.u_emissive_color.value : null;
    // 与 GLSL 里 shellPulseCol 完全同源：mix(u_emissive_color, (0.82,0.93,1.0), 0.45)
    const col = this._columnColor || (this._columnColor = new THREE.Color());
    if (em) col.setRGB(
      em.r * 0.55 + 0.82 * 0.45,
      em.g * 0.55 + 0.93 * 0.45,
      em.b * 0.55 + 1.00 * 0.45);
    else col.setRGB(0.82, 0.93, 1.0);
    this.pulseColumnMaterial.uniforms.u_color.value.copy(col);

    /* ★ v5.21c：**柱高归一** —— 修"水晶碎片一往外推就直接超新星爆发变成一团白色光团"。
     * 柱面是**加色**几何，而它的高度随展开从静止的 0.038 涨到 ≈0.20（面积 ×5.3）：
     *   · 面积 ∝ h        → 展开时加色总量线性上涨；
     *   · 12 根一起涨、且提亮后每根再吃 bloom → 整块壳外缘变成一圈白光 = "超新星"。
     * 这与核心的 contain 上涨是**同一时刻**发生的（都由 _deploy 驱动）→ 两个叠加。
     * 修法：以静止柱高 COLUMN_H0 为基准，超出部分按 1/(1 + k·超量) 收回单位亮度 ——
     * 于是「面积×亮度」在展开全程基本恒定，柱子只是**变长**，不会**变亮**。 */
    const hs = []; let hSum = 0, hN = 0;
    for (let fi = 0; fi < cols.length; fi++) {
      const c = cols[fi];
      if (!c) { hs.push(null); continue; }
      const grp = this._faceRot ? this._faceRot[fi] : null;
      const offFace = (grp && grp.offN) ? grp.offSum / grp.offN : 0;   // 该面平均抬升
      const dBase = c.apoUnit * R_SHELL_IN + lift;                     // 基准面（含抬升）
      const dTop = c.apoUnit * R_SHELL_OUT + offFace + c.z1;           // 晶体板顶面
      hs.push({ h: Math.max(COLUMN_MIN_H, dTop - dBase), dBase, grp });
      hSum += hs[hs.length - 1].h; hN++;
    }
    const hAvg = hN ? hSum / hN : COLUMN_H0;
    const hOver = Math.max(0, hAvg / COLUMN_H0 - 1);
    const hComp = 1 / (1 + COLUMN_H_COMP * hOver);
    const gain = COLUMN_GAIN * env * hComp;
    this.pulseColumnMaterial.uniforms.u_gain.value = gain;
    this._columnStats = { env: +env.toFixed(3), lift: +lift.toFixed(4),
      gain: +gain.toFixed(3), hAvg: +hAvg.toFixed(4), hComp: +hComp.toFixed(3), h: [] };

    for (let fi = 0; fi < cols.length; fi++) {
      const c = cols[fi];
      if (!c) continue;
      const on = gain > 0.001;
      c.mesh.visible = on;
      if (!on) continue;
      const { h, dBase, grp } = hs[fi];
      const mid = dBase + h * 0.5;
      c.mesh.position.copy(c.normal).multiplyScalar(mid);
      /* ★★ v5.21 修的**致命**朝向 bug：
       * 原来是 `quaternion.setFromAxisAngle(c.normal, grp.angle * rotGate)` ——
       * 这只是**绕法线自转**，完全没有把柱面的轴从局部 +Z 转到该面的法线方向！
       * 结果 12 根管子全部朝着世界 +Z（互相平行），贴在各自面心处 →
       * 合成视图里根本读不出"某个面的侧壁"，这正是用户说的
       * "两个面中间我没有看到任何侧壁"的直接原因（M1 隔离测试能看见，
       * 是因为那时 12 根平行管在空场景里没有参照物）。
       * 正确做法：先 setFromUnitVectors 把 +Z 转到面法线，再绕（已经指向法线的）
       * 局部 Z 叠加面旋转角 —— 面内自转才是"齿轮转动"该有的效果。 */
      c.mesh.quaternion.setFromUnitVectors(COL_AXIS_Z, c.normal);
      const spin = (grp ? grp.angle : 0) * rotGate;
      if (spin) c.mesh.rotateZ(spin);
      c.mesh.scale.set(1, 1, h);
      this._columnStats.h.push(+h.toFixed(3));
    }
  }

  /** 按 radialN² 加权随机选一片碎片（0.06 基数保证面心片偶被选中，不出现死区）。
   *  radialN∈[0,1]（0=面心片，1=外缘片）→ 平方加权后绝大多数落在外缘环。 */
  _pickFragmentIndex() {
    // Round F：从外缘环捕集池（radialN>=0.72）按 radialN^2 加权选片 → 100% 命中面最外圈
    if (this._fragRingWTotal <= 0) {
      const t0 = Math.random() * this._fragWTotal;
      let lo = 0, hi = this._fragW.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (t0 < this._fragW[mid]) hi = mid; else lo = mid + 1; }
      return lo;
    }
    const t = Math.random() * this._fragRingWTotal;
    const w = this._fragRingW;
    let lo = 0, hi = w.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t < w[mid]) hi = mid; else lo = mid + 1; }
    return this._fragRingIdx[lo];
  }

  /** 把第 i 颗粒子**从场外**送入（R2 入场）：出生在 3.1~4.5u 的远场，
   *  以 easeOutCubic 在 1.1~2.3s 内汇聚到自己的环流轨道半径上 —— 读作
   *  "能量从场外被吸入、汇入环流"，而不是凭空出现在轨道上（旧版是 pop-in）。
   *  汇聚到位后才转入巡航，巡航计时到期再被外缘环碎片捕获。 */
  _spawnAmbient(i) {
    const A = this._amb, ix = i * 3;
    const r = 1.75 + Math.random() * 0.95;        // 1.75~2.70u：环流带外延（汇聚终点）
    const th = Math.random() * Math.PI * 2;
    A.orbR[i] = r;
    A.orbTh[i] = th;
    A.orbW[i] = (Math.random() < 0.5 ? -1 : 1) * (0.30 + 0.55 * Math.random());
    A.orbY[i] = (Math.random() * 2 - 1) * 1.15;   // 球状包络，不是平面圆盘
    A.orbSeed[i] = Math.random();
    A.mode[i] = 0;                                // 0 = INBOUND（从场外汇聚）
    A.inT[i] = 0;
    A.inDur[i] = 1.1 + 1.2 * Math.random();
    A.timer[i] = 0.4 + Math.random() * 1.8;
    A.aAlpha[i] = 0.0;
    A.aSize[i] = 0.8 + 1.0 * Math.random() * Math.random();   // v-fix：细小微粒（用户要求细小如背景粒子，而非放大成浆糊；u_zoom 等比放大保持 4× 可见）
    A.target[i] = -1;
    // 出生点：远场（3.1~4.5u），方位与轨道一致但高度更散
    const r0 = 3.10 + 1.40 * Math.random();
    A.pos[ix]     = Math.cos(th) * r0;
    A.pos[ix + 1] = (Math.random() * 2 - 1) * 1.9;
    A.pos[ix + 2] = Math.sin(th) * r0;
    // v-fix：重生时把拖尾上一帧位置对齐到新位置，避免跨场景跳变拉出长拖尾
    if (this._ambPrev) { this._ambPrev[ix] = A.pos[ix]; this._ambPrev[ix + 1] = A.pos[ix + 1]; this._ambPrev[ix + 2] = A.pos[ix + 2]; }
  }

  /**
   * 每帧更新环境粒子（Round G 重排为 5 态；**任何切换都不改位置，只改轨迹**）：
   *   0 INBOUND 远离场外 3.1~4.5u → easeOutCubic 汇聚到环流带（R2 入场）
   *   1 CRUISE  在环流带公转（"在能量环流中绕结构体旋转"）
   *   2 CAPTURE 被**每个面最外一圈**碎片捕获：保留切向分量螺旋卷入 + 引力式加速 → 撞击
   *   3 RETURN  撞击后从命中点**缓动**回到环流带（R2 回收；旧版被读成瞬移）
   *   4 EXIT    层退场时向外缓动远离并渐隐（R2 离场）
   *  撞击点 = 目标碎片质心（面局部坐标）—— vObjPos 原点在面心，必须同一坐标系；
   *  上一版直接拿 mesh.position（=面心）当目标，才有了"全都汇聚到面中心"。
   */

  /** 正交相机放大倍率：粒子像素尺寸需随结构同步放大，否则 4× 下缩成看不见的细点。
   *  u_zoom 直接取 zoom（结构被放大 zoom 倍，粒子也放大 zoom 倍 → 相对大小不变）。 */
  setZoom(z) {
    this._zoom = z;
    if (this.ambientPoints && this.ambientPoints.material) {
      this.ambientPoints.material.uniforms.u_zoom.value = z;
    }
    if (this.chargePoints && this.chargePoints.material) {
      this.chargePoints.material.uniforms.u_zoom.value = z;   // v5.19：储能粒子同步放大
    }
  }

  updateAmbientParticles(simTime, dt) {
    // 门控：① 层开关必须开启；② 能量未过 0.80 阈值则不显示（粒子只在高能态涌入）
    /* Round G：阈值不再 0.4s 硬收 —— 入场 0.6s 渐显，**离场改为 1.4s 渐隐**，
     * 期间粒子向外缓动退出（"离场也从构造体周围散回场外"），不再是原地消失。 */
    const wantOn = this._ambientLayerOn && this._energyP >= DEPLOY_START;
    if (wantOn) this._ambFade = Math.min(1.0, (this._ambFade ?? 0) + dt / 0.6);
    else        this._ambFade = Math.max(0.0, (this._ambFade ?? 0) - dt / 1.4);
    this.ambientPoints.visible = this._ambFade > 0.01;
    this.ambientPoints.material.uniforms.u_gain.value = this._ambFade;
    if (this.ambientTrails) {
      this.ambientTrails.visible = this.ambientPoints.visible;
      this.ambientTrails.material.uniforms.u_fade.value = this._ambFade;
    }
    if (!wantOn && this._ambFade <= 0.01) return;
    if (this.ambientTrails) this.ambientTrails.material.uniforms.u_time.value = simTime;
    const A = this._amb;
    const n = A.COUNT;
    const P = A.pos;
    const fr = this.fragments;
    const step = Math.min(dt, 0.05);
    // 离场权重：0 → 1（越接近消失越向外推），让"退场"读成有方向的散开
    const exitK = wantOn ? 0 : 1.0 - Math.min(1, this._ambFade);
    const modeHisto = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const ix = i * 3;
      modeHisto[A.mode[i]]++;

      /* —— ④ EXIT：层退场 —— 沿径向/球向外缓动远离 + 渐隐，不改变方位角 —— */
      if (exitK > 0) {
        const rr = Math.hypot(P[ix], P[ix + 2]) || 1e-3;
        const grow = (1.0 + 0.85 * exitK) * step * (0.9 + 0.5 * A.orbSeed[i]);
        P[ix] *= (rr + grow) / rr;
        P[ix + 2] *= (rr + grow) / rr;
        P[ix + 1] += P[ix + 1] * grow / Math.max(0.2, rr * 1.2);
        A.aAlpha[i] = Math.min(A.aAlpha[i], 0.06 + 0.34 * (1.0 - exitK));
        continue;
      }

      if (A.mode[i] === 0) {
        /* —— 0 INBOUND：从场外汇聚进环流带（easeOutCubic）——
         * 位置由 "远场出生点 → 轨道点" 的缓动插值给出，而不是直接设到轨道上。 */
        A.inT[i] += step;
        const k = Math.min(1, A.inT[i] / A.inDur[i]);
        const e = 1.0 - Math.pow(1.0 - k, 3);
        A.orbTh[i] += A.orbW[i] * step * 0.6;             // 汇聚途中已经带着环向速度
        const rT = A.orbR[i], rA = Math.hypot(A.pos[ix], A.pos[ix + 2]) || 1e-3;
        const rNow = rA + (rT - rA) * Math.min(1, e * 1.05);
        const th = A.orbTh[i];
        const yT = A.orbY[i] + 0.22 * Math.sin(th * 2.0 + A.orbSeed[i] * 31.0);
        P[ix]     = Math.cos(th) * rNow;
        P[ix + 1] = P[ix + 1] + (yT - P[ix + 1]) * Math.min(1, e * 1.05);
        P[ix + 2] = Math.sin(th) * rNow;
        A.aAlpha[i] = 0.30 * e;                            // 入场从 0 渐亮
        if (k >= 1) { A.mode[i] = 1; A.orbR[i] = rT; }
        continue;
      }
      if (A.mode[i] === 1) {
        /* —— 1 CRUISE：公转 + 轻微纵向摆动，读作环流里的一粒尘埃 —— */
        A.orbTh[i] += A.orbW[i] * step;
        const r = A.orbR[i] * (1.0 + 0.05 * Math.sin(simTime * 0.6 + A.orbSeed[i] * 17.0));
        const th = A.orbTh[i];
        P[ix]     = Math.cos(th) * r;
        P[ix + 1] = A.orbY[i] + 0.22 * Math.sin(th * 2.0 + A.orbSeed[i] * 31.0);
        P[ix + 2] = Math.sin(th) * r;
        A.aAlpha[i] = 0.28 + 0.10 * Math.sin(simTime * 2.0 + A.orbSeed[i] * 41.0);
        A.timer[i] -= step;
        if (A.timer[i] <= 0) {                       // 巡航到期 → 被外缘环碎片捕获
          A.mode[i] = 2;
          A.target[i] = this._pickFragmentIndex();
        }
        continue;
      }
      if (A.mode[i] === 3) {
        /* —— 3 RETURN：撞击点 → 环流带，easeOutCubic（回收不再是瞬移）—— */
        A.retT[i] += step;
        const k = Math.min(1, A.retT[i] / A.retDur[i]);
        const e = 1.0 - Math.pow(1.0 - k, 3);
        P[ix]     = A.retSX[i] + (A.retTX[i] - A.retSX[i]) * e;
        P[ix + 1] = A.retSY[i] + (A.retTY[i] - A.retSY[i]) * e;
        P[ix + 2] = A.retSZ[i] + (A.retTZ[i] - A.retSZ[i]) * e;
        A.aAlpha[i] = 0.10 + 0.24 * (1.0 - k);        // 回收时渐隐（回到环上再被巡航点亮）
        if (k >= 1) {                                 // 回到环上 → 续接巡航
          A.orbTh[i] = Math.atan2(P[ix + 2], P[ix]);
          A.orbY[i] = P[ix + 1];
          A.orbR[i] = Math.hypot(P[ix], P[ix + 2]);
          A.mode[i] = 1;
          A.timer[i] = 0.4 + Math.random() * 1.8;
        }
        continue;
      }
      const f = fr[A.target[i]];
      if (!f) { A.mode[i] = 1; A.target[i] = this._pickFragmentIndex(); continue; }
      /* 目标 = 碎片质心（组空间）= mesh.position + 面局部质心。
       * mesh 只有平移、无旋转，该式严格成立；展开推移/浮动时目标随碎片走。 */
      const tx = f.mesh.position.x + f.centroid.x;
      const ty = f.mesh.position.y + f.centroid.y;
      const tz = f.mesh.position.z + f.centroid.z;
      let dx = tx - P[ix], dy = ty - P[ix + 1], dz = tz - P[ix + 2];
      const dist = Math.hypot(dx, dy, dz) || 1e-3;
      if (dist < 0.16) {
        // 命中：碎片储存 +1；命中位置 = 碎片质心（面局部坐标，与 vObjPos 同系）
        f.stored = Math.min((f.stored || 0) + 1, this._FRAG_STORE_CAP);
        const mat = f.mesh.material;
        /* v5.17：命中点 = 粒子**此刻的位置**换算到片局部坐标（mesh 只有平移、无旋转）。
         * 旧实现往 u_impact 里登记的是 f.centroid（片质心）→ 命中点恒在片中心；
         * 用户要的是"以击中点为中心"。 */
        const hitX = P[ix] - f.mesh.position.x;
        const hitY = P[ix + 1] - f.mesh.position.y;
        const hitZ = P[ix + 2] - f.mesh.position.z;
        mat.uniforms.u_impact.value.set(f.centroid.x, f.centroid.y, f.centroid.z, 1.0);
        f.impactW = 1.0;
        /* v5.16：面级脉冲（从**面心**扫出、同面 285 片共享一条前沿）已废弃 ——
         * 那正是用户否定的"整个碎块面的中心出来一道脉冲"。
         * v5.17：改为**片级**脉冲 —— 以命中点为中心、沿碎片形状向外扩散到覆盖满整片。 */
        this._triggerHitPulse(f, hitX, hitY, hitZ, simTime);
        /* Round G（R2 回收）：命中点 → 环流带，**easeOutCubic** 缓动回收（mode 3）。
         * 修一个退化必须：原式 `retTX = dx0 / d0 * orbR`（d0 = hypot(dx0,dz0)）。
         * 命中点若几乎落在 Y 轴上（dx0,dz0 → 0），d0 被 1e-3 的下限接住，商退化成
         * 0.01 量级 → 回收**终点半径被压到 ~0.02u**：粒子被"送进构造体正中心"，
         * 之后以 orbR≈0 巡航，永远停在核心里面。实测粒子半径下界 rRange.min = 0.02~0.12
         * 就是这个 Bug（600 颗里只要有一颗踩到，画面里就是一根穿过核心的蓝线）。
         * 修法：d0 过小时改用**目标碎片自身的径向外向**做回收方向。 */
        const dx0 = P[ix], dy0 = P[ix + 1], dz0 = P[ix + 2];
        let r0x = dx0, r0z = dz0;
        let d0 = Math.hypot(r0x, r0z);
        if (d0 < 0.05) {
          r0x = tx; r0z = tz;
          d0 = Math.hypot(r0x, r0z) || 1e-3;
        }
        A.retSX[i] = dx0; A.retSY[i] = dy0; A.retSZ[i] = dz0;
        A.retTX[i] = r0x / d0 * A.orbR[i];           // 沿径向回收到环轨道
        A.retTY[i] = A.orbY[i];
        A.retTZ[i] = r0z / d0 * A.orbR[i];
        A.retT[i] = 0;
        A.retDur[i] = 0.9 + 0.5 * Math.random();
        A.mode[i] = 3;
        continue;
      }
      /* 引力式加速：速度 = 基础 + k/(dist+0.3) → 越近越快（近处收敛 ~6u/s），
       * 修正旧版"速度∝距离"的指数缓出（越靠近越慢）。 */
      let sp = Math.min(0.9 + 2.1 / (dist + 0.30), 6.0) * step;
      if (sp > dist) sp = dist;                      // 不超调：一步之内必命中
      /* 保留切向分量 → 螺旋卷入（"被吸附"的读感）；权重随距离衰减 → 近处径向占优 */
      const ux = dx / dist, uy = dy / dist, uz = dz / dist;
      const tang = Math.min(0.45, dist * 0.55);
      let cx = -uz, cz = ux;                         // up(0,1,0) × u
      const cl = Math.hypot(cx, cz) || 1e-3;
      cx /= cl; cz /= cl;
      const w = tang / (1.0 + tang);
      const ml = Math.hypot(ux + cx * w, uy, uz + cz * w) || 1e-3;
      P[ix]     += (ux + cx * w) / ml * sp;
      P[ix + 1] += uy / ml * sp;
      P[ix + 2] += (uz + cz * w) / ml * sp;
      A.aAlpha[i] = Math.min(0.60, 0.28 + (1.2 - Math.min(dist, 1.2)) * 0.22);
    }
    /* v-fix：流星拖尾——基于当前位置与上一帧位置外推 tail（防 respawn 跳变）
     * Round G：EXT 4.0 → 1.8。实测 600 条 × 4 倍外推在高能态读成"满屏蓝色划痕"
     * （截图里是一片杂乱的蓝虚线网），既盖过构造体结构、又不像"流星"。缩短后是短促的
     * 方向性拖尾，只用于指示粒子的运动方向。 */
    if (this.ambientTrails) {
      const tp = this.ambientTrails.geometry.attributes.position.array;
      const EXT = 1.8;
      for (let i = 0; i < n; i++) {
        const ix = i * 3, t2 = i * 6;
        const px = P[ix], py = P[ix + 1], pz = P[ix + 2];
        const dx = px - this._ambPrev[ix], dy = py - this._ambPrev[ix + 1], dz = pz - this._ambPrev[ix + 2];
        if (dx * dx + dy * dy + dz * dz < 0.25) {
          tp[t2] = px - dx * EXT; tp[t2 + 1] = py - dy * EXT; tp[t2 + 2] = pz - dz * EXT;
        } else {
          tp[t2] = px; tp[t2 + 1] = py; tp[t2 + 2] = pz;   // 跳变 → 无拖尾
        }
        tp[t2 + 3] = px; tp[t2 + 4] = py; tp[t2 + 5] = pz;
        this._ambPrev[ix] = px; this._ambPrev[ix + 1] = py; this._ambPrev[ix + 2] = pz;
      }
      this.ambientTrails.geometry.attributes.position.needsUpdate = true;
    }
    const g = this.ambientPoints.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    this.ambientPoints.material.uniforms.u_time.value = simTime;
    this._ambModes = modeHisto;      // 探针可观测：[inbound, cruise, capture, return, exit]
    this._ambExitK = exitK;
  }

  /**
   * 内壳展开动画（激发态形变）：
   *  MainParam 越过 DEPLOY_START 后，外甲的裂片沿面法线平行向外推开（v5.2 起不再是
   *  绕一条边翻转的铰链开门 —— 用户明确否决；v5.3 起绕轴旋转也取消 —— 多层片互相
   *  遮挡穿模，同样用户否决），只保留上下浮动。用欠阻尼二阶弹簧推进，到位时有轻微
   *  回弹，读起来像机械机构而不是线性插值。
   */
  _animateDeploy(p, simTime, hot) {
    const dt = Math.min(0.05, Math.max(0, simTime - (this._lastSimTime ?? simTime)));
    this._lastSimTime = simTime;

    /* —— v5.12：0.80 之后的**固定时长演出序列**（用户指定的展开起手式）——
     *   ① 轮廓线爆发 SEAM_BURST_DUR：不管此刻脉冲跑到哪儿，都从它当前位置向两侧
     *      铺满整个五边形面的全部轮廓线 → 高亮一下 → 变暗；
     *   ② 碎块外推 DEPLOY_DUR：爆发走完之后才开始，碎块缓动到位，之后转入浮动。
     * 两段都按 1/DUR 的**固定速率**推进（不跟随能量值），所以无论能量爬得多快，
     * 演出长度恒定 —— 与云雾光环的成形同一套调度。 */
    const wantSeq = this._deployAllowed && p >= DEPLOY_START;
    if (this._burstT == null) this._burstT = 0;
    this._burstT = THREE.MathUtils.clamp(
      this._burstT + (wantSeq ? dt : -dt) / SEAM_BURST_DUR, 0, 1);
    // 爆发触发瞬间冻结当前脉冲相位 → "从哪里开始向两侧铺"连续，不会跳变
    if (wantSeq && !this._prevWantSeq) {
      this._burstC = (simTime * this.uniforms.u_pulse_speed.value) % 1;
    }
    const _wasSeq = this._prevWantSeq;
    this._prevWantSeq = wantSeq;
    this._wantSeq = wantSeq;   // v5.14：sync 里写 u_burst 时据此决定是"重播"还是"单调熄灭"
    /* —— v5.16：面级脉冲排程全部作废 ——
     * 用户原话："能量到达80之后，每个五边形面中心会扩散出一道脉冲，然后一直循环……
     *   我怀疑你是把基准面渐隐渐显做到水晶碎块上了，而且没有设置触发条件"
     *   "这些行为其实都是要在包裹住核心的基准面上动作的"。
     * 已删除的三路（都曾挂在水晶碎块上）：
     *   ① 高能周期（REVEAL_PERIOD=2.4s 无条件循环）→ 搬到基准面（见 _animateBasePulse）；
     *   ② 收回显现（showT 暗波）→ 同样搬到基准面（_animateBasePulse 的 dir=−1 分支）；
     *   ③ 面级撞击环（一面一条前沿、从**面心**扫出）→ v5.17 改为**片级 + 击中点为中心**。
     * 于是 `_faceRev` 已无驱动源，下面只写空闲值让 u_rev 彻底失效。 */
    this._revImpGap = Math.max(0, (this._revImpGap ?? 0) - dt);
    /* —— v5.17：**片级**命中脉冲推进 ——
     * 每片一条独立行程（材质逐片克隆，所以 u_hitT 天然私有）。
     * 行程从 0 推到 1 即"前沿从击中点走到片最远顶点"，走完置 −1（空闲）。 */
    this._hitGap = Math.max(0, (this._hitGap ?? 0) - dt);
    if (this._hitPulseCount == null) this._hitPulseCount = 0;
    for (let i = 0; i < this.fragments.length; i++) {
      const u = this.fragments[i].mesh.material.uniforms;
      const t = u.u_hitT.value;
      if (t < 0) continue;
      const nt = t + dt / HIT_PULSE_DUR;
      u.u_hitT.value = nt >= 1 ? -1 : nt;
    }
    // 面级状态（_faceRev）已无驱动源，写一遍空闲值让 u_rev 彻底失效（探针仍读 _revStats）
    for (let k = 0; k < 12; k++) {
      const st = this._faceRev[k];
      st.front = REVEAL_FRONT_END; st.amt = 0; st.ring = 0; st.kind = 'idle';
    }
    this._writeFaceRev();

    /* —— v5.16：20 阈值「水晶壳由面心向外不规则脉冲渐显」——
     * 固定时长推进（与能量爬升快慢无关），跌回 0.20 以下同速收回。
     * 0 能量 → u_shell_form=0 → 着色器侧前沿起点 SHELL_FORM_START=−0.20 → 整壳不显示。 */
    const wantShell = p >= SHELL_SHOW_P;
    if (this._shellT == null) this._shellT = 0;
    this._shellT = THREE.MathUtils.clamp(
      this._shellT + (wantShell ? dt : -dt) / SHELL_FORM_DUR, 0, 1);
    this.uniforms.u_shell_form.value = this._shellT;

    /* —— v5.16：基准面「细线环脉冲 + 擦除式半隐」状态机 ——
     * 触发条件是**跨越 0.80 阈值的那一帧**（不再是"p≥0.80 就一直循环"）：
     *   · 上升越过 0.80 → dir=+1，行程 0→1（扫过→半隐）；
     *   · 跌破 0.80     → dir=−1，行程 0→1（扫过→恢复渐显）；
     *   · 行程走完后**保持在 1**（dir=+1 时 = 整面半隐；dir=−1 时 = 整面恢复）。
     * 时长 BASE_PULSE_DUR=0.42s < SEAM_BURST_DUR=0.72s —— 满足用户定标
     * "基准面脉冲扩散完全时间应小于水晶碎块的脉冲高亮开始蔓延～碎块开始升起的时间"：
     * 基准面与爆发**并发**起跑，基准面先扫完（0.42s），碎块才在 0.72s 后开始升起。 */
    this._animateBasePulse(wantSeq, _wasSeq, dt);
    // 展开必须等爆发完整走完才开始（回落时先收爆发，再收展开）
    if (this._deployT == null) this._deployT = 0;
    /* v5.13c：能量退出展开（<0.80）后，**先让转过格的面按最短路径转回原位，再收拢**。
     * 若此时就让 _deployT 往下走，rotGate 会把累计角 k×72° 按比例抹掉 —— 视觉上就是
     * 面在收拢的同时倒转好几圈（用户明确指出的问题）。故回归期间冻结收拢进度。 */
    /* v5.13d：收拢冻结**限时**（FRAG_RET_HOLD=0.45s），不再等"所有面都判定回位"。
     * 上一版是"只要有面还在回归就一直冻结" —— 12 个面各自的时长叠加起来就是好几秒的
     * 停滞，用户明确说"不在构思里，且严重影响演出"。现在：能量掉下阈值后所有面立刻
     * 回归，最多等 0.45s 就开始降；还没走完的部分残余角很小，随 rotGate 一起归零。 */
    const busyPrev = this._rotBusy === true;
    if (wantSeq) this._retHoldT = 0;
    else if (busyPrev) this._retHoldT = Math.min(FRAG_RET_HOLD, (this._retHoldT ?? 0) + dt);
    const holdRot = !wantSeq && busyPrev && (this._retHoldT ?? 0) < FRAG_RET_HOLD;
    /* v5.14：**收回显现走完之前不许下降**（用户原话"……之后才降下去"）。
     * v5.16：显现已从碎块搬到**基准面**，冻结条件随之换成"基准面脉冲渐显仍在跑"。
     *   · 旧值：RETRACT_REVEAL_DUR × REVEAL_SHOW_SPAN = 0.85 × 1.529 = **1.30s**
     *     —— 这就是用户抱怨的"比之前版本要多等将近半秒"（v5.13d 只冻结 0.45s）；
     *   · 新值：BASE_PULSE_DUR = **0.42s** —— 与旋转冻结 FRAG_RET_HOLD(0.45s) 重叠，
     *     实际总冻结 = max(0.45, 0.42) = **0.45s**，回到 v5.13d 的基线（−0.85s）。 */
    const revealBusy = !wantSeq && this._basePulseBusy === true;
    const holdDeploy = holdRot || revealBusy;
    this._holdDeploy = holdDeploy;        // 探针可观测
    this._revealBusy = revealBusy;
    this._deployT = THREE.MathUtils.clamp(
      this._deployT + ((wantSeq && this._burstT >= 0.999) ? dt : (holdDeploy ? 0 : -dt)) / DEPLOY_DUR, 0, 1);

    const target = this._deployT * this._deployT * (3.0 - 2.0 * this._deployT);

    const K = 120.0;          // 刚度
    const ZETA = 0.62;        // 阻尼比 < 1 → 到位时轻微回弹（机械感）
    this._deployV = (this._deployV ?? 0) + (target - this._deploy) * K * dt;
    this._deployV -= this._deployV * 2.0 * ZETA * Math.sqrt(K) * dt;
    this._deploy += this._deployV * dt;
    if (this._deploy < 0) { this._deploy = 0; this._deployV = 0; }

    const d = this._deploy;
    // （v5.7：整体运动包络 dE 已废除 —— 改为每片各自的 arrive 进度，见下方循环）
    // v5.4：展开进度下发到着色器 —— 驱动水晶色差（与构造体拉开）与断口反光
    this.uniforms.u_deploy.value = d;

    /* v5.7 外推节奏（用户修订）：
     *   · **同时启动**：所有片的外推进度都从 d=0 起算；
     *   · **不同时到位**：每片有自己的到达时刻 f.arrive（∈[0.46,1.0]），
     *     归一化进度 u = clamp(d / arrive)，再走**完全相同的缓动系数**
     *     （smoothstep：u²(3−2u)）—— 起点一致、终点错开，才有机械的灵活性，
     *     不会像旧版那样整排同时停住（"看着很死板"）。
     *   · 推开量 per-piece：小碎屑推得远、大板推得少（0.16~0.34u），最大半径 ≈1.36u；
     *   · 旋转：**取消**（rotSpeed 恒 0，dodecaKit 侧已不再生成）；
     *   · 浮动 = 同频行波 sin(ωt − k·r)：全体共用 floatFreq=ω，相位 = −k×片到面中心
     *     的平均距离 → 相位差固定、随离中心距离增大，波从每个面心向外传播；
     *   · 幅度 × (0.35+0.65·hot) —— 能量越高起伏越大（用户要求）。
     */
    // v5.7 浮动**速度**：随能量高于 0.80 的溢出量线性加速（1.5× → 3.0×，p=1.0 时到顶）。
    // 用独立累加的相位时间 _waveT（而不是直接改 ω）—— 直接换频率会让行波相位跳变，
    // 累加器才能保证加速平滑、相位差（波形）不散。
    const over = THREE.MathUtils.clamp((p - DEPLOY_START) / (1.0 - DEPLOY_START), 0, 1);
    const waveSpeed = 1.5 + 1.5 * over;                 // 线性：1.5× (p=0.80) → 3.0× (p=1.00)
    this._waveT = (this._waveT ?? 0) + dt * waveSpeed;
    this._waveSpeed = waveSpeed;                        // 探针可观测
    const waveT = this._waveT;

    /* v5.13d：**缓动速率随能量升高**（用户要求）—— 能量超出 0.80 的部分 over 越大，
     * 齿轮卡得越快。爬升时长 = FRAG_ROT_RAMP / (片速率 × 能量加速)。 */
    const rotBoost = 1.0 + FRAG_ROT_ENERGY * over;
    const rotDur = (rt) => Math.max(0.06, FRAG_ROT_RAMP / (rt.easeMul * rotBoost));

    let eMin = Infinity, eMax = -Infinity;
    let rotSpinning = 0, rotReturning = 0, rotMaxDeg = 0, rotSample = null;
    const rotGate = THREE.MathUtils.smoothstep(d, 0.60, 0.95);   // 展开→1，闭合→0
    /* v5.20b：这里**曾经**有一个 `_plateLift`（凭空加的推离），已被用户否决并删除 ——
     * 用户原话："为什么要推开，水晶面底部正好和基准面贴合，只有上面和基准面有一定距离，
     *   就是线框划定的厚度。现在直接就是在现线框框定的厚度的外面推离，然后再画两个面，
     *   这不搞笑吗。"
     * 正确的几何关系是：水晶面**底面本来就贴在基准面上**，顶面距基准面 = 线框划定的壁厚
     * （R_SHELL_IN → R_SHELL_OUT 那一层）。柱面就是这层壁的侧壁 —— 不需要任何额外位移。
     * 保留 `_plateLift = 0` 只是为了让 updatePulseColumns 的算式不必分支。 */
    this._plateLift = 0;
    /* v5.20：柱面的上沿要钉在**该面晶体板的平均抬升**上 —— 逐片 off 不同（pushAmt 有
     * 噪声），故每帧先清零再累加，循环结束后在 updatePulseColumns 里取均值。 */
    for (const key in this._faceRot) { const g = this._faceRot[key]; if (g) { g.offSum = 0; g.offN = 0; } }
    for (const f of this.fragments) {
      // 每片自己的缓动进度（同一条曲线，不同终点）
      const u = THREE.MathUtils.clamp(d / (f.arrive ?? 1.0), 0, 1);
      const eP = u * u * (3.0 - 2.0 * u);               // 与整程同一 smoothstep 系数
      if (eP < eMin) eMin = eP;
      if (eP > eMax) eMax = eP;
      const floatAmp = 0.034 * (0.35 + 0.65 * hot) * eP;
      const off = eP * f.pushAmt
                + Math.sin(waveT * f.floatFreq + f.floatPhase) * floatAmp;
      const bob = Math.sin(waveT * f.floatFreq + f.floatPhase + 1.1) * floatAmp * 0.45;
      {
        const g = this._faceRot[f.faceIdx];
        if (g) { g.offSum = (g.offSum || 0) + off; g.offN = (g.offN || 0) + 1; }
      }
      f.mesh.position.copy(f.faceCenter).addScaledVector(f.normal, off);
      f.mesh.position.y += bob;

      // —— Phase1c/d：冷色调随储存量升高；受击柔光强度衰减；累计每面吸收量 ——
      const fmat = f.mesh.material;
      fmat.uniforms.u_cool.value = Math.min((f.stored || 0) * this._COOL_PER, this._COOL_MAX);
      if (f.impactW > 0) f.impactW = Math.max(0, f.impactW - dt / this._IMPACT_FADE);
      fmat.uniforms.u_impact.value.w = f.impactW;
      /* Round G：删掉了 Round F 的"每片各算一遍半隐"逻辑 ——
       * 它按**碎片**（f.radialN）离散化，读出来是一格一格而不是环；而且只乘 alpha 不乘 c
       * （预乘混合下等于没门控颜色，实测反而让画面变亮 16%，见 FRAG 里的注释）。
       * 现在半隐/显现完全由**面级**脉冲驱动（_writeFaceRev 写在 u_rev 上），
       * 逐像素按面内半径连续成环。这里只保留每面吸收量统计。 */
      this._faceAbsorbed[f.faceIdx] += (f.stored || 0);

      /* —— v5.13c 齿轮卡位自转（**按面协同**，展开完成后才运行）——
       * 用户修订：碎片必须**同面的所有片一起转、同方向**，否则各转各的就再也拼不回
       * 五边形。面级状态机决定"何时转、往哪转、目标角"；片级只保留自己的缓动系数
       * （按面内归一化距离 → 旋转像一道波从面心扫出去）与阻尼比（过冲带宽 ≈4°）。
       *
       * v5.13c 修正①：事件结束时**没有把面级 rampT 清零** —— 第二次及以后的触发在
       *   同一帧就被 `rampT >= 1` 判死（事件只活 1 帧），剩下的位移全由下面 else 分支
       *   的指数缓动补完 → 过冲只在第一次出现，之后都是"直接缓动到终点"。
       * v5.13c 修正②：结束条件改为**所有碎片真正停稳**（而不是固定时长兜底），
       *   否则过冲的尾巴会在弹簧还没走完时被 else 分支接管、被抹平。 */
      if (!f._rot) {
        f._rot = {
          angle: 0, vel: 0, rampT: 0, settled: false, retFrom: 0, from: 0,
          // 每片自己的阻尼比（过冲 ≈8~12°，带宽 ≈4°）与缓动系数（内圈快、外圈慢）
          zeta: FRAG_ROT_ZETA_MIN + Math.random() * (FRAG_ROT_ZETA_MAX - FRAG_ROT_ZETA_MIN),
          // v5.13d：easeMul 是**速率**（越大越快），面心片快、外缘片慢
          easeMul: FRAG_ROT_RATE_MIN
            + (FRAG_ROT_RATE_MAX - FRAG_ROT_RATE_MIN) * (1.0 - (f.radialN ?? 0.5))
        };
      }
      const rt = f._rot;
      // 面级状态机（同一面的所有片共享）
      const grp = this._faceRot[f.faceIdx] ?? (this._faceRot[f.faceIdx] = {
        nextAt: simTime + 1.2 + Math.random() * 2.8,   // 各面错开，不同时整排齐转
        dir: 1, accum: 0, rampT: 0, active: false, overPeak: 0,
        ret: false, retT: 0, shards: []                // v5.13c：回归阶段 + 本面片引用
      });
      if (!grp.shards.includes(rt)) grp.shards.push(rt);
      if (d < 0.30 && grp.accum !== 0) {               // 收拢深处复位（此时 rotGate=0，无跳变）
        grp.accum = 0; grp.rampT = 0; grp.active = false;
        grp.ret = false; grp.retT = 0;
        grp.nextAt = simTime + 1.2 + Math.random() * 2.8;
        rt.angle = 0; rt.vel = 0; rt.rampT = 0; rt.settled = false; rt.retFrom = 0;
      }
      /* v5.19：转动资格的**上升沿**排期（修"面上升后所有面同时转动一次"）。
       * nextAt 是绝对时刻，而能量 <80 期间下面那个触发条件根本不参与判定 →
       * nextAt 一直停在很久以前。等 d 越过 0.98 时 12 个面全都已过期 → 同一帧齐转。
       * 故在资格从 false 变 true 的那一帧，按**当前时刻**重排，并用分层随机分槽
       * （帧内序号 + 随机数）/12 —— 保证摊开，而不是纯随机（纯随机可能扎堆）。
       * 注：grp 被本面 ~24 片共享，但 wasEligible 在第一片处理完就被置 true，
       * 同帧后续片会跳过 → 每面每帧只排一次。 */
      if (this._rotFrameTag !== simTime) { this._rotFrameTag = simTime; this._rotFrameSeq = 0; }
      const rotEligible = wantSeq && d >= 0.98;
      if (rotEligible && !grp.wasEligible) {
        const slot = (this._rotFrameSeq++ + Math.random()) / 12;
        grp.nextAt = simTime + ROT_FIRST_DELAY_BASE + slot * ROT_FIRST_STAGGER;
      }
      grp.wasEligible = rotEligible;
      /* v5.13c：触发条件必须同时看**能量阈值**（wantSeq），不能只看 d>=0.98 ——
       * 回归期间 deploy 被冻结在 ~1，d 一直满足 0.98，只看 d 的话已经回原位的面会
       * 立刻排下一次、在收拢过程中继续转（实测降能 3.3s 后仍有 21 片在转）。 */
      if (!grp.active && !grp.ret && wantSeq && d >= 0.98 && simTime >= grp.nextAt) {
        grp.active = true;
        grp.dir = Math.random() < 0.5 ? -1 : 1;        // 整面同方向（顺/逆时针随机）
        grp.accum += grp.dir * FRAG_ROT_STEP;          // 目标角累计（不回原位）
        grp.rampT = 0;                                 // v5.13c①：必须清零
        grp.overPeak = 0;                              // 本次事件的过冲峰值（探针可观测）
        /* v5.13c 修正③：斜坡的**起点**必须是本片当前角度，而不是 0。
         * 旧式 `ramp = accum * smoothstep(rampT)` 在 rampT=0 时给出 0 —— 第二次及以后
         * 的事件里，弹簧目标会先被甩回 0 再爬回累计角，等于凭空挨一次反向冲击。
         * 实测表现：逐次过冲峰值前 8 次 ~10°、之后突增到 21~25°（≈2×）。 */
        for (const s of grp.shards) { s.rampT = 0; s.settled = false; s.from = s.angle; }
      }
      if (grp.ret) {
        /* —— 回归：从 retFrom（已折到 (−π,π] 的最短路径）缓动回 0 ——
         * 与正向同一套 斜坡 → 弹簧过冲 → 卡位，只是终点是**原位**。 */
        rt.rampT = Math.min(1, rt.rampT + dt / rotDur(rt));
        const k = rt.rampT * rt.rampT * (3.0 - 2.0 * rt.rampT);
        const ramp = rt.retFrom * (1.0 - k);
        rt.vel += (ramp - rt.angle) * FRAG_ROT_K * dt;
        rt.vel -= rt.vel * 2.0 * rt.zeta * Math.sqrt(FRAG_ROT_K) * dt;
        rt.angle += rt.vel * dt;
        if (rt.rampT >= 1 && Math.abs(rt.vel) < 0.03 && Math.abs(rt.angle) < 0.02) {
          rt.angle = 0; rt.vel = 0; rt.settled = true;
        }
        rotReturning++;
        const degNow = rt.angle * 57.29578;
        if (Math.abs(degNow) > Math.abs(rotMaxDeg)) rotMaxDeg = degNow;
        if (!rotSample) {
          rotSample = { face: f.faceIdx, angleDeg: +degNow.toFixed(2), targetDeg: 0, phase: 'ret' };
        }
      } else if (grp.active) {
        // 每片自己的速率 → 各片在同一面内先后到位（波从面心扫向边缘）
        rt.rampT = Math.min(1, rt.rampT + dt / rotDur(rt));
        const ramp = rt.from + (grp.accum - rt.from) * (rt.rampT * rt.rampT * (3.0 - 2.0 * rt.rampT));
        rt.vel += (ramp - rt.angle) * FRAG_ROT_K * dt;
        rt.vel -= rt.vel * 2.0 * rt.zeta * Math.sqrt(FRAG_ROT_K) * dt;
        rt.angle += rt.vel * dt;
        if (rt.rampT >= 1 && Math.abs(rt.vel) < 0.03 && Math.abs(ramp - rt.angle) < 0.02) {
          rt.angle = grp.accum; rt.settled = true;
        }
        // 过冲 = 越过本次目标角继续前进的量（沿行进方向为正）
        const over = (rt.angle - grp.accum) * grp.dir;
        if (over > grp.overPeak) grp.overPeak = over;
        rotSpinning++;
        const degNow = rt.angle * 57.29578;
        if (Math.abs(degNow) > Math.abs(rotMaxDeg)) rotMaxDeg = degNow;
        if (!rotSample) {
          rotSample = { face: f.faceIdx, angleDeg: +degNow.toFixed(2),
            targetDeg: +(grp.accum * 57.29578).toFixed(2), phase: 'step' };
        }
      } else {
        rt.angle += (grp.accum - rt.angle) * Math.min(1, dt * 8.0);   // 未激活片缓慢对齐面目标
      }
      f.mesh.quaternion.setFromAxisAngle(f.normal, rt.angle * rotGate);
    }
    /* —— 面级排程（每帧一次，不能放在碎片循环里 —— 那会被同面的 20+ 片各推一次）—— */
    let anyBusy = false;
    for (const key in this._faceRot) {
      const grp = this._faceRot[key];
      if (grp.ret) {
        grp.retT += dt;
        const allSettled = grp.shards.every((s) => s.settled);
        if ((allSettled && grp.retT > FRAG_ROT_RAMP) || grp.retT > FRAG_RET_TIMEOUT) {
          grp.ret = false; grp.retT = 0; grp.accum = 0;
          for (const s of grp.shards) {
            s.angle = 0; s.vel = 0; s.rampT = 0; s.settled = false; s.retFrom = 0;
          }
          grp.nextAt = simTime + 1.2 + Math.random() * 2.8;
        } else {
          anyBusy = true;
        }
        continue;
      }
      /* v5.13d：能量退出展开（<0.80）→ **不管这一面此刻是什么状态**（静止 / 走格中 /
       * 正在过冲），立刻启动**最短路径回归**。用户明确指出"回位之后停滞很久才降"不可接受，
       * 而"等这一格走完再回"会让每个面各自的等待时间叠加成好几秒。
       * 折角到 (−π,π]：绕面法线转 360° 是恒等变换，画面上没有任何跳变，累计角 k×72°
       * 因此变成 ≤180° 的最短回程 —— 而不是把 k×72° 原路倒转回去。 */
      if (!grp.ret && !wantSeq && (grp.accum !== 0 || grp.active)) {
        grp.ret = true; grp.retT = 0; grp.active = false; grp.rampT = 0;
        for (const s of grp.shards) {
          s.angle -= Math.PI * 2 * Math.round(s.angle / (Math.PI * 2));
          s.retFrom = s.angle; s.rampT = 0; s.vel = 0; s.settled = false;
        }
        grp.accum = 0;                                 // 目标 = 原位
        anyBusy = true;
        continue;
      }
      if (!grp.active) continue;
      // 走格中（能量仍在阈值以上）
      anyBusy = true;
      grp.rampT += dt / (FRAG_ROT_RAMP * 1.30);
      const allSettled = grp.shards.length > 0 && grp.shards.every((s) => s.settled);
      // v5.13c：面内缓动档差的实证 —— 同一面的片 easeMul 应当跨 0.55~1.45，
      // 否则"波从面心扫向边缘"的错落不存在（用户反馈看不出差异化）。
      if (this._rotEaseRange == null && grp.shards.length > 2) {
        let mn = Infinity, mx = -Infinity;
        for (const s of grp.shards) {
          if (s.easeMul < mn) mn = s.easeMul;
          if (s.easeMul > mx) mx = s.easeMul;
        }
        this._rotEaseRange = { min: +mn.toFixed(3), max: +mx.toFixed(3) };
      }
      // 正常出口 = 全部碎片停稳（过冲尾巴走完）；超时只是兜底，不该成为常态出口
      if ((allSettled && grp.rampT >= 1) || grp.rampT > 3.2) {
        grp.active = false;
        grp.rampT = 0;                                 // v5.13c①：清零，否则下次事件只活 1 帧
        grp.nextAt = simTime + 2.0 + Math.random() * 2.0;   // 之后每 2~4s 一次
        // 逐次事件的过冲峰值日志：证明"不是只有第一次过冲"
        if (this._rotEvents == null) this._rotEvents = [];
        this._rotEvents.push(+(grp.overPeak * 57.29578).toFixed(2));
        if (this._rotEvents.length > 12) this._rotEvents.shift();
      }
    }
    this._rotBusy = anyBusy;
    this._pushSpread = { min: eMin, max: eMax };        // 探针可观测：>0 即"不同时到位"
    this._rotStats = { spinning: rotSpinning, returning: rotReturning,
      maxDeg: +rotMaxDeg.toFixed(2), sample: rotSample,
      events: this._rotEvents ?? [], ease: this._rotEaseRange ?? null,
      boost: +rotBoost.toFixed(2) };

    /* v5.19：撞击队列 —— 与转动**同窗口**（wantSeq && d>=0.98），
     * 于是"一个转动间隔"正好就是队列的一个排期窗口 → 天然满足"间隔内每片至少一次"。 */
    this._updateHitQueues(simTime, wantSeq && d >= 0.98);

    /* —— 轮廓线一次性渐显（v5.9，用户定标）——
     * 能量越过 SEAM_SHOW_P（0.20）→ 轮廓线按**固定 SEAM_FADE_DUR 秒**渐显一次
     * （前沿沿轨迹推进，速率与能量爬升快慢无关），到位后由着色器转为亮度呼吸。
     * 阈值以下同速收回 —— <20 依然是一整块无痕水晶。 */
    const wantSeam = p >= SEAM_SHOW_P;
    if (this._seamT == null) this._seamT = 0;
    this._seamT = THREE.MathUtils.clamp(
      this._seamT + (wantSeam ? dt : -dt) / SEAM_FADE_DUR, 0, 1);
    this.uniforms.u_seam_form.value = this._seamT;

    /* —— 轮廓线爆发推进（v5.12）——
     * 时段划分：0~0.42 向两侧铺开；0.42~0.62 保持高亮；0.62~1 变暗。
     * 注意"向两侧铺开"的含义：宽度来自 u_burst_w 的增长，**亮度**不涨（受用户约束），
     * 事件感由覆盖面积提供，而不是把整条线框打到过曝 —— 那是上一版被否掉的观感。 */
    const bt = this._burstT;
    const spread = THREE.MathUtils.smoothstep(Math.min(1, bt / 0.42), 0, 1);
    this.uniforms.u_burst_w.value = 0.05 + 1.20 * spread;
    this.uniforms.u_burst_c.value = this._burstC ?? 0.5;
    let burstEnv;
    if (this._wantSeq) {
      // 展开：正常演一遍起手式（铺开 → 高亮 → 变暗）
      if (bt < 0.42) burstEnv = THREE.MathUtils.smoothstep(bt, 0.0, 0.42);
      else if (bt < 0.62) burstEnv = 1.0;
      else burstEnv = 1.0 - THREE.MathUtils.smoothstep(bt, 0.62, 1.0);
    } else {
      /* v5.14：收回时**不倒放重播**。原实现 _burstT 从 1 递减回 0 → 包络被反向
       * 走一遍（0→1→0），轮廓线在收回时又整体亮一次（0.27s 亮起 + 0.45s 熄灭），
       * 与收回显现的暗波叠在一起 → 用户读作"光亮突然消失、变得暗淡无光"。
       * 改为从当前值**单调衰减**到 0：收回期间不再有第二次起手式，轮廓线只是
       * 安静地暗下去。同时把 _burstT 也继续往回收，回到 0 后再次展开才是全新一遍。 */
      burstEnv = Math.max(0, (this._burstEnv ?? 0) - dt / RETRACT_BURST_FADE);
    }
    this.uniforms.u_burst.value = burstEnv;
    this._burstW = this.uniforms.u_burst_w.value;   // 探针可观测
    this._burstEnv = burstEnv;

    // v5.11：脉冲循环仅在「轮廓线已显出 → 能量到 0.80」区间；
    // v5.12：爆发一起立刻让位（两道波同时跑会互相干扰，读作杂乱）
    // v5.16：轮廓线阈值已由 0.20 后移到 **0.35**（用户重排阈值）→ 区间自动变成 0.35→0.80
    this.uniforms.u_pulse_gate.value =
      THREE.MathUtils.smoothstep(this._seamT, 0.85, 1.0)
      * (1.0 - THREE.MathUtils.smoothstep(p, 0.76, 0.80))
      * (1.0 - THREE.MathUtils.clamp(bt / 0.18, 0, 1));

    /* —— 环状雾带成形（v5.7，用户定标）——
     * 能量越过 0.80 → 走一段**固定 RING_FORM_DUR 秒**的变换动画（雾气自外围汇聚、
     * 收束成环并旋进到位），成形结束后进入正常环绕旋转。
     * 关键：进度按 1/DUR 的**固定速率**推进（不跟随能量值），所以无论能量爬得多快，
     * 这段动画恒为 ~1s；能量跌回阈值以下则以同样速率收束。 */
    const wantRing = this._deployAllowed && p >= DEPLOY_START;
    if (this._ringFormT == null) this._ringFormT = 0;
    this._ringFormT = THREE.MathUtils.clamp(
      this._ringFormT + (wantRing ? dt : -dt) / RING_FORM_DUR, 0, 1);
    const formT = this._ringFormT;
    const ringsOn = formT > 0.005;
    // 亮度整体比 v5.6 低一档（用户：高能量态几乎一片白）
    const ringGain = 0.52 * formT * (0.50 + 0.50 * hot) * (this._ringMul ?? 1.0);
    for (const rg of this.ringGroups) {
      rg.group.visible = ringsOn;
      const t = simTime + rg.def.phase;
      rg.group.rotation.x = rg.def.tilt + 0.11 * Math.sin(t * 0.50);
      rg.group.rotation.z = rg.def.tilt * 0.8 + 0.11 * Math.cos(t * 0.37);
      // 两环错峰（formPhase）→ 先后成形
      const form = THREE.MathUtils.clamp(formT * 1.35 - rg.def.formPhase, 0.0, 1.0);
      const fe = form * form * (3.0 - 2.0 * form);        // smoothstep 缓动
      // 成形期：整环自外围（1.55×）收束到最终半径 → 读作"雾气向内聚成环"
      rg.group.scale.setScalar(THREE.MathUtils.lerp(1.55, 1.0, fe));
      // 成形期的额外旋进随 fe 衰减到 0 → 动画结束后只剩正常的环绕旋转
      rg.group.rotation.y = simTime * rg.def.speed
        + (1.0 - fe) * (1.0 - fe) * 3.2 * rg.def.flowDir;
      rg.uColor.value.copy(this.uniforms.u_emissive_color.value);
      rg.flowUniforms.u_time.value = simTime;
      rg.flowUniforms.u_form.value = fe;
      rg.flowUniforms.u_gain.value = ringGain * 1.20;
    }
  }

  /**
   * Round G：把 12 个面的脉冲环状态写进该面每一片的 uniform。
   * 一面一次取状态、一次赋给该面全部片 —— 保证"同面的片同步做同一件事"
   * （与 v5.13b 的齿轮卡位面级协同同一原则；片级只留各自的 rjit 不规则扰动）。
   */
  _writeFaceRev() {
    const fs = this._faceShards;
    let cycling = 0, impacting = 0, frontSum = 0, amtSum = 0, n = 0;
    for (let k = 0; k < 12; k++) {
      const st = this._faceRev[k];
      const list = fs[k];
      if (!list) continue;
      const v = this._revTmp || (this._revTmp = new THREE.Vector4());
      v.set(st.front ?? REVEAL_FRONT_END, st.amt ?? 0, st.showFront ?? 0, st.showAmt ?? 0);
      for (const f of list) {
        const u = f.mesh.material.uniforms;
        u.u_rev.value.copy(v);
        u.u_revGain.value = st.ring ?? 0;
      }
      if (st.kind === 'cycle') cycling++;
      else if (st.kind === 'impact') impacting++;
      frontSum += st.front ?? REVEAL_FRONT_END; amtSum += st.amt ?? 0; n++;
    }
    this._revStats = {
      cycling, impacting,
      frontAvg: +(frontSum / Math.max(1, n)).toFixed(3),
      hiddenFrac: +(amtSum / Math.max(1, n)).toFixed(3),
      /* v5.16 基准面脉冲的观测口（碎块侧已无周期/显现，clock 字段改挂基准面行程） */
      base: this._baseStats ?? null
    };
  }

  /**
   * v5.16：基准面（shellInner）的「细线环脉冲 + 擦除式半隐」排程。
   *
   * 用户定标（原话）：
   *   "上升到达80阈值：脉冲高亮向两侧蔓延，同时每个基准面从中心向外扩散不规则、
   *    极薄的细线环脉冲，脉冲扫过的部分变得半隐，没扫过的部分照旧，最后时整个基准面
   *    变得半隐"
   *   "降下80阈值：在碎块回位的这段时间里，基准面同样不规则脉冲扩散渐显，随后落下"
   *
   * ★ 与旧实现的根本差别：**有触发条件**。旧的高能周期是 `if (amt<=0 && wantSeq)`
   *   的无条件 2.4s 循环 —— 用户读作"一直循环的很粗的橙色条环"。这里只在
   *   **跨越 0.80 阈值的那一帧**排一次行程，走完即停在终点，不再重演。
   *
   * @param {boolean} wantSeq  当前是否 ≥0.80
   * @param {boolean} wasSeq   上一帧是否 ≥0.80
   * @param {number}  dt       帧间隔（秒）
   */
  _animateBasePulse(wantSeq, wasSeq, dt) {
    const uB = this.shellInnerUniforms.u_revB.value;
    if (this._baseProg == null) { this._baseProg = 1; this._baseDir = -1; }
    // 跨越阈值的那一帧 → 重新起跑一次行程（不是循环）
    if (wantSeq && !wasSeq) { this._baseProg = 0; this._baseDir = 1; }        // 擦除（半隐）
    else if (!wantSeq && wasSeq) { this._baseProg = 0; this._baseDir = -1; }  // 渐显（恢复）
    const running = this._baseProg < 1;
    if (running) this._baseProg = Math.min(1, this._baseProg + dt / BASE_PULSE_DUR);
    this._basePulseBusy = running && this._baseDir < 0;   // 只有"渐显"期间才冻结碎块下降
    /* 环增益：只在**行程进行中**给，行程走完立刻归零 → 不会在外缘留一圈常亮环。
     * 这里给的是 **0..1 包络**；实际强度 = 包络 × u_revBGain(BASE_RING_GAIN) ——
     * 两者分开才能让探针单独扫 BASE_RING_GAIN 而不动时间包络。 */
    const ringEnv = running
      ? 1.0 - THREE.MathUtils.smoothstep(this._baseProg, 0.72, 1.0) : 0;
    uB.set(this._baseProg, this._baseDir, ringEnv, 0);
    this.shellInnerUniforms.u_revBGain.value = BASE_RING_GAIN;
    // 探针可观测
    this._baseStats = {
      prog: +this._baseProg.toFixed(3),
      dir: this._baseDir,
      ring: +ringEnv.toFixed(3),
      busy: this._basePulseBusy
    };
  }

  /**
   * v5.17：粒子命中**外缘片** → 触发该片自己的脉冲（以命中点为中心、沿碎片形状向外扩散、
   * 直到覆盖满整片，**不改变碎片任何特性**）。
   *
   * 与已废弃的 `triggerImpactPulse`（面级：一面一条前沿、从面心扫出）的根本区别：
   *   · 状态挂在**片**上（每片材质本就独立克隆），不是挂在面/12 面共享；
   *   · 中心 = 真实命中点（粒子位置），不是面心；
   *   · 覆盖半径按**该片几何**给（命中点到最远顶点），所以"走到 1 = 覆盖满整片"。
   *
   * 限流：命中物理（stored / 冷却 / 回收）不受限流影响，只限**可见脉冲**的密度 ——
   * 实测撞击 ~50 次/秒，全放出来会糊成噪声（HIT_GLOBAL_GAP 0.14s ≈ 每秒 7 道）。
   */
  _triggerHitPulse(f, hx, hy, hz, simTime) {
    if ((this._hitGap ?? 0) > 0) return false;
    if (simTime - (f.hitAt ?? -99) < HIT_FRAG_GAP) return false;
    /* 基准面"渐显"（跌破 0.80 的那一次）进行中不再叠命中脉冲 —— 那是"告别"时刻，
     * 期间叠事件会互相干扰（v5.16 的老规矩，保留）。 */
    if (this._basePulseBusy === true) return false;
    const u = f.mesh.material.uniforms;
    u.u_hitP.value.set(hx, hy, hz);
    // 覆盖半径 = |命中点 − 质心| + 片包围半径 → 行程走满时必然覆盖整片
    const dr = Math.hypot(hx - f.centroid.x, hy - f.centroid.y, hz - f.centroid.z);
    u.u_hitR.value = Math.max(0.02, dr + (f.boundR ?? 0.05));
    u.u_hitT.value = 0.0;
    f.hitAt = simTime;
    this._hitGap = HIT_GLOBAL_GAP;
    this._hitEvents = (this._hitEvents ?? 0) + 1;
    return true;
  }

  /* ==================== v5.19：撞击队列（每面外圈 · 每转动间隔各中一次） ==================== *
   * 起因：旧逻辑是"粒子撞到谁就打谁"，命中分布完全由粒子轨道决定 ——
   * 实测有的外圈片几秒都轮不到一次，有的被连击。用户要的是**保证覆盖**。
   *
   * 队列构造（严格按用户给的算法）：
   *   ① 队列长度 L = n + 1 或 n + 2（随机），n = 本面最外圈碎片数；
   *   ② 把 L 个槽位洗牌，取前 n 个**互不相同**的位置；
   *   ③ 把 n 个外圈碎片洗牌后依次放进这 n 个位置 → 保证"每片至少一次"，且顺序随机；
   *   ④ 剩下 1~2 个空位用随机外圈碎片填 → 少数片被击中两次，节奏不机械。
   * 时间：在整个转动间隔里**分层随机**铺开（不是纯随机，纯随机可能扎堆）。 */
  _buildHitQueue(ring, t0, span) {
    const n = ring.length;
    if (!n) return null;
    const L = n + HIT_QUEUE_EXTRA_MIN
      + ((Math.random() * (HIT_QUEUE_EXTRA_MAX - HIT_QUEUE_EXTRA_MIN + 1)) | 0);
    // ① 槽位洗牌
    const slots = [];
    for (let i = 0; i < L; i++) slots.push(i);
    for (let i = L - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = slots[i]; slots[i] = slots[j]; slots[j] = t;
    }
    // ② 碎片洗牌
    const shuf = ring.slice();
    for (let i = shuf.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = shuf[i]; shuf[i] = shuf[j]; shuf[j] = t;
    }
    const items = new Array(L).fill(null);
    for (let k = 0; k < n; k++) items[slots[k]] = shuf[k];      // 每片一个互不相同的随机位
    for (let i = 0; i < L; i++) if (items[i] == null) items[i] = ring[(Math.random() * n) | 0];
    // ③ 时间分层随机铺开
    return items.map((fIdx, i) => ({
      fIdx, done: false,
      at: t0 + ((i + 0.5 + (Math.random() - 0.5) * 0.7) / L) * span
    }));
  }

  /** 队列定时发射：只发**到点**的项；队列本身就是密度控制，故不走 HIT_GLOBAL_GAP。 */
  _fireQueuedHit(fi, simTime) {
    const f = this.fragments[fi];
    if (!f || !f.mesh) return false;
    if (this._basePulseBusy === true) return false;   // 基准面"渐显"期间不叠事件（v5.16 老规矩）
    const pts = f.hitPts;
    const p = (pts && pts.length) ? pts[(Math.random() * pts.length) | 0] : f.centroid;
    const u = f.mesh.material.uniforms;
    u.u_hitP.value.set(p.x, p.y, p.z);
    const dr = Math.hypot(p.x - f.centroid.x, p.y - f.centroid.y, p.z - f.centroid.z);
    u.u_hitR.value = Math.max(0.02, dr + (f.boundR ?? 0.05));
    u.u_hitT.value = 0.0;
    f.hitAt = simTime;
    this._hitEvents = (this._hitEvents ?? 0) + 1;
    this._queuedHits = (this._queuedHits ?? 0) + 1;
    return true;
  }

  /** 每帧推进：窗口到期就重建队列，并发射到点的项。 */
  _updateHitQueues(simTime, active) {
    if (!this._faceRing) return;
    if (!active) {                       // 未展开：清空，下次进入重新排期
      for (const grp of this._faceRot) if (grp) { grp.hitQ = null; grp.hitQEnd = 0; }
      return;
    }
    let fired = 0, pending = 0;
    for (let fi = 0; fi < this._faceRing.length; fi++) {
      const ring = this._faceRing[fi];
      if (!ring || !ring.length) continue;
      const grp = this._faceRot[fi];
      if (!grp) continue;
      if (grp.hitQ == null || simTime >= grp.hitQEnd) {
        /* 窗口 = 到下一次转动为止（转动间隔）；太短就兜底到 HIT_QUEUE_MIN_SPAN，
         * 否则 n+1 个脉冲会挤在一瞬间糊成噪声。 */
        const span = Math.max(HIT_QUEUE_MIN_SPAN, (grp.nextAt ?? simTime) - simTime);
        grp.hitQ = this._buildHitQueue(ring, simTime, span);
        grp.hitQEnd = simTime + span;
      }
      const q = grp.hitQ;
      if (!q) continue;
      for (const it of q) {
        if (it.done) continue;
        if (simTime < it.at) { pending++; continue; }
        it.done = true;
        if (this._fireQueuedHit(it.fIdx, simTime)) fired++;
      }
    }
    this._hitQueueStats = { fired, pending, faces: this._faceRing.length };
  }

  /** 视觉标定通道（非规格项）：?tk_core=0.3&tk_field=0.8 ... 交互调参用 */
  setTune(t = {}) {
    const u = this.uniforms;
    if (t.core != null) u.u_plasma_gain.value = t.core;
    if (t.field != null) u.u_field_gain.value = t.field;
    if (t.shell != null) u.u_shell_gain.value = t.shell;
    if (t.seam != null) {
      u.u_seam_px.value = t.seam;
      this.shellUniforms.u_seam_px.value = t.seam;
      this.shellInnerUniforms.u_seam_px.value = t.seam;
    }
    if (t.seam2 != null) {
      u.u_seam2_px.value = t.seam2;
      this.shellUniforms.u_seam2_px.value = t.seam2;
      this.shellInnerUniforms.u_seam2_px.value = t.seam2;
    }
    if (t.freq != null) {
      u.u_panel_freq.value = t.freq;
      this.shellUniforms.u_panel_freq.value = t.freq;
      this.shellInnerUniforms.u_panel_freq.value = t.freq;
    }
    if (t.gainIn != null) this.shellInnerUniforms.u_shell_gain.value = t.gainIn;
    if (t.bump != null) {
      u.u_bump.value = t.bump;
      this.shellUniforms.u_bump.value = t.bump;
      this.shellInnerUniforms.u_bump.value = t.bump;
    }
    if (t.apothem != null) {
      this.shellUniforms.u_face_apothem.value = t.apothem;
      this.shellInnerUniforms.u_face_apothem.value = t.apothem;
    }
    if (t.density != null) u.u_density.value = t.density;
    if (t.steps != null) u.u_vol_steps.value = Math.round(t.steps);
    // v5.21e：`?tk_rod=`（棱线光导管增益）随该元素一并删除
    if (t.field != null) {
      this._plateGain = t.field;      // v5.10：基线值，实际增益 = _plateGain × head
      if (this.fieldGlowMaterial) this.fieldGlowMaterial.uniforms.u_gain.value = t.field;
    }
    // v5.10 消融标定：分层关掉加色层，量化各自对"总亮度"的贡献（诊断过曝元凶用）
    this._ringMul = t.ring ?? this._ringMul ?? 1.0;
    this._cageMul = t.cage ?? this._cageMul ?? 1.0;
    this._crackMul = t.crack ?? this._crackMul ?? 1.0;   // 轮廓线/断口等水晶加色项
    if (t.core2 != null) u.u_core_gain.value = t.core2;   // v5.11：内芯加色层
    if (t.coreK != null) u.u_core_struct_k.value = t.coreK; // v5.18：内芯层结构窗口
    if (t.trail != null) u.u_data_trail.value = t.trail;    // v5.18：数据流拖尾增益
    if (t.body != null) u.u_body_gain.value = t.body;     // v5.11：裂片本体亮度档
    if (t.seamw != null) u.u_seam_w.value = t.seamw;      // v5.11：轮廓环宽度（越小线越锐）
    if (t.seamA != null) u.u_seam_amp.value = t.seamA;    // v5.11：轮廓线底线幅度
    if (t.wallA != null) u.u_wall_amp.value = t.wallA;    // v5.11：断口反光
    if (t.pulse != null) u.u_pulse_gain.value = t.pulse;  // v5.13：循环脉冲幅度（0=关，消融用）
    if (t.crack != null) { u.u_crack_mul.value = t.crack; this.shellUniforms.u_crack_mul.value = t.crack; this.shellInnerUniforms.u_crack_mul.value = t.crack; }
  }

  /** 正交相机必须显式给出视线方向（见顶点着色器注释） */
  setCameraForward(v) { this.uniforms.u_cam_forward.value.copy(v); }

  /** 视觉增强总开关：false → 回退到规格字面渲染 */
  setEnhancements(on) {
    this.coreMaterial.uniforms.u_vol_steps.value = on ? 32 : 0;
    /* v5.21：这三条**必须回读 setLayer 的记录**再决定 —— 否则 FX 总开关一开
     * 就把用户在「几何与分层」里取消勾选的诊断线框 / 棱线光导管重新点亮。 */
    const lf = this._layerFlags || {};
    if (this.fieldGlow) this.fieldGlow.visible = !!on && lf.fieldGlow !== false;
    // v5.21e：棱线光导管已整体移除，这里不再需要处理它
    this.cageGhost.visible = !!on && lf.cage !== false;
    // 规格字面档：内壳不做展开形变（v5.3：散热鳍已按用户要求整体移除）
    this._deployAllowed = !!on;
    this.shellUniforms.u_bump.value = on ? 0.85 : 0.0;
    this.shellInnerUniforms.u_bump.value = on ? 0.85 : 0.0;
    // 回退档：外壳恢复规格字面的普通半透明混合（预乘法会改变暗底呈现）
    for (const mat of [this.shellMaterial, this.shellInnerMaterial]) {
      mat.blending = on ? THREE.CustomBlending : THREE.NormalBlending;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.needsUpdate = true;
    }
  }

  /**
   * 层级显示开关。关闭即彻底隐藏：obj.visible=false 在 three.js 中既不被渲染、
   * 也不写深度缓冲、不参与拾取/后处理掩膜 —— 不会"隐藏了但干涉还在"。
   * 基准面（shellInner）是旋转基石，按用户要求不提供关闭（几何始终在场，仅随展开淡出）。
   * @param {string} name  fragments | core | particles | fieldGlow | cage
   * @param {boolean} on
   */
  setLayer(name, on) {
    const v = !!on;
    /* v5.21：记录层级开关状态 —— setEnhancements 会重写 coreRods / cageGhost 的
     * visible，若不回读这份记录，"默认关掉的诊断线框"会被 FX 总开关重新打开。 */
    this._layerFlags = this._layerFlags || {};
    this._layerFlags[name] = v;
    switch (name) {
      case 'fragments':        // 水晶碎块 / 外壳（285 片外甲，含其内芯发光子层）
        for (const f of this.fragments) f.mesh.visible = v;
        break;
      /* v5.21e：'core' 现在只对应核心本体（棱线光导管已整体删除，
       * 不再需要 v5.21d 那套父子层同步）。 */
      case 'core':
        this.coreMesh.visible = v;
        break;
      case 'particles':        // 能量环粒子流（环截面内漂移的点）
        for (const rg of this.ringGroups) if (rg.flow) rg.flow.visible = v;
        break;
      case 'fieldGlow':        // 约束场辉光板
        if (this.fieldGlow) this.fieldGlow.visible = v;
        break;
      case 'ambient':          // Phase1b：环境能量粒子（吸附/冷却载体）
        this._ambientLayerOn = v;
        if (this.ambientPoints) this.ambientPoints.visible = v && (this._energyP >= DEPLOY_START);
        break;
      case 'cage':             // 笼线（诊断骨架）
        this.cage.visible = v;
        this.cageGhost.visible = v;
        break;
      default:                 // 基准面（shellInner）：旋转基石，始终显示，不提供关闭
        break;
    }
  }

  /* v5.21e：`_syncCoreLayers()` 已删除 —— 它存在的唯一理由是维护
   * 「核心 ↔ 棱线光导管」的父子可见性，而光导管已整体移除。 */

  /** 每帧同步 CPU 侧解算结果 → uniform */
  sync({ mainParam, simTime, phase, intensity, color, shellAlpha, jitter, jitterVec }) {
    const u = this.uniforms;
    u.u_main_param.value = mainParam;
    u.u_time.value = simTime;
    u.u_phase.value = phase;
    u.u_emissive_intensity.value = intensity;
    u.u_emissive_color.value.copy(color);

    // v5.6 水晶色 = 强调色同源派生：保留其色相（同源），但把饱和压到 ~0.3、
    // 明度提到 0.82，再向冰白拉 0.55 —— 得到"被这束能量照亮的矿物"而不是"第三块颜色"。
    // 于是水晶与构造体是**同源异质**：同色相族，靠明度/饱和度/高光/透明感区分。
    if (!this._crystalCol) { this._crystalCol = new THREE.Color(); this._hsl = { h: 0, s: 0, l: 0 }; }
    color.getHSL(this._hsl);
    this._crystalCol.setHSL(this._hsl.h, Math.min(0.26, this._hsl.s * 0.26), 0.84);
    this._crystalCol.lerp(CRYSTAL_ICE, 0.66);
    u.u_crystal_tint.value.copy(this._crystalCol);
    u.u_shell_alpha.value = shellAlpha;

    // 正交相机视线方向 → 内层物体空间（体积积分的步进方向 = 相机前向）
    this.coreMesh.getWorldQuaternion(this._q).invert();
    this._v.copy(u.u_cam_forward.value).applyQuaternion(this._q);
    u.u_ray_dir_local.value.copy(this._v);

    // 5.6.3 微抖动仅作用于内层核心
    if (jitterVec) {
      this.coreMesh.position.copy(jitterVec);
      // 再叠一点极轻微的姿态摆动：只有平移的话，看起来像贴图在滑，不像悬浮体在颤
      this.coreMesh.rotation.set(jitterVec.y * 1.7, jitterVec.x * 1.7, jitterVec.z * 1.1);
    } else {
      this.coreMesh.position.set(jitter, jitter * 0.6, jitter * 0.4);
    }
    // v5.21e：棱线光导管已移除 —— 原先在这里让两根管子跟随核心的微抖动位移/姿态

    const p = Math.min(1.0, Math.max(0.0, mainParam));
    this._energyP = p;
    const hot = Math.min(intensity / 3.5, 1.0);

    // 约束场辉光：广告板反向旋转（抵消 assembly 自旋，保持始终面向相机）+ 参数驱动
    // 注意：main.js 里 sync() 先于 assembly 自旋更新一帧执行，自旋很慢，一帧滞后不可感知
    this.group.getWorldQuaternion(this._qGlow).invert();
    this.fieldGlow.quaternion.copy(this._qGlow);
    const gu = this.fieldGlowMaterial.uniforms;
    gu.u_time.value = simTime;
    gu.u_pC.value = Math.max(0.0, p - 0.04) * 1.05;   // Round F：能量为 0 时约束场辉光完全熄灭（0.55 基线在 p=0 留下 68% 功率的周期白团扩散）；随能量线性提升
    gu.u_eN.value = hot;
    // v-new（冷却叙事）：约束场是"冷"结构 —— 不复制能量色（高能=橙），
    // 改恒定冷青，避免 4.6u 满屏加色平面把冰蓝碎片整体染暖（headless 实测主暖源）。
    gu.u_color.value.setRGB(0.15, 0.60, 1.0);
    // v5.10 亮度余量：展开态同时涌现「碎棱片 + 环状雾带 + 断口反光」，实测整帧平均亮度
    // 在 0.80 处跳了 +92%（p=0.79 → 1.0）。这些新层本就该接管视觉，旧的常驻加色层
    // （辉光板 / 笼线 / 棱线 / 水晶内芯）必须让出余量，否则叠成一片亮。
    const head = 1.0 - 0.40 * Math.min(1, Math.max(0, this._deploy));
    gu.u_gain.value = (this._plateGain ?? 1.0) * head * (1.0 - 0.55 * (this._deploy || 0));

    // Phase1b/d：每面吸收量先清零，再于 _animateDeploy 内逐片累计
    for (let k = 0; k < 12; k++) this._faceAbsorbed[k] = 0;

    const dt = Math.min(0.05, Math.max(0, simTime - (this._lastSimTime ?? simTime)));

    // 激发态：内层壳展开为散热模式（必须在 p / hot 求值之后）
    this._animateDeploy(p, simTime, hot);
    this.updateAmbientParticles(simTime, dt);
    this.updateChargeField(simTime);   // v5.19：储能态能量粒子流（逐帧跟随碎片平移+自转）
    this.updatePulseColumns(simTime);  // v5.20：脉冲柱面（钉在基准面与晶体板顶面之间）

    /* v5.13e → v5.16（A1，用户本轮拍板）：外甲裂片外推后，基准面**不再完全隐藏**，
     * 改为淡到 **BASE_GHOST_FLOOR(0.40)** 的"幽灵态"。
     * 用户原话："选项1，也不需要非常非常淡，20%不透明度左右。同时我的描述里说了
     *   基准面和水晶是两个部分，之前完全隐藏的设定可以舍弃了"
     * 最终展开态的不透明度 = BASE_GHOST_FLOOR(0.40) × BASE_HIDE_LEVEL(0.50) = **0.20**。
     * （BASE_HIDE_LEVEL 由基准面擦除前沿在片元里施加，见 FRAG 的 u_revB 段。）
     * 保留幽灵态后，80 阈值的"细线环脉冲 + 擦除半隐"才有一层可依附的载体 ——
     * 这层原本在旧设定下是不可见的。 */
    const innerFade = 1.0 - (1.0 - BASE_GHOST_FLOOR)
      * THREE.MathUtils.smoothstep(this._deploy, 0.0, 0.55);
    this.shellInnerUniforms.u_shell_alpha.value = shellAlpha * innerFade;
    this.shellInnerUniforms.u_shell_fade.value = innerFade;   // v-new：真正门控内壳颜色
    /* v5.17：幽灵态结构线亮度补偿 —— 高能段把基准面的**发光框架**提亮，
     * 抵消 u_shell_fade 对颜色的压制（用户："高能状态不该这么暗"）。
     * 只作用 c，alpha 仍按 u_shell_fade → 依旧"能看穿的幽灵框架"。
     *
     * ★ 补偿量 = 瞬时衰减的倒数，而不是 p 的函数（g14c 实测修正）：
     *   暗化 = 擦除 bVis(_baseProg，时间) × 幽灵 innerFade(_deploy，时间)，
     *   两段都是**随时间**走的；p 是瞬间到位的。用 p 驱动会先炸亮后回落，
     *   用户看到的仍是"过一会儿变暗"。这里让补偿与暗化同步升起。 */
    const _prog = this._baseProg ?? 1;
    // _baseDir>0 = 正在擦除（越擦越隐）；<0 = 正在渐显（越显越亮）
    const _hidden = this._baseDir > 0 ? _prog : (1 - _prog);
    const _wipeAtten = 1.0 - (1.0 - BASE_HIDE_LEVEL) * _hidden;
    const _atten = Math.max(0.08, innerFade * _wipeAtten);
    const _need = 1.0 / _atten;   // 完全补平所需倍数（settled 时 = 1/0.20 = 5.0）
    this.shellInnerUniforms.u_base_boost.value = Math.min(BASE_BOOST_MAX,
      1.0 + (_need - 1.0) * THREE.MathUtils.smoothstep(p, 0.76, 0.94) * BASE_BOOST_MIX);

    /* v5.18：基准面沿法线抬升（用户："看不出来有一层面包着"）。
     * · 展开（_wantSeq）：随碎块外推一起抬起 —— 用 _deploy 的 0→0.55 段，
     *   与"碎片面上升"同步，正是用户要的"碎片面上升的时候基准面也抬升"。
     * · 收回（!_wantSeq）：**在同一个 _baseProg 渐显行程里归零**。
     *   关键：BASE_PULSE_DUR(0.42s) 期间 _deployT 本来就被 holdDeploy 冻住，
     *   所以基准面在这段已存在的窗口内合拢 —— 碎片开始下落时它早已严丝合缝，
     *   顺序是「渐显 → 合拢 → 下落」，且**总时长一分不增**，
     *   满足用户硬约束"渐显+下落时间不能超过目前碎片面回位+下落的时间"。 */
    const _liftEnv = this._wantSeq
      ? THREE.MathUtils.smoothstep(this._deploy, 0.0, 0.55)
      : 1.0 - THREE.MathUtils.clamp(this._baseProg ?? 1, 0, 1);
    this.shellInnerUniforms.u_lift.value = BASE_LIFT * _liftEnv;
    this._baseLift = +this.shellInnerUniforms.u_lift.value.toFixed(5);  // 探针可观测

    // v-new：笼框/幽灵框是结构件 → 恒冷青（结构冷、能量暖）；亮度仍随 p/head 走
    const coldC = this._coldColor || (this._coldColor = new THREE.Color(0.15, 0.60, 1.0));
    this.cageMaterial.color.copy(coldC);
    this.cageMaterial.opacity = (0.45 + 0.50 * p) * head * (this._cageMul ?? 1.0);
    this.cageGhostMaterial.color.copy(coldC);
    this.cageGhostMaterial.opacity = (0.12 + 0.26 * p) * head * (this._cageMul ?? 1.0);

    // v5.21e：棱线光导管的逐帧颜色/透明度驱动（rodGain / rodHead / rodContain）已随之删除
  }

  dispose() {
    this.fragments.forEach((f) => f.geo.dispose());   // 本体与内芯层共享同一几何，释放一次即可
    [this.coreMesh, this.shellInner, this.cage, this.cageGhost,
      this.coreRods, this.fieldGlow].forEach((m) => m.geometry.dispose());
    // v5：能量环流的导管/粒子几何与材质（旧 comet 实现已删除）
    this.ringGroups.forEach((rg) => {
      rg.group.children.forEach((ch) => {
        ch.geometry?.dispose?.();
        ch.material?.dispose?.();
      });
    });
    this.coreMaterial.dispose();
    this.shellMaterial.dispose();
    this.shellInnerMaterial.dispose();
    this.fragCoreMaterial.dispose();
    this.fieldGlowMaterial.dispose();
    if (this.ambientTrails) { this.ambientTrails.geometry.dispose(); this.ambientTrails.material.dispose(); }
    this.coreRodMaterial.dispose();
    this.cageMaterial.dispose();
    this.cageGhostMaterial.dispose();
  }
}
