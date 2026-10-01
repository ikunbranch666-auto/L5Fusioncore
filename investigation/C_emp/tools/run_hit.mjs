// Experiments 4 + 5: hit time-series & static determination at p=0.9.
// Force stored/u_cool on chosen fragments; screenshot; sample color at their screen pos (done by PIL later).
import { CDP } from './cdp.mjs';
import { rmSync, writeFileSync } from 'node:fs';

const port = 9441;
const udd = `E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/tools/udd_hit`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}

const c = await CDP.boot({ port, userDataDir: udd,
  url: `http://127.0.0.1:4178/?instant=1&p=0.9&zoom=2.5` });

const t0=Date.now();
while(Date.now()-t0<300000){
  const s=await c.evalJs(`window.__AETHER_L5__.clock.simTime`);
  if(s>=6) break;
  await new Promise(r=>setTimeout(r,5000));
}
console.log('steady sim=', await c.evalJs(`window.__AETHER_L5__.clock.simTime`));

// get screen positions of all fragments
const pos = await c.evalJs(`(() => {
  const A=window.__AETHER_L5__; const cam=A.stage.camera;
  const W=innerWidth,H=innerHeight;
  function xf(m,v){const x=v[0],y=v[1],z=v[2],w=v[3];return [m[0]*x+m[4]*y+m[8]*z+m[12]*w,m[1]*x+m[5]*y+m[9]*z+m[13]*w,m[2]*x+m[6]*y+m[10]*z+m[14]*w,m[3]*x+m[7]*y+m[11]*z+m[15]*w];}
  const proj=cam.projectionMatrix.elements, vi=cam.matrixWorldInverse.elements;
  return A.l5.fragments.map((f,i)=>{
    const w=xf(f.mesh.matrixWorld.elements,[f.centroid.x,f.centroid.y,f.centroid.z,1]);
    const v=xf(vi,w); const cl=xf(proj,v); const inv=1/cl[3];
    return {i, band:f.band, sx:+(cl[0]*inv*0.5+0.5)*W, sy:+(-cl[1]*inv*0.5+0.5)*H,
            stored:f.stored, ucool:f.mesh.material.uniforms.u_cool.value};
  });
})()`);
writeFileSync(`E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/csv/hit_pos.json`, JSON.stringify(pos,null,1));

// choose a band3 frag with natural stored>0 (the "hit but won't whiten") and an inner white frag
const b3 = pos.filter(f=>f.band===3 && f.ucool>0.1);
const inner = pos.filter(f=>f.band<=1);
const band3Pick = b3.sort((a,b)=>b.stored-a.stored)[0];
const innerPick = inner[0];
console.log('band3 pick:', band3Pick, ' inner pick:', innerPick);

const SHOT = `E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/shots/exp4_`;
const wait = ()=>new Promise(r=>setTimeout(r,3500));

// State 0: force ALL stored=0 (cool0)
await c.evalJs(`for(const f of window.__AETHER_L5__.l5.fragments){f.stored=0;}`);
await wait();
await c.screenshot(SHOT+'t0_cool0.png');

// State series: ramp band3Pick stored 2->4->6
for (const st of [2,4,6]) {
  await c.evalJs(`(()=>{const fs=window.__AETHER_L5__.l5.fragments; fs[${band3Pick.i}].stored=${st};})()`);
  await wait();
  const uc = await c.evalJs(`window.__AETHER_L5__.l5.fragments[${band3Pick.i}].mesh.material.uniforms.u_cool.value`);
  console.log(`band3#${band3Pick.i} stored=${st} u_cool=${uc}`);
  await c.screenshot(SHOT+`t_${st}_b3only.png`);
}

// State: force innerPick stored=6 too
await c.evalJs(`(()=>{const fs=window.__AETHER_L5__.l5.fragments; fs[${innerPick.i}].stored=6;})()`);
await wait();
await c.screenshot(SHOT+'t_inner6.png');

// State: facetGain ramp to 2 (static)
await c.evalJs(`window.__AETHER_L5__.l5.setTune({fac:2});`);
await wait();
await c.screenshot(SHOT+'t_fac2.png');
// back to fac default
await c.evalJs(`window.__AETHER_L5__.l5.setTune({fac:1});`);

await c.close();
console.log('EXP4/5 DONE. picks:', JSON.stringify({band3:band3Pick, inner:innerPick}));
