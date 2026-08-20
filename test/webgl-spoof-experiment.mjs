#!/usr/bin/env node
/**
 * Experiment: does spoofing the WebGL renderer help or hurt?
 *
 * Forces SwiftShader (--no-gpu) so the spoof has something to lie about, then
 * measures three arms against the same detectors:
 *
 *   A. real GPU, no spoof     (the recommended configuration)
 *   B. SwiftShader, no spoof  (honest but detectable renderer)
 *   C. SwiftShader + spoof    (claims hardware it does not have)
 *
 * The question is whether C beats B, or whether the inconsistency it introduces
 * makes it worse. Data decides, not intuition.
 */
import { withBrowser } from '../src/client.mjs';

const SPOOF = {
  vendor: 'Google Inc. (NVIDIA Corporation)',
  renderer: 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070 Ti/PCIe/SSE2, OpenGL 4.5)',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SANNY = `(() => {
  const rows = Array.from(document.querySelectorAll('table tr'));
  const failed = [];
  for (const tr of rows) {
    const c = tr.querySelectorAll('td');
    if (c.length < 2) continue;
    if (/failed/i.test(c[1].className || '')) failed.push((c[0].innerText || '').trim());
  }
  return JSON.stringify({ failed });
})()`;

const DBI = `(async () => {
  for (let i = 0; i < 24; i++) {
    const t = document.body.innerText || '';
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        const d = JSON.parse(t.slice(a, b + 1));
        return JSON.stringify({
          isBot: d.isBot,
          flagged: Object.entries(d.details || {}).filter(([, v]) => v === true).map(([k]) => k),
        });
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return JSON.stringify({ error: 'no verdict' });
})()`;

const RENDERER = `(() => { try {
  const c = document.createElement('canvas').getContext('webgl');
  const d = c.getExtension('WEBGL_debug_renderer_info');
  return JSON.stringify({
    renderer: c.getParameter(d.UNMASKED_RENDERER_WEBGL),
    toStringNative: /\\[native code\\]/.test(WebGLRenderingContext.prototype.getParameter.toString()),
    maxTexture: c.getParameter(c.MAX_TEXTURE_SIZE),
    extensions: c.getSupportedExtensions().length
  });
} catch (e) { return JSON.stringify({ error: String(e) }); } })()`;

const ARMS = [
  { name: 'A real GPU, no spoof', opts: { gpu: true } },
  { name: 'B SwiftShader, no spoof', opts: { gpu: false } },
  { name: 'C SwiftShader + spoof', opts: { gpu: false, spoofWebgl: SPOOF } },
];

for (const arm of ARMS) {
  const row = { name: arm.name };
  try {
    Object.assign(row, await withBrowser(arm.opts, async (session) => {
      await session.navigate('https://example.com', { timeoutMs: 40000 });
      const gl = JSON.parse(await session.evaluate(RENDERER));

      await session.navigate('https://bot.sannysoft.com/', { timeoutMs: 60000 });
      await sleep(3000);
      const sanny = JSON.parse(await session.evaluate(SANNY));

      await session.navigate('https://deviceandbrowserinfo.com/are_you_a_bot', { timeoutMs: 60000 });
      const dbi = JSON.parse(await session.evaluate(DBI));

      return { gl, sanny, dbi };
    }));
  } catch (err) {
    row.error = err.message.slice(0, 120);
  }

  console.log(`\n${row.name}`);
  if (row.error) { console.log(`  ERROR: ${row.error}`); continue; }
  console.log(`  renderer      : ${String(row.gl.renderer).slice(0, 72)}`);
  console.log(`  native toString: ${row.gl.toStringNative}  maxTexture: ${row.gl.maxTexture}  extensions: ${row.gl.extensions}`);
  console.log(`  sannysoft     : ${row.sanny.failed.length === 0 ? '0 failed' : `FAILED -> ${row.sanny.failed.join(', ')}`}`);
  console.log(`  deviceandbrowserinfo: isBot=${row.dbi.isBot}${row.dbi.flagged?.length ? ` flagged -> ${row.dbi.flagged.join(', ')}` : ' (none flagged)'}`);
}

console.log('\ndone');
process.exit(0);
