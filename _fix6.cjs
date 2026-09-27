const fs = require('fs');
const p = 'E:/coding/NodeDesign/l5-core-showcase/src/gfx/l5Core.js';
let s = fs.readFileSync(p, 'utf8');
const rep = [];
function R(oldS, newS, label) {
  if (s.indexOf(oldS) < 0) { console.log('SKIP (not found): ' + label); return; }
  const n = s.replace(oldS, newS);
  if (n === s) { console.log('NOCHANGE: ' + label); return; }
  s = n; rep.push(label);
}

// 基准面/面板分支：结构件全部改冷（frost 已在函数级作用域声明，此处均在作用域内）
// 1) 板体 lambert 受光项：暖能量色 → 冷钢蓝
R(
`    vec3 body = mix(vec3(0.012, 0.028, 0.048), u_emissive_color * 0.26, lambert) * plateVar;`,
`    vec3 body = mix(vec3(0.012, 0.028, 0.048), vec3(0.085, 0.135, 0.205), lambert) * plateVar;   // 冷钢蓝板体（结构冷、能量暖）`,
  'body-cold'
);

// 2) 能量透照 → 冷透照
R(
`    c += u_emissive_color * (0.05 + 0.07 * pC) * (0.40 + 0.60 * lambert)
       * (1.0 - 0.70 * groove) * u_shell_gain * plateVar;`,
`    c += frost * (0.05 + 0.07 * pC) * (0.40 + 0.60 * lambert)
       * (1.0 - 0.70 * groove) * u_shell_gain * plateVar;`,
  'transmit-cold'
);

// 3) 五边形缝渗光（主暖源之一）→ 冰蓝缝光
R(
`    c += u_emissive_color * groove * (0.30 + 0.80 * pC) * pulse
       * (0.55 + 0.45 * lambert) * (0.65 + 0.35 * plateVar);`,
`    c += frost * groove * (0.30 + 0.80 * pC) * pulse
       * (0.55 + 0.45 * lambert) * (0.65 + 0.35 * plateVar);`,
  'seam-cold'
);

// 4) 倒角高光 → 冷色倒角
R(
`    c += (u_emissive_color * 0.55 + vec3(0.16)) * bevel * u_shell_gain
       * (0.35 + 0.65 * lambert) * (0.30 + 0.55 * pC);`,
`    c += (frost * 0.55 + vec3(0.14, 0.17, 0.21)) * bevel * u_shell_gain
       * (0.35 + 0.65 * lambert) * (0.30 + 0.55 * pC);`,
  'bevel-cold'
);

// 5) 五边形轮廓勾边（闭合态 2.15x 加亮的主暖源）→ 冰蓝轮廓
R(
`    c += u_emissive_color * pxLine(sdPentagon(fuv, u_face_apothem * 0.985), 2.3)
       * mix(0.28, 1.00, u_petal) * (0.45 + 0.55 * pC) * (0.55 + 0.45 * lambert)
       * (1.0 + 1.15 * closed);   /* v-new：闭合态(20-80 能量)轮廓加亮 —— 透过半透碎片读出带轮廓线的外壳 */`,
`    c += frost * pxLine(sdPentagon(fuv, u_face_apothem * 0.985), 2.3)
       * mix(0.28, 1.00, u_petal) * (0.45 + 0.55 * pC) * (0.55 + 0.45 * lambert)
       * (1.0 + 1.15 * closed);   /* 闭合态(20-80 能量)轮廓加亮（冰蓝）—— 透过半透碎片读出带轮廓线的外壳 */`,
  'pxline-cold'
);

// 6) 星云气流（花瓣档）→ 冰蓝气流
R(
`      c += u_emissive_color * neb * (0.05 + 0.12 * pC) * (0.35 + 0.65 * eN)
         * (1.0 - 0.55 * groove);`,
`      c += frost * neb * (0.05 + 0.12 * pC) * (0.35 + 0.65 * eN)
         * (1.0 - 0.55 * groove);`,
  'neb-cold'
);

// 7) 边缘 rim 项 → 冰蓝 rim
R(
`    c += u_emissive_color * rim * u_shell_gain * (0.20 + 0.50 * pC) * lit;`,
`    c += frost * rim * u_shell_gain * (0.20 + 0.50 * pC) * lit;`,
  'rim-cold'
);

fs.writeFileSync(p, s);
console.log('applied:', rep.join(', '), '| len', s.length);
