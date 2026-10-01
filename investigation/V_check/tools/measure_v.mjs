// Independent V_check re-measure: mirrors F_fix/tools/measure.mjs exactly.
// Boot headless Chrome, settle at p, setShowcase(false) stop-spin, shoot front (default cam) + rot45 orbit.
// Usage: node measure_v.mjs <p> <tag> [fx=1|0]
import { CDP } from './cdp.mjs';
import { rmSync } from 'node:fs';

const ROOT = 'E:/coding/NodeDesign/l5-core-showcase/investigation/V_check';
const p = parseFloat(process.argv[2] ?? '0.9');
const tag = process.argv[3] ?? 'run';
const fx = process.argv[4] ?? '1';

const port = { v_p05: 9511, v_p09: 9512, v_p09fx0: 9513, v_p05fx0: 9514, v_cool05: 9515 }[tag] ?? 9520;
const udd = `${ROOT}/tools/udd_${tag}`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}

const fxParam = fx === '0' ? '&fx=0' : '';
const url = `http://127.0.0.1:4178/?instant=1&p=${p}&zoom=2.5${fxParam}`;
console.log('booting', url, 'port', port);

const c = await CDP.boot({ port, userDataDir: udd, url });

const t0 = Date.now();
let simT = 0;
while (Date.now() - t0 < 300000) {
  simT = await c.evalJs(`window.__AETHER_L5__.clock.simTime`);
  if (simT >= 6) break;
  await new Promise(r => setTimeout(r, 4000));
}
console.log('steady sim=', simT.toFixed(2));

// STOP spin: setShowcase(false) pins assembly.rotation.y = AXON_TILT_Y. Keep clock running.
await c.evalJs(`(() => { try { window.__AETHER_L5__.setShowcase(false); } catch(e) {} })()`);
await new Promise(r => setTimeout(r, 2500));

await new Promise(r => setTimeout(r, 1500));
await c.screenshot(`${ROOT}/shots/${tag}_front.png`);
console.log('front saved', `${tag}_front.png`);

const camInfo = await c.evalJs(`(() => {
  const cam = window.__AETHER_L5__.stage.camera;
  return { x: cam.position.x, y: cam.position.y, z: cam.position.z, type: cam.type };
})()`);
console.log('cam before orbit:', JSON.stringify(camInfo));
await c.evalJs(`(() => {
  const cam = window.__AETHER_L5__.stage.camera;
  const ang = Math.PI/4;
  const dist = Math.hypot(cam.position.x, cam.position.z) || 10;
  cam.position.set(Math.sin(ang)*dist, cam.position.y, Math.cos(ang)*dist);
  cam.lookAt(0,0,0);
  cam.updateMatrixWorld(true);
})()`);
await new Promise(r => setTimeout(r, 2500));
const camAfter = await c.evalJs(`[window.__AETHER_L5__.stage.camera.position.x, window.__AETHER_L5__.stage.camera.position.z]`);
console.log('cam after orbit:', JSON.stringify(camAfter));
await c.screenshot(`${ROOT}/shots/${tag}_rot45.png`);
console.log('rot45 saved', `${tag}_rot45.png`);

try { await c.close(); } catch {}
console.log('DONE', tag);
