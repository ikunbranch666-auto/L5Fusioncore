# A：碎片颜色全部贡献项清单 + 白化路径判定（逐行审计）

- 审计对象：`src/gfx/l5Core.js`（全文 3613 行，已逐行读完；只读，未改任何源文件）
- 交叉核对：`src/gfx/dodecaKit.js`（band / aShard / radialN / pushAmt 来源）
- 口径：p = MainParam（0~1）；p=0.5=闭合中段，p=0.9=展开稳态。所有行号为当前磁盘文件行号。

---

## 0. 先给三个最硬的代码事实结论

### 0.1 u_cool 对 band3 是否可能失效？——**否（明确判定）**
- 每片 `stored` 在命中处 `L2571` 递增（`f.stored = Math.min((f.stored||0)+1, _FRAG_STORE_CAP)`）。
- `_animateDeploy` 的逐片循环 `L2820`（`for (const f of this.fragments)`）里，**每一帧、对每一片（含全部 88 片 band3）**执行 `L2841`：
  `fmat.uniforms.u_cool.value = Math.min((f.stored||0) * this._COOL_PER, this._COOL_MAX)`。
- `fmat = f.mesh.material`（`L2834`），而 `f.mesh.material` 就是该片在 `L1998` 克隆的 `fMat`；该片的 `u_cool` 入口在 `L1985` 是**逐片独立 `{value:0.0}`**（`Object.assign` 浅拷贝时覆盖了 `shellUniforms` 的共享条目）。
- **没有任何代码路径**让某片 `stored++` 而 `u_cool` 不更新：`L2841` 不按 band/face/index 挑片，对 `this.fragments` 全量执行；也不存在"写到错误材质对象"——`L2579`/`L2843` 用的都是同一个 `f.mesh.material`。
- band3 组池修复（`L2083 if (f.band===3)`）只改 `_fragRingIdx/_faceRing`（选目标池），**不重排 `this.fragments` 数组顺序**；队列 `it.fIdx`（`L3328`）直接索引 `this.fragments[fi]`，与 `L2820` 循环同源同序。**材质列表/更新循环与碎片数组无错位。**
- 因此："某 band3 片 stored 高但 u_cool 不更新"在代码里**不存在**。若实测看到"击打很多却不变色"，原因不在 u_cool 写回，而在 **u_cool 本身的视觉方向是"变冷蓝"而不是"变白"**（见 0.2）。

### 0.2 u_cool 让碎片变"蓝"，不让它变"白"——这是"stored 高也白不了"的代码根因
GLSL 侧三项（`L1265-1267`）：
```
L1265  c *= mix(vec3(1.0), coolShift=(0.74,0.86,1.00), u_cool);
L1266  c += vec3(0.07,0.12,0.20) * u_cool;
L1267  alpha = clamp(alpha * (1.0+0.45*u_cool), 0.0, 0.97);
```
- 满档 u_cool=0.5 时：R 通道 ×0.87（**压暗**）、G ×0.93、B ×1.0；加色 `(0.035,0.06,0.10)`（B 加得最多）。
- 白块口径是"亮度>150 且 R>140 且 B>140"（≈RGB 都高）。u_cool 同时**压 R、补 B**，方向是把像素推向蓝，而不是推向白。它唯一的增亮通道是 L1266 的加色，但 R 只加 0.035，远不足以把一片中灰碎片抬到 R>140。
- 结论：**stored→u_cool 在物理上不可能产生"白块"签名**（R、B 同时高）。用户观察到"stored 高也白不了"是代码的**预期行为**，不是 bug；"白"必然来自其它项（见 §7 分桶）。

### 0.3 "内部片 stored=0 也白"的最强代码嫌疑：envProc 灯带反射（视角/身份静态）
- 晶体本体基色 `L994`：`c = mix(envT*absorb*(0.55+0.45*tint), envR, fres)`，其中 `L965 envR = envProc(R)*0.76`。
- `envProc`（`L769-782`）内置两条竖直灯带：`L776 sky += vec3(0.95,0.98,1.0)*(bar1*0.90+bar2*0.42)*smoothstep(0.02,0.70,up)`。灯带色 `(0.95,0.98,1.0)` ≈ 白，峰值强度约 `0.90+0.42≈1.32`，再 ×0.76 ≈ **(0.72,0.75,0.77) 的近白反射**。
- 该反射**只取决于该片棱面法线 `N` 是否把灯带反射进视线**（`R=reflect(-Vd,N)`，`L963`），与 stored / 撞击 / band 完全无关。棱面法线由 `computeVertexNormals()` 逐三角面常量给出（`L886-889` 注释、`L1770`），所以**每片每棱面的"白不白"是静态身份属性**——这正好解释"有些内部片 stored=0 也是白的"。
- 掠射角 fres→1 时 `c≈envR`（`L994` mix 权重），边缘片更容易读白。

