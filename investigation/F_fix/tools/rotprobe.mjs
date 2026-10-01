// Probe: find the spinning assembly/group object and its rotation.
import { CDP } from './cdp.mjs';
import { rmSync } from 'node:fs';
const ROOT = 'E:/coding/NodeDesign/l5-core-showcase/investigation/F_fix';
const port = 9591;
const udd = `${ROOT}/tools/udd_rotprobe`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}
const c = await CDP.boot({ port, userDataDir: udd,
  url: `http://127.0.0.1:4178/?instant=1&p=0.9&zoom=2.5` });
const t0=Date.now();
while(Date.now()-t0<200000){ const s=await c.evalJs(`window.__AETHER_L5__.clock.simTime`); if(s>=6) break; await new Promise(r=>setTimeout(r,4000)); }
const info = await c.evalJs(`(() => {
  const A = window.__AETHER_L5__;
  const out = {};
  out.l5GroupRot = A.l5.group.rotation.toArray ? A.l5.group.rotation.toArray() : [A.l5.group.rotation.x,A.l5.group.rotation.y,A.l5.group.rotation.z];
  // walk scene to find objects with rotation.y that look like the assembly
  const scene = A.stage.scene;
  const found = [];
  scene.traverse(o => {
    if (o.rotation && o.rotation.y !== undefined && o.type !== 'Mesh') {
      found.push({ type:o.type, name:o.name||'', ry:+o.rotation.y.toFixed(3), rx:+o.rotation.x.toFixed(3) });
    }
  });
  out.candidates = found.slice(0,20);
  out.clockKeys = Object.keys(A.clock);
  return out;
})()`);
console.log(JSON.stringify(info, null, 1));
await c.close();
