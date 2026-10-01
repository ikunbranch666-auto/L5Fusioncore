// Toggle matrix runner (experiment 3).
// Usage: node run_matrix.mjs <p> <tag> [waitSim]
import { CDP } from './cdp.mjs';
import { rmSync, writeFileSync } from 'node:fs';

const p = parseFloat(process.argv[2] ?? '0.9');
const tag = process.argv[3] ?? 'p09';
const waitSim = parseFloat(process.argv[4] ?? '6');
const port = 9431;
const udd = `E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/tools/udd_mat_${tag}`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}

const c = await CDP.boot({ port, userDataDir: udd,
  url: `http://127.0.0.1:4178/?instant=1&p=${p}&zoom=2.5` });

// wait to steady
const t0 = Date.now();
while (Date.now()-t0 < 300000) {
  const s = await c.evalJs(`window.__AETHER_L5__.clock.simTime`);
  process.stdout.write(`\rsteady wait sim=${s.toFixed(1)}/${waitSim} real=${((Date.now()-t0)/1000)|0}s  `);
  if (s >= waitSim) break;
  await new Promise(r=>setTimeout(r,5000));
}
console.log('');

const SHOT = `E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/shots/${tag}_`;

// conditions: [name, applyJs, restoreJs]
const conds = [
  ['baseline',    ``, ``],
  ['fac_off',     `window.__AETHER_L5__.l5.setTune({fac:0});`,
                   `window.__AETHER_L5__.l5.setTune({fac:1});`],
  ['shell_off',   `window.__AETHER_L5__.l5.shellInner.visible=false;`,
                   `window.__AETHER_L5__.l5.shellInner.visible=true;`],
  ['core_off',    `window.__AETHER_L5__.l5.coreMesh.visible=false;`,
                   `window.__AETHER_L5__.l5.coreMesh.visible=true;`],
  ['pulse_off',   `window.__AETHER_L5__.l5.setTune({pulse:0});`,
                   `window.__AETHER_L5__.l5.setTune({pulse:1});`],
  ['dataflow_off',`window.__AETHER_L5__.l5.setLayer('particles',false);
                   window.__AETHER_L5__.l5.setLayer('ambient',false);`,
                   `window.__AETHER_L5__.l5.setLayer('particles',true);
                   window.__AETHER_L5__.l5.setLayer('ambient',true);`],
  ['cool0',       `for(const f of window.__AETHER_L5__.l5.fragments){f.stored=0;}`,
                   ``],
  ['cool05',      `for(const f of window.__AETHER_L5__.l5.fragments){f.stored=6;}`,
                   `for(const f of window.__AETHER_L5__.l5.fragments){f.stored=0;}`],
];

const results = [];
for (const [name, applyJs, restoreJs] of conds) {
  if (applyJs) await c.evalJs(applyJs);
  await new Promise(r=>setTimeout(r, 3500)); // ~3 frames at slow swiftshader
  const pct = await c.evalJs(`(() => {
    // crude in-page white % using canvas pixels is hard; return shellAlpha + stored avg for log
    const A=window.__AETHER_L5__;
    const fs=A.l5.fragments; let s=0; for(const f of fs) s+=(f.stored||0);
    return { shellAlpha: A.l5.shellInnerUniforms.u_shell_alpha.value,
             storedAvg: s/fs.length,
             shellVis: A.l5.shellInner.visible, coreVis: A.l5.coreMesh.visible,
             facetJit: A.l5.uniforms.u_facet_jit.value };
  })()`);
  await c.screenshot(SHOT + name + '.png');
  results.push({ name, ...pct });
  console.log(`${name.padEnd(14)} shellAlpha=${pct.shellAlpha?.toFixed?.(3)} storedAvg=${pct.storedAvg?.toFixed?.(2)} shellVis=${pct.shellVis} coreVis=${pct.coreVis} facetJit=${pct.facetJit}`);
  if (restoreJs) await c.evalJs(restoreJs);
  await new Promise(r=>setTimeout(r, 1500));
}

writeFileSync(`E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/csv/matrix_${tag}.json`, JSON.stringify(results,null,1));
await c.close();
console.log('MATRIX DONE');