---

## 1. 外壳碎片片元着色器（晶体分支 L955–L1329）每一个写进输出颜色的项

晶体分支门控：`u_shell_id∈(0.5,1.5)`（L871）且 `u_core_layer<0.5`（L876 已提前 return）且 `u_petal>0.5`（L955）。碎片材质 `u_petal=1.0`（L1906）。

### 1.1 公共派生量（所有项共享）
| 量 | 行号 | 公式 | p=0.5 取值 | p=0.9 取值 |
|---|---|---|---|---|
| safeParam | L851 | clamp(u_main_param,0,1) | 0.5 | 0.9 |
| eN | L858 | clamp(u_emissive_intensity/3.5,0,1) | ≈0.34(intensity≈1.2)~1.0(满能) | ≈0.5~1.0 |
| eC | L859 | 0.60+0.75·pow(eN,0.55) | ≈0.99 | ≈1.04~1.35 |
| **pC** | L860 | 0.55+0.45·pow(safeParam,0.70) | **0.827** | **0.968** |
| facing | L865 | clamp(dot(nView,Vd),0,1) | 视角相关 | 视角相关 |
| lambert | L867 | max(dot(nWorld,KEY),0) | 静态(随齿轮转) | 静态 |
| closed | L943 | 1−smoothstep(0,0.18,u_deploy) | 1（deploy=0） | 0（deploy=1） |
| frost | L944 | (0.45,0.72,1.05) | 常数 | 常数 |

门控 uniform 在两个工况的稳态取值：
- u_deploy：p=0.5 → **0**（未越 0.80）；p=0.9 → **1**（L2782 `this.uniforms.u_deploy.value=d`，_deploy 经 DEPLOY_DUR=1.15s 到位）。
- u_shell_form：p=0.5（≥0.20）→ **1**（L2729-2733，SHELL_FORM_DUR=0.75s 后铺满）；p=0.9 → **1**。
- u_seam_form / appear：p=0.5（≥0.35）→ **1**；p=0.9 → **1**（L3031-3035）。
- u_pulse_gate：p=0.5 → **≈1**（L3066-3069：seamT=1→1；p=0.5<0.76→1；bt=0→1）；p=0.9 → **0**（p>0.8 第二因子 0）。
- u_cool：p=0.5 展开未发生、wantSeq=false，stored 被 drain（L2838-2839）→ **≈0**；p=0.9 wantSeq=true 不 drain，被击片可达 **0.5 封顶**。

