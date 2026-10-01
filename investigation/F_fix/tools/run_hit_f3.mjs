// F3 hit feedback: ramp a band3 outer fragment stored 0->6, record u_cool + screen color + screenshots.
import { CDP } from './cdp.mjs';
import { rmSync, writeFileSync } from 'node:fs';

const ROOT = 'E:/coding/NodeDesign/l5-core-showcase/investigation/F_fix';
const port = 9577;
const udd = `${ROOT}/tools/udd_hit`;
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

// stop spin
await c.evalJs(`(()=>{try{window.__AETHER_L5__.setShowcase(false);}catch(e){}})()`);
await new Promise(r=>setTimeout(r,2500));

// get screen positions
const pos = await c.evalJs(`(() => {
  const A=window.__AETHER_L5__; const cam=A.stage.camera;
  const W=innerWidth,H=innerHeight;
  function xf(m,v){const x=v[0],y=v[1],z=v[2],w=v[3];return [m[0]*x+m[4]*y+m[8]*z+m[12]*w,m[1]*x+m[5]*y+m[9]*z+m[13]*w,m[2]*x+m[6]*y+m[10]*z+m[14]*w,m[3]*x+m[7]*y+m[11]*z+m[15]*w];}
  const proj=cam.projectionMatrix.elements, vi=cam.matrixWorldInverse.elements;
  return A.l5.fragments.map((f,i)=>{
    const w=xf(f.mesh.matrixWorld.elements,[f.centroid.x,f.centroid.y,f.centroid.z,1]);
    const v=xf(vi,w); const cl=xf(proj,v); const inv=1/cl[3];
    return {i, band:f.band, sx:Math.round((cl[0]*inv*0.5+0.5)*W), sy:Math.round((-cl[1]*inv*0.5+0.5)*H),
            stored:f.stored, ucool:f.mesh.material.uniforms.u_cool.value};
  });
})()`);

// pick a band3 outer fragment (band===3) on screen (sy within frame)
const b3 = pos.filter(f=>f.band===3 && f.sx>200 && f.sx<1060 && f.sy>100 && f.sy<700);
const pick = b3[Math.floor(b3.length/2)];
console.log('band3 pick:', JSON.stringify(pick), 'candidates:', b3.length);

const wait = ()=>new Promise(r=>setTimeout(r,3000));
const log = [];

// force all stored=0 first
await c.evalJs(`for(const f of window.__AETHER_L5__.l5.fragments){f.stored=0;}`);
await wait();

for (const st of [0, 2, 4, 6]) {
  await c.evalJs(`(()=>{const fs=window.__AETHER_L5__.l5.fragments; fs[${pick.i}].stored=${st};})()`);
  await wait();
  const uc = await c.evalJs(`window.__AETHER_L5__.l5.fragments[${pick.i}].mesh.material.uniforms.u_cool.value`);
  // sample screen color at fragment position via CDP screenshot pixel
  await c.screenshot(`${ROOT}/shots/f3_hit_stored${st}.png`);
  log.push({stored:st, u_cool:+uc.toFixed(3), sx:pick.sx, sy:pick.sy});
  console.log(`stored=${st} u_cool=${uc.toFixed(3)}`);
}
writeFileSync(`${ROOT}/csv_f3_hit.json`, JSON.stringify(log, null, 1));
console.log('DONE. pick=', JSON.stringify(pick));
try { await c.close(); } catch {}
