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

// FragCore (内芯发光层) 彻底改为冰蓝 —— 去掉 18% 能量暖色。
// 注意：fragCoreMaterial 是 285 片共享材质，不含逐片 u_cool，故用常数冰蓝，
// 逐片"随储存量变冷"由 shard 本体的克隆材质(u_cool)承担。
R(
`      // v5.6：内芯以能量色为主（同源融合），只掺入少量水晶矿物色做材质区分
      vec3 coreCol = mix(vec3(0.45, 0.72, 1.05) * 1.22, u_emissive_color, 0.18);   // v-new：内芯能量核改冰蓝主导（碎片=冷却结构），只留 18% 能量色暖意`,
`      // 碎片=吸收冷却能量的结构：内芯是冰蓝能量核（不随能量色变暖），呈现"封在晶体里的冷光"
      vec3 coreCol = vec3(0.55, 0.80, 1.18) * 1.22;`,
  'fragcore-icy'
);

fs.writeFileSync(p, s);
console.log('applied:', rep.join(', '), '| total len', s.length);