### 1.2 乘性项（c *= ）逐条
| # | 行号 | 公式 | 门控 | p=0.5 因子 | p=0.9 因子 | 最大亮度贡献估算 |
|---|---|---|---|---|---|---|
| M1 | L994 | `c = mix(envT*absorb*(0.55+0.45*tint), envR, fres)` 本体基色 | 始终 | 见 0.3 | 同 | envR 峰值≈(0.72,0.75,0.77)；envT≈envProc·absorb，absorb≈exp(−σ·path)≈0.5~0.9。本体典型 c≈0.10~0.30，灯带命中棱面≈0.7+ |
| M2 | L999 | `c *= mix(1, clamp(tint*1.02+0.06,0,0.95), 0.32*u_deploy)` | u_deploy | ×1.00 | ×(0.843,0.934,0.984) | 闭合态无；展开态 R 压 ~16%，小幅偏冷 |
| M3 | L1012 | `c *= 0.26+0.74*pow(key,1.25)`，key=dot(N,Lw) | 始终 | 背光面×0.26，顺光×1.0 | 同 | **最大压暗项**：背阴棱面本体砍到 26%；拉开面间明暗 |
| M4 | L1027-1029 | `facetGain = mix(1, 1+(0.12+0.18pC)·u_facet_jit·(shardSeed*2−1), step(0.5,u_petal))`；`c*=facetGain` | u_petal=1（恒真） | 0.12+0.18·0.827=0.269 → **[0.731,1.269]** | 0.12+0.18·0.968=0.294 → **[0.706,1.294]** | **静态身份项**：最亮片比最暗片亮 ~1.78×；均值恒 1。shardSeed 由 aShard 静态烘焙（dodecaKit L680-682），不随时间/撞击变 |
| M5 | L1041 | `c *= 0.72*u_body_gain` | 始终 | ×0.72 | ×0.72 | 本体整体压 28%（预乘混合下减遮挡力） |
| M6 | L1114 | `c *= 1−0.42*groove*appear`，groove≈pow(seamEdge,0.8)·(1−pow(seamEdge,2)) 峰值~0.25 | appear=1 | 缝旁 c×≈0.895 | 同 | 暗槽：线旁本体压 ~10%，为亮线留对比 |
| M7 | L1128-1131 | 硬钳：`if(max(c)>0.85) c*=0.85/max(c)` | 始终 | 触发即钳到 0.85 | 同 | **本体绝不出 bloom**：任何棱面本体峰值被压到 0.85 以下 |
| M8 | L1237 | `c *= shellVis` | u_shell_form | 1（已铺满） | 1 | 稳态无；仅在 p 穿越 0.20~0.35 的渐显行程中有 0/1 边界 |
| M9 | L1241-1242 | `reveal=mix(0.42,1,smoothstep(0,0.40,u_deploy)); c*=reveal` | u_deploy | **×0.42** | ×1.0 | 闭合态碎片本体整体砍 58%（让基准面透出）；展开态全量 |
| M10 | L1253 | `c *= mix(1, wallVis, vWall)`，wallVis=mix(0.60,1,smoothstep(0.02,0.30,u_deploy)) | 仅 vWall=1 断口侧壁 | ×0.60（侧壁） | ×1.0 | 只作用断裂侧壁顶点，闭合态侧壁压到 0.60 |
| M11 | L1265 | `c *= mix(1, coolShift=(0.74,0.86,1.0), u_cool)` | u_cool | ×1.00 | 满档×(0.87,0.93,1.0) | **压 R/G、补 B→变冷蓝，不增白**（见 0.2） |
| M12 | L1325-1326 | 安全钳：`if(max(c)>1.5) c*=1.5/max(c)` | 始终 | 不触发 | 加色线才触发 | 只允许细线越 1.0，峰值兜在 1.5 |

### 1.3 加性项（c += ）逐条
| # | 行号 | 公式（简写） | 门控 | p=0.5 量级 | p=0.9 量级 | 对白块(R&G&B 同高)的贡献 |
|---|---|---|---|---|---|---|
| A1 | L1035 | `c += innerCol·(0.02+0.045pC)·(0.35+0.65eN)·(1−fres)·absorb·facetGain`；innerCol=frost·1.042≈(0.47,0.75,1.09) | 始终 | (0.02+0.037)=0.057×…≈**0.02~0.04** | ≈0.02~0.04 | 冷蓝小量，B 高 R 低，**不白** |
| A2 | L1136-1140 | 轮廓底线：`+= mix(emissive*1.25,tint,0.42)·pow(seamEdge,2.2)·mix(0.92,1.12,vRim)·(0.46+0.20pC)·(0.65+0.35lambert)·appear·crack_mul·seam_amp·(filled·0.95+head·1.5)` | appear=1；seamEdge>0（仅轮廓线像素） | 线心峰值≈emissive·1.25·0.56·…≈**0.2~0.35** | 同（head=0 后） | 颜色=能量色 58%+矿物色 42%，**偏色不白**（除非 emissive 近白） |
| A3 | L1142 | 轮廓循环脉冲：`+= pulseCol·pow(seamEdge,1.8)·mix(0.9,1,vRim)·pulse·1.05·pulse_gain·pulse_gate`；pulseCol=mix(emissive·1.55,**vec3(1.0)**,0.35) | pulse_gate | gate=1，**活动** | gate=0，**熄灭** | 35% 白注入，是少数偏白的线；仅 p∈0.35~0.80 存活 |
| A4 | L1144 | 0.80 爆发：`+= pulseCol·pow(seamEdge,1.8)·mix(0.75,1,vRim)·bInst·1.05` | u_burst（仅越阈后 0.72s） | 0 | 瞬态事件 | 同 pulseCol，事件性闪一下，非常驻 |
| A5 | L1158-1162 | 断口侧壁反光：`+= mix((0.85,0.92,1.0),frost,0.35)·pow(1−ndv,3)·0.15·mix(0.55+1.7wallOuter,1+0.9wallOuter,smoothstep(0,0.30,deploy))·crack_mul·wall_amp` | 仅 vWall=1 | ×0.55 档≈**0.08** | ×1.0~2.7 档≈**0.15~0.30** | 冷青白，侧壁掠射处；展开后外圈侧壁更亮 |
| A6 | L1165 | 边光：`+= emissive_color·pow(1−ndv,3.5)·(0.10+0.20pC)·(0.40+0.25·u_deploy)` | 始终 | (0.10+0.165)·0.40=0.106·emissive | (0.10+0.194)·0.65=0.191·emissive | 能量色（青→橙），**不白**；展开后 ×1.8 |
| A7 | L1169 | 星云气流：`+= innerCol·neb·(0.02+0.05pC)·(0.35+0.65eN)·facetGain`，neb=smoothstep(0.30,0.88,fbm) | 始终 | ≈0.03~0.06 | ≈0.03~0.06 | 冷蓝，稀疏，不白 |
| A8 | L1305-1306 | 片级撞击脉冲线：`+= mix((0.66,0.88,1.0),emissive,0.22)·(hLine+hShape·0.55)·u_hitGain(=2.10)·(0.45+0.55lambert)` | u_hitT≥0（命中后 0.46s） | 未展开无队列 | 线峰值≈2.1·0.7·…≈**0.8~1.2** | 冷青白加 emissive 22%；细线、瞬态，越 1.0 触发 bloom |
| A9 | L1308 | 撞击数据拖尾：`+= (0.42,0.80,1.0)·hTrail·u_data_trail(=0.35)·(0.35+0.65lambert)` | 同上 | — | ≈0.1 | 冰蓝细流，不白 |
| A10 | L1316 | 水晶壳显现亮折线：`+= shellPulseCol·shellLine·SHELL_FORM_EDGE(=2.0)·shellArc·(0.45+0.55lambert)`；shellPulseCol=mix(emissive,(0.82,0.93,1.0),0.45) | shellExit：稳态铺满后=0 | 已铺满→**0** | 0 | 仅 p 穿越 0.20~0.35 行程中的前沿线，非常驻 |
| A11 | L1320 | 显现数据拖尾：`+= (0.42,0.80,1.0)·shellTrail·u_data_trail·(0.35+0.65lambert)` | 同 A10 | 0 | 0 | 同上 |

