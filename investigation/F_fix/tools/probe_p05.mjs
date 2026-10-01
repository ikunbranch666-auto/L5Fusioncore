// Probe p=0.5: dump uniforms + sample brightest pixels in region.
import { CDP } from './cdp.mjs';
import { rmSync, writeFileSync } from 'node:fs';

const ROOT = 'E:/coding/NodeDesign/l5-core-showcase/investigation/F_fix';
const port = 9577;
const udd = `${ROOT}/tools/udd_probe`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}

const c = await CDP.boot({ port, userDataDir: udd,
  url: `http://127.0.0.1:4178/?instant=1&p=0.5&zoom=2.5` });

const t0 = Date.now();
while (Date.now()-t0 < 200000) {
  const s = await c.evalJs(`window.__AETHER_L5__.clock.simTime`);
  if (s >= 6) break;
  await new Promise(r=>setTimeout(r,4000));
}
console.log('steady sim=', await c.evalJs(`window.__AETHER_L5__.clock.simTime`));

// dump key uniforms
const u = await c.evalJs(`(() => {
  const A = window.__AETHER_L5__;
  const L = A.l5;
  const out = {};
  // shellInner uniforms
  const su = L.shellInnerUniforms;
  for (const k of ['u_emissive_color','u_shell_gain','u_hard_body','u_shell_fade','u_base_boost','u_shell_alpha','u_seam_form']) {
    try { out[k] = su.uniforms[k] ? su.uniforms[k].value : undefined; } catch(e){ out[k]='?'; }
  }
  out.pC = L.uniforms && L.uniforms.u_main_param ? L.uniforms.u_main_param.value : '?';
  out.mainParam = A.mainParam.value;
  // emissive color raw
  try { out.emissive = su.uniforms.u_emissive_color.value.toArray ? su.uniforms.u_emissive_color.value.toArray() : su.uniforms.u_emissive_color.value; } catch(e){ out.emissive='?'; }
  return out;
})()`);
console.log('UNIFORMS:', JSON.stringify(u, null, 1));

// capture raw pixels via CDP: grab screenshot and also eval a readback? We'll just screenshot and analyze in python.
await c.screenshot(`${ROOT}/shots/probe_p05.png`);
await c.close();
console.log('DONE');
