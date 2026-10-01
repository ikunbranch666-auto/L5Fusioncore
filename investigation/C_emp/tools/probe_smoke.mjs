// Smoke test: boot chrome, load page, introspect runtime.
import { CDP } from './cdp.mjs';
import { rmSync } from 'node:fs';

const port = 9411;
const udd = `E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/tools/udd_smoke`;
try { rmSync(udd, { recursive: true, force: true }); } catch {}

const c = await CDP.boot({ port, userDataDir: udd, url: 'http://127.0.0.1:4178/?instant=1&p=0.9&zoom=2.5' });
await new Promise((r) => setTimeout(r, 4000)); // let it warm up

const info = await c.evalJs(`(() => {
  const A = window.__AETHER_L5__;
  if (!A) return { err: 'no __AETHER_L5__' };
  const l5 = A.l5;
  const frags = l5.fragments || [];
  const f0 = frags[0] || {};
  return {
    hasA: !!A,
    keys: Object.keys(A),
    l5keys: Object.keys(l5).filter(k => !k.startsWith('_')).slice(0, 80),
    numFrags: frags.length,
    f0keys: Object.keys(f0),
    f0: {
      band: f0.band, idx: f0.idx, faceIdx: f0.faceIdx,
      stored: f0.stored,
      hasCentroid: !!f0.centroid,
      centroid: f0.centroid ? [f0.centroid.x, f0.centroid.y, f0.centroid.z] : null,
      radialN: f0.radialN, radial: f0.radial, boundR: f0.boundR,
      meshPos: f0.mesh ? [f0.mesh.position.x, f0.mesh.position.y, f0.mesh.position.z] : null,
      u_cool: f0.mesh && f0.mesh.material && f0.mesh.material.uniforms ? f0.mesh.material.uniforms.u_cool.value : null,
    },
    shellInnerVisible: !!(l5.shellInner && l5.shellInner.visible),
    shellAlpha: l5.shellInnerUniforms ? l5.shellInnerUniforms.u_shell_alpha.value : null,
    coreMeshVisible: !!(l5.coreMesh && l5.coreMesh.visible),
    p: A.mainParam.value,
    simTime: A.clock.simTime,
    cam: A.stage && A.stage.camera ? { type: A.stage.camera.type, zoom: A.stage.camera.zoom } : null,
    bandCounts: frags.reduce((m,f)=>{m[f.band]=(m[f.band]||0)+1;return m;},{}),
  };
})()`);
console.log(JSON.stringify(info, null, 2));

await c.screenshot('E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/shots/smoke_p09.png');
console.log('screenshot saved');
await c.close();