### 1.4 片层（u_core_layer=1，L876-937，每片第 2 层、AdditiveBlending）
- `L928-930 cCore = coreCol(=(0.36,0.54,0.80)·0.92≈(0.33,0.50,0.74))·glowC·breath·gate·(0.30+0.70pC)·(0.35+0.65eN)·(0.55+0.45fall)`
- glowC=(0.30+0.70·facet)·(0.40+0.60·rimC)，峰值 1.0；gate=appearB（p≥0.20=1）。
- p=0.5 峰值≈0.33·0.88·0.68≈**(0.07,0.11,0.16)**；p=0.9 同量级。输出 `L936 cCore·u_core_gain·mix(1,wallVisC,vWall)`，alpha=0.30·glowC·mix(1,wallVisC,vWall)。
- 颜色 **B≫R**，加色叠加，**不是白块来源**；但它是"stored=0 也亮"的静态身份项之一（facet 静态）。

---

## 2. 透明度 / 合成链

### 2.1 碎片最终 alpha 公式（L1233, L1238, L1243, L1254, L1267）
```
alpha = clamp(0.42 + 0.30·fres + 0.18·u_deploy, 0, 0.92)   // L1233
alpha *= shellVis                                            // L1238（稳态=1）
alpha *= reveal   // reveal=mix(0.42,1,smoothstep(0,0.40,u_deploy))  L1241/1243
alpha *= mix(1, wallVis, vWall)                              // L1254
alpha = clamp(alpha·(1+0.45·u_cool), 0, 0.97)               // L1267
```
- fres=0.05+0.95·pow(1−ndv,4)：正面 ndv≈1→fres≈0.05；掠射→fres≈1。
- **闭合态 p=0.5**：reveal=0.42。正面 alpha≈(0.42+0.015+0)·0.42≈**0.183**；掠射 alpha≈(0.42+0.30)·0.42≈**0.302**。
- **展开态 p=0.9**：reveal=1，u_deploy=1。正面 alpha≈0.42+0.015+0.18≈**0.615**；掠射≈clamp(0.90+0.18,0,0.92)=**0.92**。
- u_cool=0.5 满档再 ×1.225 → 正面 0.75，掠射顶到 0.97。
- 全范围 **0.18 ~ 0.97**，与任务给的 0.42~0.97 区间一致（下限在闭合正面被 reveal=0.42 压到 0.18）。

