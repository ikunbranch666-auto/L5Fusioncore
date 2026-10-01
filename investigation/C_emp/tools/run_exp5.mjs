// Experiment 5 quick: facetGain static test at p=0.9.
import { CDP } from './cdp.mjs';
import { rmSync } from 'node:fs';
const port=9451; const udd=`E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/tools/udd_exp5`;
try{rmSync(udd,{recursive:true,force:true});}catch{}
const c=await CDP.boot({port,userDataDir:udd,url:`http://127.0.0.1:4178/?instant=1&p=0.9&zoom=2.5`});
const t0=Date.now();
while(Date.now()-t0<300000){const s=await c.evalJs(`window.__AETHER_L5__.clock.simTime`);if(s>=6)break;await new Promise(r=>setTimeout(r,5000));}
console.log('steady sim=',await c.evalJs(`window.__AETHER_L5__.clock.simTime`));
const SHOT=`E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/shots/exp5_`;
const wait=()=>new Promise(r=>setTimeout(r,3500));
// baseline
await c.screenshot(SHOT+'baseline.png');
// fac=2 full static jitter
await c.evalJs(`window.__AETHER_L5__.l5.setTune({fac:2});`); await wait();
await c.screenshot(SHOT+'fac2.png');
// fac=0.5
await c.evalJs(`window.__AETHER_L5__.l5.setTune({fac:0.5});`); await wait();
await c.screenshot(SHOT+'fac05.png');
await c.close();
console.log('EXP5 DONE');
