// Experiment 6: time-series white persistence at p=0.9.
// Takes N screenshots spaced ~10 real-s apart; saves grid of white-cell presence for offline tracking.
import { CDP } from './cdp.mjs';
import { rmSync, writeFileSync } from 'node:fs';
const port=9461; const udd=`E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/tools/udd_exp6`;
try{rmSync(udd,{recursive:true,force:true});}catch{}
const c=await CDP.boot({port,userDataDir:udd,url:`http://127.0.0.1:4178/?instant=1&p=0.9&zoom=2.5`});
const t0=Date.now();
while(Date.now()-t0<300000){const s=await c.evalJs(`window.__AETHER_L5__.clock.simTime`);if(s>=6)break;await new Promise(r=>setTimeout(r,5000));}
console.log('steady sim=',await c.evalJs(`window.__AETHER_L5__.clock.simTime`));
const SHOT=`E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/shots/exp6_t`;
const N=8;
for(let i=0;i<N;i++){
  await new Promise(r=>setTimeout(r,10000)); // ~0.5 sim-s apart
  const sim=await c.evalJs(`window.__AETHER_L5__.clock.simTime`);
  await c.screenshot(SHOT+String(i)+'.png');
  console.log('shot',i,'sim=',sim.toFixed(2));
}
await c.close();
console.log('EXP6 DONE');