### 2.2 混合模式 / depth / renderOrder（构造器）
- 碎片本体材质 `_shellMaterial`（L1867-1879）：`transparent:true, depthWrite:false, depthTest:true, side:DoubleSide, CustomBlending, blendSrc=OneFactor, blendDst=OneMinusSrcAlphaFactor` —— **预乘 alpha 加性合成**：`out = src.c + dst.c·(1−src.a)`。
- 内芯层 fragCoreMaterial（L1966-1975）：`transparent, depthWrite:false, blending=AdditiveBlending, FrontSide`。
- coreMaterial（L1883-1890）：`transparent:false, depthWrite:true`（唯一写深度的不透明层）。
- **renderOrder**：fieldGlow/cageGhost=29 → core=30 → shellInner=31 → 碎片 mesh=32 → cage/ambient=33 → fragCore(碎片子层)/ringFlow=34。
- 绘制顺序（同 order 内 three.js 按距离/插入序）：**core(不透明,写深度) → shellInner(基准面,预乘) → 碎片(预乘) → 笼线/粒子(加色) → 内芯层(加色)**。

### 2.3 白块像素可能由哪层贡献（合成关系）
预乘合成下，碎片画在 shellInner **之上**：`out = frag.c + shellInner.c·(1−frag.alpha)`。
- 闭合态碎片 alpha≈0.18~0.30 → shellInner 约 **70%~82% 的颜色透上来**。即：用户看到的"碎片表面"的亮白，**大部分光学上是后面的 shellInner 透过来的**。
- 这直接解释今晨消融：p=0.65 关 shellInner → 白块 1.89%→0.09%（L1386 注释同口径：隐藏 shellInner 后壳带亮度 0.422→0.219，−48%）。
- **与用户"35-80 发白肯定不是基准面"的矛盾的代码侧解释**：闭合态碎片 alpha 只有 ~0.2，白点亮斑在**像素位置**上落在碎片轮廓里，但**在光路上是 shellInner 的白色项透过滤镜碎片透上来的**——用户视觉上归因为"这块碎片白"，实则是它身后那层面在发光。要证伪/坐实：需要无头实测把碎片层 setLayer('fragments',false) 与单独关 shellInner 做正交采样（见 §8 判据）。

---

## 3. 每片数据流全链路（重点核查 u_cool / band3 错位）

### 3.1 fragments 构造
- `L1976 this.fragments = buildFaceFragments(R_SHELL_OUT).map(...)`。
- dodecaKit：每面 4 环带 band0~3（t1≈0.20-0.28 / t2≈0.42-0.52 / t3≈0.68-0.78，dodecaKit L384-387）；band3=最外圈。每片 `band=bi`（L652）。全场景 band3 共 88 片。
- shardSeed：`dodecaKit L680 shardSeed=det(m.seq*12.9898+3.17)`，L681-682 作为 `aShard` 顶点属性**整片统一填充** → 着色器 `L1022 shardSeed=fract(sin(vShard*127.1+11.7)*43758.5453)`。**静态、烘焙、不随时间/撞击/能量变化**。
- 每片克隆材质：`L1983 fUniforms=Object.assign({}, this.shellUniforms, {u_impact, u_cool:{value:0}, u_rev, u_revGain, u_hitP, u_hitT, u_hitR, u_hitGain})`；`L1998 fMat=this._shellMaterial(fUniforms)`。共享 uniform（u_deploy/pC 经 u_main_param/emissive/u_facet_jit 等）仍引用 shellUniforms/主 uniforms；**u_cool/u_hitP/u_hitT/u_impact 为逐片私有**。
- 返回对象 `L2009 {…f, mesh, core, mat:fMat, stored:0, impactW:0}`。

### 3.2 v5.22 撞击队列 → stored → u_cool
1. 组池：`L2083 if (f.band===3)` → `_fragRingIdx`、`_faceRing[faceIdx]`（修复后 88/88）。
2. 队列排程：`L3025 _updateHitQueues(simTime, wantSeq && d>=0.98)`（仅展开到位后）；`L3218 _buildHitQueue` 每面外圈 n 片洗牌放进 n+1~n+2 槽。
3. 指派粒子：`L3335 _assignHitParticle(it.fIdx)` → 选最近巡航粒子，`A.mode=2, assigned=1`（L3301-3302）。
4. 命中：粒子飞至 `dist<0.16`（L2569）→ `L2571 f.stored=min(stored+1, _FRAG_STORE_CAP=60)`；同帧 `L2587-2596` 若 assigned 则写 u_hitP/u_hitR/u_hitT=0（片级脉冲与 stored 同帧对齐）。
5. u_cool 写回：`L2841` 每片每帧 `u_cool.value=min(stored·_COOL_PER(=0.09), _COOL_MAX(=0.5))`。
6. drain：`L2838-2839` 仅当 `!wantSeq`（p<0.80）时 `stored=max(0, stored−dt·_STORED_DRAIN=40)`。
7. **展开/闭合时 stored 是否清空**：代码里**没有任何"展开/合拢时 stored 清零"的语句**。drain 只在 p<0.80 时以 40/s 衰减（满档 60 → 1.5s 清空，L2229 注释）。即：p>0.80 期间 stored **只增不减**（封顶 60≈u_cool 0.5）；跌回 0.80 后才开始泄。

