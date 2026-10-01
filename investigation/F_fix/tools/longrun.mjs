// Long-run validation: p=0.9, 60s real (~5.4s sim), collect console/shader errors + hit queue stats.
import { CDP } from './cdp.mjs';
import { rmSync, writeFileSync } from 'node:fs';

const ROOT = 'E:/coding/NodeDesign/l5-core-showcase/investigation/F_fix';
const port = 9588;
const udd = `${ROOT}/tools/udd_long`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}

const c = await CDP.boot({ port, userDataDir: udd,
  url: `http://127.0.0.1:4178/?instant=1&p=0.9&zoom=2.5` });

// attach error capture
const errors = [];
c.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data.toString());
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXC: ' + JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params).slice(0, 500));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('CONSOLE_ERR: ' + m.params.args?.map(a=>a.value||a.description||'').join(' ').slice(0,500));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push('LOG: ' + (m.params.entry.text||'').slice(0,300));
  }
});
await c.send('Log.enable');

// wait steady
const t0 = Date.now();
let simT = 0;
while (Date.now() - t0 < 300000) {
  simT = await c.evalJs(`window.__AETHER_L5__.clock.simTime`);
  if (simT >= 6) break;
  await new Promise(r=>setTimeout(r,4000));
}
console.log('steady sim=', simT.toFixed(2));

// baseline stats
const stats0 = await c.evalJs(`(() => {
  const fs = window.__AETHER_L5__.l5.fragments;
  let storedSum=0, b3sum=0, b3n=0, maxStored=0;
  for (const f of fs) {
    storedSum += f.stored||0;
    if (f.band===3) { b3sum += f.stored||0; b3n++; }
    maxStored = Math.max(maxStored, f.stored||0);
  }
  return { n: fs.length, storedSum:+storedSum.toFixed(1), b3n, b3sum:+b3sum.toFixed(1), maxStored };
})()`);
console.log('t0 stats:', JSON.stringify(stats0));

// run 60s real time
console.log('running 60s real...');
await new Promise(r=>setTimeout(r, 60000));

const stats1 = await c.evalJs(`(() => {
  const fs = window.__AETHER_L5__.l5.fragments;
  let storedSum=0, b3sum=0, b3n=0, b3hit=0, maxStored=0, coolMax=0;
  for (const f of fs) {
    storedSum += f.stored||0;
    if (f.band===3) { b3sum += f.stored||0; b3n++; if((f.stored||0)>0) b3hit++; }
    maxStored = Math.max(maxStored, f.stored||0);
    coolMax = Math.max(coolMax, f.mesh.material.uniforms.u_cool.value);
  }
  const simT = window.__AETHER_L5__.clock.simTime;
  return { n: fs.length, storedSum:+storedSum.toFixed(1), b3n, b3sum:+b3sum.toFixed(1), b3hit, maxStored:+maxStored.toFixed(1), coolMax:+coolMax.toFixed(3), simT:+simT.toFixed(2) };
})()`);
console.log('t60 stats:', JSON.stringify(stats1));
console.log('errors captured:', errors.length);
for (const e of errors.slice(0,20)) console.log('  ', e);

writeFileSync(`${ROOT}/longrun.json`, JSON.stringify({ t0: stats0, t60: stats1, errors }, null, 1));
try { await c.close(); } catch {}
console.log('LONG RUN DONE');
