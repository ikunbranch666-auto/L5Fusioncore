// Realistic long-run-end state: settle p=0.9, run 60s real (hits accumulate naturally),
// then stop-spin and shoot front+rot45 to measure white% in the REAL engaged state.
import { CDP } from './cdp.mjs';
import { rmSync } from 'node:fs';
const ROOT = 'E:/coding/NodeDesign/l5-core-showcase/investigation/V_check';
const port = 9551;
const udd = `${ROOT}/tools/udd_longshot`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}

const c = await CDP.boot({ port, userDataDir: udd,
  url: `http://127.0.0.1:4178/?instant=1&p=0.9&zoom=2.5` });

const t0=Date.now(); let simT=0;
while(Date.now()-t0<300000){ simT=await c.evalJs(`window.__AETHER_L5__.clock.simTime`); if(simT>=6) break; await new Promise(r=>setTimeout(r,4000)); }
console.log('steady sim=', simT.toFixed(2));
console.log('running 60s real (natural hits)...');
await new Promise(r=>setTimeout(r,60000));

const stats = await c.evalJs(`(()=>{
  const fs=window.__AETHER_L5__.l5.fragments;
  let ss=0,b3=0,mx=0;
  for(const f of fs){ ss+=f.stored||0; if(f.band===3)b3+=f.stored||0; mx=Math.max(mx,f.mesh.material.uniforms.u_cool.value); }
  return {storedSum:+ss.toFixed(1), b3sum:+b3.toFixed(1), coolMax:+mx.toFixed(3), simT:+window.__AETHER_L5__.clock.simTime.toFixed(2)};
})()`);
console.log('t60 stats:', JSON.stringify(stats));

await c.evalJs(`(()=>{try{window.__AETHER_L5__.setShowcase(false);}catch(e){}})()`);
await new Promise(r=>setTimeout(r,2500));
await new Promise(r=>setTimeout(r,1500));
await c.screenshot(`${ROOT}/shots/long60_front.png`);
await c.evalJs(`(() => {
  const cam = window.__AETHER_L5__.stage.camera;
  const ang = Math.PI/4;
  const dist = Math.hypot(cam.position.x, cam.position.z) || 10;
  cam.position.set(Math.sin(ang)*dist, cam.position.y, Math.cos(ang)*dist);
  cam.lookAt(0,0,0); cam.updateMatrixWorld(true);
})()`);
await new Promise(r=>setTimeout(r,2500));
await c.screenshot(`${ROOT}/shots/long60_rot45.png`);
console.log('DONE long60');
try { await c.close(); } catch {}