### 3.3 重点核查结论（单独突出）
- **是否存在 stored 增加但 u_cool 不更新的路径？否。** `L2841` 对 `this.fragments` 全量无差别执行，命中（L2571）与写回（L2841）操作同一 `f`，材质对象同为 `f.mesh.material`。
- **是否存在 u_cool 写到错误材质对象？否。** 片级 `u_cool` 是 `L1985` 私有条目；L2834/2572 都取 `f.mesh.material.uniforms`，不会写到 shellUniforms（基准面/共享）那份。
- **band3 修复后材质列表/更新循环索引是否错位？否。** 组池只消费 `fi`，不重排数组；`L2820` 用 `for(const f of this.fragments)` 按对象引用遍历，与索引无关。
- 旁证：`L2843 fmat.uniforms.u_impact.value.w=f.impactW` 同样全片写；今晨"260 次命中全指派 0 兜底"与 `L3339` 兜底仅在 2s 无巡航粒子时触发一致。

---

## 4. 展开动画 / 关键 uniform 来源

- u_deploy 赋值：`L2782 this.uniforms.u_deploy.value = d`（d=`this._deploy`，弹簧趋近 smoothstep 后的 _deployT，L2770-2779）。仅 >0.80 后经 SEAM_BURST(0.72s)+DEPLOY(1.15s) 才到 1。
- u_shell_form：`L2733 = _shellT`（p≥0.20 起，0.75s 铺满）。
- 每 band 展开位移：`L2827 off = eP·f.pushAmt + sin(...)·floatAmp`；pushAmt=dodecaKit L695 `0.30−0.14·sN+0.05·jit`（0.16~0.30u）；eP=smoothstep(d/f.arrive)，arrive∈[0.46,1.0]（L2822-2823, dodecaKit L700）。位移沿 `f.normal`（面法线），无 band 专属位移量。
- pC 定义：`L860 = 0.55+0.45·pow(safeParam,0.70)`，来源就是 mainParam（p），p=0.5→0.827，p=0.9→0.968（见 §1.1）。
- u_petal：碎片=1.0（L1906），基准面=0.35（L1921），核=0。决定走晶体分支还是板材分支。
- shardSeed 静态性：**静态**（dodecaKit 烘焙 aShard，L680-682）；facetGain 因此是**每片永久固定的明暗档**，与撞击/能量时序无关（仅幅度随 pC 缩放）。

---

## 5. shellInner（基准面）完整着色路径（板材分支 L1332–L1501）

仅 `u_petal=0.35, panel_mode=1, u_shell_gain=0.28`（L1919,1921,1944）。
- 暗底：`L1401 c = body·u_hard_body·(1−0.60·groove)`，body≈(0.012~0.085,0.028~0.135,0.048~0.205)。
- 能量透照 L1403-1404：`+= mix(frost,emissive,0.5)·(0.05+0.07pC)·(0.40+0.60lambert)·(1−0.70groove)·u_shell_gain(0.28)·plateVar·mix(0.14,1,appearB)`。p=0.5：(0.05+0.058)·0.28≈**0.030**。
- 缝渗光 L1412-1413：`+= emissive·groove·(0.30+0.80pC)·pulse(0.48~1.08)·(0.55+0.45lambert)·…·appearB`。仅缝像素，p=0.5 功率 0.96。
- 倒角高光 L1416-1417：`+= (emissive·0.55+(0.14,0.17,0.21))·bevel·u_shell_gain·(0.35+0.65lambert)·(0.30+0.55pC)·mix(0.62,1,appearB)`。
- 五边形勾边 L1422-1424：`+= emissive·pxLine(...)·mix(0.28,1,0.35)=0.532 ·(0.45+0.55pC)·(0.55+0.45lambert)·(1+1.15·closed)·mix(0.50,1,appearB)`。**闭合态 closed=1 → ×2.15，是 35-80 态最亮的基准面项**。
- **L1445 边光**：`+= emissive·rim·u_shell_gain·(0.20+0.50pC)·lit`。
- **L1446 spec（基准面唯一 vec3(1.0) 白项）**：`c += vec3(1.0)·spec·u_shell_gain·(0.14+0.36pC)·lit`，spec=pow(max(dot(nW,H),0),44)。
  - p=0.5：(0.14+0.298)=0.438·0.28≈**0.123**·spec(≤1)。峰值≈0.12 白，窄高光（pow44）。
  - p=0.9：(0.14+0.349)=0.489·0.28≈0.137，但随后被 c*=u_shell_fade(0.40)·u_base_boost(≈5.3) 净乘 ≈2.1 → 峰值 ≈0.137·0.40·5.3≈0.29。
