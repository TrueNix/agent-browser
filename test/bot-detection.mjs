#!/usr/bin/env node
/**
 * Bot-detection gate — the publish precondition.
 *
 * Runs the hardened local mode against live third-party detectors and reports a
 * hard PASS/FAIL. A detector that is unreachable is reported as SKIP, never
 * silently counted as a pass.
 *
 * HONEST SCOPE. This targets FINGERPRINT-level detection: navigator.webdriver,
 * headless UA, window/screen consistency, WebGL, Client Hints, CDP artefacts,
 * and page-vs-worker agreement. It does NOT defeat, and does not try to defeat:
 *   - TLS/JA3-JA4 and HTTP/2 fingerprinting (decided before any JS runs)
 *   - IP reputation (datacenter vs residential ASN)
 *   - behavioural analysis (mouse paths, timing, dwell)
 * Commercial challenge products such as Turnstile or DataDome decide largely on
 * those, so "passes this gate" means "not trivially flagged as automation",
 * not "undetectable".
 */
import { withBrowser } from '../src/client.mjs';

const TIMEOUT = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Each detector returns { status: 'pass'|'fail'|'skip', detail }. */
const DETECTORS = [
  {
    name: 'bot.sannysoft.com',
    url: 'https://bot.sannysoft.com/',
    settleMs: 3000,
    probe: `(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const out = [];
      for (const tr of rows) {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 2) continue;
        const name = (cells[0].innerText || '').trim();
        if (!name) continue;
        out.push({ name, value: (cells[1].innerText || '').trim().slice(0, 50), cls: (cells[1].className || '').trim() });
      }
      return JSON.stringify(out);
    })()`,
    judge(rows) {
      const failed = rows.filter((r) => /failed/i.test(r.cls));
      const passed = rows.filter((r) => /passed/i.test(r.cls));
      return {
        status: failed.length === 0 ? 'pass' : 'fail',
        detail: `${passed.length} passed, ${failed.length} failed`
          + (failed.length ? ` -> ${failed.map((f) => f.name).join(', ')}` : ''),
      };
    },
  },
  {
    name: 'bot-detector.rebrowser.net',
    url: 'https://bot-detector.rebrowser.net/',
    settleMs: 6000,
    probe: `JSON.stringify({ text: (document.body.innerText || '') })`,
    judge({ text }) {
      // The page marks each test 🟢 pass / 🔴 fail / ⚪️ not triggered.
      const red = (text.match(/🔴/g) || []).length;
      const green = (text.match(/🟢/g) || []).length;
      // Careful: the healthy note reads "No leak detected.", which CONTAINS the
      // substring "leak detected". Match the negative phrase explicitly and
      // treat an unreadable result as a leak rather than as success.
      const index = text.indexOf('runtimeEnableLeak');
      const window = index >= 0 ? text.slice(Math.max(0, index - 4), index + 180) : '';
      const leak = index >= 0 && !/no leak detected/i.test(window);
      return {
        status: red === 0 && !leak ? 'pass' : 'fail',
        detail: `${green} green, ${red} red, runtimeEnableLeak: ${index < 0 ? 'not reported' : leak ? 'DETECTED' : 'clean'}`,
      };
    },
  },
  {
    name: 'deviceandbrowserinfo.com',
    url: 'https://deviceandbrowserinfo.com/are_you_a_bot',
    settleMs: 5000,
    probe: `(() => {
      const t = document.body.innerText || '';
      const i = t.indexOf('{'); const j = t.lastIndexOf('}');
      return JSON.stringify({ json: i >= 0 ? t.slice(i, j + 1) : '' });
    })()`,
    judge({ json }) {
      if (!json) return { status: 'skip', detail: 'no verdict JSON on page' };
      const d = JSON.parse(json);
      const flags = Object.entries(d.details || {}).filter(([, v]) => v === true).map(([k]) => k);
      return {
        status: d.isBot === false ? 'pass' : 'fail',
        detail: `isBot=${d.isBot}, ${Object.keys(d.details || {}).length} checks`
          + (flags.length ? ` -> flagged: ${flags.join(', ')}` : ', none flagged'),
      };
    },
  },
  {
    name: 'arh.antoinevastel.com',
    url: 'https://arh.antoinevastel.com/bots/areyouheadless',
    settleMs: 2500,
    probe: `JSON.stringify({ text: (document.body.innerText || '').trim().slice(0, 200) })`,
    judge({ text }) {
      if (!text) return { status: 'skip', detail: 'empty response' };
      return { status: /not.*headless/i.test(text) ? 'pass' : 'fail', detail: text.replace(/\s+/g, ' ').slice(0, 80) };
    },
  },
];

const results = [];

for (const detector of DETECTORS) {
  let outcome;
  try {
    outcome = await withBrowser({}, async (session) => {
      const state = await session.navigate(detector.url, { timeoutMs: TIMEOUT });
      // A 5xx means the DETECTOR is down, not that we were detected. Its error
      // page renders fine, so without this check the judge would read nginx's
      // "502 Bad Gateway" as a verdict and fail the gate for the wrong reason.
      if (typeof state.status === 'number' && state.status >= 500) {
        return { status: 'skip', detail: `detector unavailable: HTTP ${state.status}` };
      }
      await sleep(detector.settleMs);
      return detector.judge(JSON.parse(await session.evaluate(detector.probe)));
    });
  } catch (err) {
    // An unreachable or broken detector is NOT evidence of passing.
    outcome = { status: 'skip', detail: `unreachable: ${err.message.replace(/\s+/g, ' ').slice(0, 90)}` };
  }
  results.push({ name: detector.name, ...outcome });
  const icon = outcome.status === 'pass' ? 'PASS' : outcome.status === 'fail' ? 'FAIL' : 'SKIP';
  console.log(`${icon}  ${detector.name.padEnd(28)} ${outcome.detail}`);
}

const failed = results.filter((r) => r.status === 'fail');
const passed = results.filter((r) => r.status === 'pass');
const skipped = results.filter((r) => r.status === 'skip');

console.log('\n--- gate ---');
console.log(`passed ${passed.length}, failed ${failed.length}, skipped ${skipped.length}`);

// Require every reachable detector to pass, and demand a real quorum so a day
// when every site is down cannot be mistaken for success.
const ok = failed.length === 0 && passed.length >= 3;
console.log(ok
  ? 'RESULT: PASS — fingerprint-level detection cleared; publishing permitted.'
  : `RESULT: FAIL — do not publish.${passed.length < 3 && failed.length === 0 ? ' (too few reachable detectors for a verdict)' : ''}`);

process.exitCode = ok ? 0 : 1;
