// Recolor crystal-fragment additive terms to ice-blue (user: fragments are the
// COOLING structure) + make closed fragments a translucent veil so the base-shell
// pentagon outline reads at 20-80 energy (user option A). Atomic, verified.
const fs = require('fs');
const P = 'E:/coding/NodeDesign/l5-core-showcase/src/gfx/l5Core.js';
let src = fs.readFileSync(P, 'utf8');
const orig = src;
const edits = [];

function rep(name, oldS, newS) {
  const n = src.split(oldS).length - 1;
  if (n !== 1) { console.error(`FAIL [${name}] match count = ${n}`); process.exit(1); }
  src = src.replace(oldS, newS);
  edits.push(name);
}

// A. Inner glow layer (u_core_layer branch): frost is declared LATER (L267 glsl),
//    out of scope here -> use the literal.
rep('A coreCol',
  "      vec3 coreCol = mix(u_emissive_color, u_crystal_tint, 0.40 * u_deploy);",
  "      vec3 coreCol = mix(vec3(0.45, 0.72, 1.05) * 1.22, u_emissive_color, 0.18);   // v-new：内芯能量核改冰蓝主导（碎片=冷却结构），只留 18% 能量色暖意");

// B. Pulse / burst color
rep('B pulseCol',
  "      vec3 pulseCol = mix(mix(u_emissive_color, vec3(1.0), 0.55), u_crystal_tint, 0.30);",
  "      vec3 pulseCol = mix(frost * 1.55, vec3(1.0), 0.35);   // v-new：脉冲/爆发改冰亮色（不吃能量暖色）");

// C. Seam bottom line
rep('C seamline',
  "      c += mix(u_emissive_color, tint, 0.30 * u_deploy)",
  "      c += mix(frost * 1.12, tint, 0.40)");

// D. Crack (fracture wall) glow
rep('D crackglow',
  "      c += mix(vec3(0.85, 0.92, 1.0), u_emissive_color, 0.5)",
  "      c += mix(vec3(0.85, 0.92, 1.0), frost, 0.35)");

// E. Rim energy light
rep('E rimlight',
  "      c += u_emissive_color * pow(1.0 - ndv, 3.5) * (0.06 + 0.13 * pC) * (0.40 + 0.25 * u_deploy);",
  "      c += frost * pow(1.0 - ndv, 3.5) * (0.10 + 0.20 * pC) * (0.40 + 0.25 * u_deploy);   // v-new：边光改冰蓝");

// F. Closed-state reveal (option A done RIGHT under premultiplied blending):
//    restore baseline alpha, then scale BOTH c and alpha down when closed.
rep('F reveal',
  "      float alpha = clamp(0.18 + 0.30 * fres + 0.54 * u_deploy, 0.0, 0.94);\n" +
  "      alpha = clamp(alpha + 0.32 * closed, 0.0, 0.97);",
  "      float alpha = clamp(0.42 + 0.30 * fres + 0.18 * u_deploy, 0.0, 0.92);\n" +
  "      // v-new（用户选 A）：闭合态碎片退为半透晶纱 —— 预乘(OneFactor)混合下只降 alpha\n" +
  "      // 不压 c 时颜色仍整强度叠加，基准面五边形轮廓照样被冲掉；必须两者同乘。\n" +
  "      float reveal = mix(0.42, 1.0, smoothstep(0.0, 0.40, u_deploy));\n" +
  "      c *= reveal;\n" +
  "      alpha *= reveal;");

fs.writeFileSync(P, src);
console.log('applied', edits.length, 'edits:', edits.join(', '));
console.log('bytes', orig.length, '->', src.length);