- 擦除半隐：L1474-1475 `c*=bVis, alpha*=bVis`（扫过后 bVis=BASE_HIDE_LEVEL=0.50）。
- 细线环 L1481-1482：`+= mix((0.62,0.86,1.0),emissive,0.25)·bBand·u_revBGain(0.52)·(0.40+0.60lambert)`，仅 0.42s 行程。
- **L1493 c*=u_shell_fade·u_base_boost；L1494 alpha*=u_shell_fade**。
- u_shell_fade / innerFade：`L3546-3549 innerFade=1−(1−0.40)·smoothstep(_deploy,0,0.55)`。p=0.5 deploy=0→**1.0**；p=0.9 deploy=1→**0.40**。
- u_base_boost：`L3564 = min(8, 1+(1/_atten−1)·smoothstep(p,0.76,0.94)·1.25)`；settled 展开态 _atten=0.40·0.50=0.20→_need=5.0→boost≈5.3（p=0.9）。**只补 c 不补 alpha**。
- u_lift：`L3578 = BASE_LIFT(0.10)·_liftEnv`，展开随 deploy 0→0.55 抬升。
- L1386 注释实测：p=0 隐藏 shellInner 后壳带亮度 0.422→0.219（−48%），面心/中段比 1.35→2.14 —— 证实基准面在低能态就是后壳带底噪主源。

---

## 6. 等离子核着色（L1510–L1594）

- 体积发射 `L1548-1549 emit = emissive·eGain·(0.45+1.55·fil)·(0.70+1.0·temp)·0.34`；`L1550 emit += vec3(1.0)·eGain·0.10·fil·temp²`（**白热丝**，量级：eGain≈1.0~1.35、fil≤1、temp²≤1 → **≤0.135 白**，被 trans 衰减后逐像素更小）。
- 累积 `L1557 plasma=acc·u_plasma_gain(=0.12)`。
- 输出 `L1580 c = plasma·contain·coreExpose`；contain=mix(0.22,1.0,smoothstep(deploy))（L1578）；coreExpose=mix(1,1.15,smoothstep(p,0.70,1))（L1579）。
  - p=0.5：contain=0.22 → 核被压到 22%（封热）；p=0.9：contain=1.0、coreExpose≈1.15 → 炽亮。
- L1581 轮廓光 `+= emissive·eGainCore·rim·0.55·u_plasma_gain·contain·coreExpose`。
- **L1582 specP：`c += vec3(1.0)·specP·eGainCore·0.08·u_plasma_gain`**，specP=pow(lambert, mix(40,6,u_rough))·(0.15+metalness)。u_plasma_gain=0.12 → 量级≈0.08·0.12≈**0.01 白**，可忽略。
- 软拐点 L1589-1593：_lc>0.95 后压到渐近 1.70。
- 核是不透明 renderOrder=30，**先于**碎片画；闭合态它是碎片背后亮源之一（被 contain=0.22 压住）。

---

## 7. 结论分桶（按嫌疑排序，附"预期可观测签名"）

