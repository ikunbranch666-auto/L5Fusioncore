// Steady-state capture for one p value. (manual matrix projection, no global THREE)
import { CDP } from './cdp.mjs';
import { rmSync, writeFileSync } from 'node:fs';

const p = parseFloat(process.argv[2] ?? '0.9');
const tag = process.argv[3] ?? 'p09';
const waitSim = parseFloat(process.argv[4] ?? '6');
const port = 9421;
const udd = `E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/tools/udd_${tag}`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}

const c = await CDP.boot({ port, userDataDir: udd,
  url: `http://127.0.0.1:4178/?instant=1&p=${p}&zoom=2.5` });

let simT = 0;
const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  simT = await c.evalJs(`window.__AETHER_L5__.clock.simTime`);
  const pnow = await c.evalJs(`+window.__AETHER_L5__.mainParam.value.toFixed(3)`);
  process.stdout.write(`\rwaiting sim=${simT.toFixed(2)}/${waitSim} p=${pnow}  real=${((Date.now()-t0)/1000).toFixed(0)}s   `);
  if (simT >= waitSim) break;
  await new Promise(r => setTimeout(r, 5000));
}
console.log('\nreached sim=', simT);

// Export fragment identity + screen projection (manual mat4*vec4)
const frags = await c.evalJs(`(() => {
  const A = window.__AETHER_L5__;
  const cam = A.stage.camera;
  const W = window.innerWidth, H = window.innerHeight;
  const proj = cam.projectionMatrix.elements;      // column-major
  const viewI = cam.matrixWorldInverse.elements;
  // manual mat4 * vec4
  function xform(m, v) {
    const x=v[0],y=v[1],z=v[2],w=v[3];
    return [
      m[0]*x+m[4]*y+m[8]*z+m[12]*w,
      m[1]*x+m[5]*y+m[9]*z+m[13]*w,
      m[2]*x+m[6]*y+m[10]*z+m[14]*w,
      m[3]*x+m[7]*y+m[11]*z+m[15]*w,
    ];
  }
  const out = [];
  A.l5.fragments.forEach((f, i) => {
    const mw = f.mesh.matrixWorld.elements;
    // centroid is face-local; mesh has no own rotation but include parent group via matrixWorld
    const world = xform(mw, [f.centroid.x, f.centroid.y, f.centroid.z, 1.0]);
    const view = xform(viewI, world);
    const clip = xform(proj, view);
    const invW = 1/clip[3];
    const ndcX = clip[0]*invW, ndcY = clip[1]*invW;
    const sx = (ndcX*0.5+0.5)*W, sy = (-ndcY*0.5+0.5)*H;
    const uCool = f.mesh.material.uniforms.u_cool.value;
    out.push({
      i, band: f.band, faceIdx: f.faceIdx, idx: f.idx,
      stored: +(f.stored||0).toFixed(2),
      u_cool: +uCool.toFixed(3),
      radialN: +(f.radialN||0).toFixed(3),
      wp: [+world[0].toFixed(3),+world[1].toFixed(3),+world[2].toFixed(3)],
      sx: +sx.toFixed(1), sy: +sy.toFixed(1),
      behind: clip[3] < 0,
      vis: f.mesh.visible,
    });
  });
  return { W, H, simTime: A.clock.simTime, p: A.mainParam.value,
           shellAlpha: A.l5.shellInnerUniforms.u_shell_alpha.value,
           shellVis: A.l5.shellInner.visible,
           coreVis: A.l5.coreMesh.visible,
           camPos: [cam.position.x, cam.position.y, cam.position.z],
           frags: out };
})()`);
writeFileSync(`E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/csv/frags_${tag}.json`, JSON.stringify(frags, null, 1));
console.log('frags dumped:', frags.frags.length, 'shellAlpha=', frags.shellAlpha.toFixed(3),
  'camPos=', frags.camPos.map(x=>x.toFixed(2)));

const byBand = {};
for (const f of frags.frags) {
  byBand[f.band] = byBand[f.band] || { n:0, storedSum:0, coolMax:0, storedMax:0 };
  byBand[f.band].n++; byBand[f.band].storedSum += f.stored;
  byBand[f.band].coolMax = Math.max(byBand[f.band].coolMax, f.u_cool);
  byBand[f.band].storedMax = Math.max(byBand[f.band].storedMax, f.stored);
}
console.log('band stats:', JSON.stringify(byBand));

await c.screenshot(`E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/shots/${tag}_baseline_front.png`);
console.log('front shot saved');

// rotate camera ~45deg around Y
await c.evalJs(`(() => {
  const A = window.__AETHER_L5__;
  const cam = A.stage.camera;
  const ang = Math.PI/4;
  const dist = 10;
  cam.position.set(Math.sin(ang)*dist, 0, Math.cos(ang)*dist);
  cam.lookAt(0,0,0);
  cam.updateMatrixWorld(true);
})()`);
await new Promise(r => setTimeout(r, 2500));
await c.screenshot(`E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/shots/${tag}_baseline_rot45.png`);
console.log('rot45 shot saved');

await c.close();
console.log('DONE');
