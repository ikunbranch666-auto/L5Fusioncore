// At p=0.5: baseline shot, then hide shellInner, shot. Compare what disappears.
import { CDP } from './cdp.mjs';
import { rmSync } from 'node:fs';

const ROOT = 'E:/coding/NodeDesign/l5-core-showcase/investigation/F_fix';
const port = 9581;
const udd = `${ROOT}/tools/udd_shellcmp`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}

const c = await CDP.boot({ port, userDataDir: udd,
  url: `http://127.0.0.1:4178/?instant=1&p=0.5&zoom=2.5` });
const t0=Date.now();
while(Date.now()-t0<200000){ const s=await c.evalJs(`window.__AETHER_L5__.clock.simTime`); if(s>=6) break; await new Promise(r=>setTimeout(r,4000)); }
console.log('steady', await c.evalJs(`window.__AETHER_L5__.clock.simTime`));

await c.screenshot(`${ROOT}/shots/cmp_p05_base.png`);
await c.evalJs(`window.__AETHER_L5__.l5.shellInner.visible=false`);
await new Promise(r=>setTimeout(r,3000));
await c.screenshot(`${ROOT}/shots/cmp_p05_shelloff.png`);

// also: fragments only (shellInner on, fragments off) to isolate
await c.evalJs(`window.__AETHER_L5__.l5.shellInner.visible=true; for(const f of window.__AETHER_L5__.l5.fragments){f.mesh.visible=false;}`);
await new Promise(r=>setTimeout(r,3000));
await c.screenshot(`${ROOT}/shots/cmp_p05_fragsoff.png`);

await c.close();
console.log('DONE');