| 桶 | 项 | 行号 | 预期可观测签名（供实测子代理验证/排除） |
|---|---|---|---|
| **静态身份（最高嫌疑）** | envProc 灯带近白反射 envR | L965/L776-776 | 白块**固定在特定棱面/片上**，不随 stored、不随撞击、不随时间迁移；齿轮转动到该面时白块**跟着片一起刚体移动**；改变相机角度白块闪烁/转移到别的片 |
| 静态身份 | facetGain 片级明暗档 | L1027-1029 | 同面相邻片亮度差 ~1.8×；最亮片永远是同一批（shardSeed 大）；`?tk_fac=0` 应显著缩小片间亮度两极 |
| 静态身份 | 内芯层 facet 冷光 | L928-936 | 白块偏蓝（B≫R），与本体同片；`?tk_core2=0` 应减弱但不改变色相 |
| **shellInner 透色（次高，与消融一致）** | L1446 vec3(1.0) spec + L1422 勾边(×2.15 closed) | L1446/L1422 | 关 shellInner 白块骤降（今晨 1.89%→0.09%）；白块位置与基准面五边形棱/高光方位重合；闭合态(p 0.35-0.8)最明显（closed=1、u_shell_fade=1） |
| **stored / u_cool（用户关注，但方向是蓝不是白）** | cool 项 L1265-1267 | L1265-1267 | 高 stored 片应**偏蓝、略增 alpha**，而非 R&B 同高；`?tk_*` 无直接开关，但把某片 stored 拉满应看到它变蓝、不变白；band3 片 u_cool 写回正常（§0.1） |
| 视角相关 | envR 随 fres 掠射增强 / A6 边光 / A5 侧壁 | L994/L1165/L1158 | 白块集中在片的**边缘轮廓**（掠射角），正面不白；转相机即变 |
| 时序/事件相关 | 片级撞击脉冲线 A8 / 轮廓脉冲 A3 / 爆发 A4 / 显现线 A10 | L1305/L1142/L1144/L1316 | 瞬态、细线、持续 <0.5s；p=0.9 展开态才有队列脉冲；p 0.35-0.8 才有轮廓循环脉冲 |
| 后处理相关 | bloom 把 >1.0 的细线（A8≈1.0、本体钳 0.85）溢出成片 | L1326/L1130 | 白块呈"细线糊开"形态；降 bloom/关后处理应显著收窄（D 子代理域） |
| 核 | 白热丝 L1550 / contain 随 deploy | L1550/L1578 | 展开态(p>0.8)核才亮，闭合态 contain=0.22 压暗；今晨"熄核心+环流→1.98%"几乎不降，说明核不是 35-80 发白主因 |

**对今晨消融数字与用户观察矛盾的代码侧解释**：消融在 p=0.65（闭合、deploy=0）做，此态碎片 alpha≈0.18~0.30，shellInner 透色占 70%+，故"关 shellInner"一刀砍掉 ~95% 白块；而用户在 p 0.35-0.8 看到的"白"，光路上仍主要是 shellInner 的 L1422 勾边（closed=1 时 ×2.15）与 L1446 spec 透过半透碎片而成——**用户把"透过来的基准面亮"误记成了"碎片本身白"**。这与"关 facetGain/压主光/关脉冲/熄核都不降"完全自洽（那些都在碎片层，碎片 alpha 只有 0.2，动它们对白块预算影响极小）。

---

## 8. 需要实测子代理验证 / 排除的判据清单

**给 C（无头像素证据）：**
1. 在 p=0.65 闭合稳态，分别做 4 组：①全量；②`setLayer('fragments',false)` 只留 shellInner；③`setLayer('fragments',true)`+关 shellInner；④两层都留。对比白块(R>140,B>140,亮度>150)像素的**空间分布**——若 ②的白块位置与 ①重合、③几乎无白块，则坐实"白块=shellInner 透色"。
2. 固定 p=0.9 展开稳态，对同一面 band3 各片采样片心平均色 RGB：验证高 stored 片是否 **B−R 差更大（更蓝）**而非 R、B 同高；直接读 `f.mesh.material.uniforms.u_cool.value` 与片心色做散点。
3. `?tk_fac=0` 重测白块占比：若片间亮度两极收窄而总白块数变化不大 → facetGain 只是"谁更白"的分配器，不是"白从哪来"的源。
4. 转相机 30°/60°，记录白块是跟着碎片刚体移动（envProc 静态身份）还是留在基准面棱线上（shellInner spec）。

**给 B（几何/相机/身份映射）：**
5. 列出 88 片 band3 中 aShard（shardSeed）最大的 ~10 片的 faceIdx/方位，核对用户报"打不白"的 band3 片是否恰是 shardSeed 小（facetGain 低）的片——这能解释"被击打很多、stored 满，本体仍暗蓝"。
6. 核对展开后 band3 片 pushAmt 外推是否让其轮廓离开 shellInner 投影范围——若离开，则展开态它们不再透到 shellInner 的 spec，"打不白"更明显。

**给 D（时序/后处理）：**
7. 关 bloom / 降辐射外溢后重测白块：若白块从"面状"收窄成"线状"，则面状白 = 细线(A8/A3)溢出；若仍成片，则是 envR/shellInner 的体性亮。
8. 时序扫描 p 0.35→0.80：白块占比是随 closed=1 勾边项(L1422)上升，还是随 u_pulse_gate 循环脉冲(L1142)抖动——区分常驻透色 vs 事件线。

**我已排除的项（无需再验）：**
- u_cool 对 band3 写回失效：代码上不存在（§0.1/§3.3）。
- 棱线光导管/脉冲柱面/储能粒子：已删除，源码无残留（L2234-2251）。
- core 在 35-80 态发白：contain=0.22 压暗 + 今晨"熄核心不降"，已排除。
