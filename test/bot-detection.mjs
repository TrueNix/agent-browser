#!/usr/bin/env node
/**
 * Bot-detection live gate.
 *
 * Runs the hardened local mode against live third-party detectors and reports a
 * hard PASS/FAIL. A detector that is unreachable is reported as SKIP, never
 * silently counted as a pass. This is an environment check, not a publication
 * workflow.
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
const fail = (detail) => ({ status: 'fail', detail });

const SANNYSOFT_REQUIRED_IDS = [
  'user-agent-result',
  'webdriver-result',
  'advanced-webdriver-result',
  'chrome-result',
  'permissions-result',
  'plugins-length-result',
  'plugins-type-result',
  'languages-result',
  'webgl-vendor',
  'webgl-renderer',
  'broken-image-dimensions',
];

const REBROWSER_EXPECTED_TYPES = [
  'dummyFn',
  'sourceUrlLeak',
  'mainWorldExecution',
  'runtimeEnableLeak',
  'exposeFunctionLeak',
  'navigatorWebdriver',
  'bypassCsp',
  'viewport',
  'useragent',
  'pwInitScripts',
];
const REBROWSER_EXPECTED_GRAY = new Set([
  // mainWorldExecution is actively exercised in the isolated world and must
  // stay gray. exposeFunctionLeak is intentionally unexecuted because
  // agent-browser has no expose-function API.
  'mainWorldExecution',
  'exposeFunctionLeak',
]);

const DEVICE_INFO_REQUIRED_DETAILS = [
  'hasWebdriverTrue',
  'hasWebdriverInFrameTrue',
  'isHeadlessChrome',
  'isAutomatedWithCDP',
  'isAutomatedWithCDPInWebWorker',
  'hasInconsistentClientHints',
  'hasInconsistentWorkerValues',
  'isWebGLInconsistent',
  'hasSuspiciousWeakSignals',
];

/** Each detector returns { status: 'pass'|'fail'|'skip', detail }. */
const DETECTORS = [
  {
    name: 'bot.sannysoft.com',
    url: 'https://bot.sannysoft.com/',
    settleMs: 3000,
    probe: `(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const results = [];
      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('td'));
        if (cells.length < 2) continue;
        const verdict = cells.find((cell) => /(?:^|\\s)(?:passed|failed|warn)(?:\\s|$)/i.test(cell.className || ''));
        if (!verdict) continue;
        const name = (cells[0].innerText || '').trim();
        if (!name) continue;
        results.push({
          name,
          id: verdict.id || '',
          value: (verdict.innerText || '').trim().slice(0, 80),
          cls: (verdict.className || '').trim(),
        });
      }
      return JSON.stringify({
        title: document.title,
        heading: (document.querySelector('h1')?.innerText || '').trim(),
        results,
      });
    })()`,
    judge(data) {
      if (!data || data.title !== 'Antibot' || !/Intoli\.com tests/i.test(data.heading || '')) {
        return fail('unrecognized page: missing Antibot title or Intoli test heading');
      }
      const rows = Array.isArray(data.results) ? data.results : [];
      if (rows.length < 20) {
        return fail(`incomplete detector output: ${rows.length} classified results (need at least 20)`);
      }
      const ids = new Set(rows.map((r) => r.id).filter(Boolean));
      const missing = SANNYSOFT_REQUIRED_IDS.filter((id) => !ids.has(id));
      if (missing.length) {
        return fail(`incomplete detector output: missing ${missing.join(', ')}`);
      }
      const failed = rows.filter((r) => /(?:^|\s)(?:failed|warn)(?:\s|$)/i.test(r.cls || ''));
      const passed = rows.filter((r) => /(?:^|\s)passed(?:\s|$)/i.test(r.cls || ''));
      return {
        status: failed.length === 0 ? 'pass' : 'fail',
        detail: `${passed.length} passed, ${failed.length} failed/warned`
          + (failed.length ? ` -> ${failed.map((f) => f.name).join(', ')}` : ''),
      };
    },
  },
  {
    name: 'bot-detector.rebrowser.net',
    url: 'https://bot-detector.rebrowser.net/',
    settleMs: 6000,
    mainTrigger: `(() => {
      const dummyFnCalled = typeof window.dummyFn === 'function' && window.dummyFn() === true;
      const jsonField = document.getElementById('detections-json');
      return JSON.stringify({
        dummyFnCalled,
        idLookupRan: Boolean(jsonField && jsonField.tagName === 'TEXTAREA'),
      });
    })()`,
    trigger: `(() => {
      const dummyFnVisible = typeof window.dummyFn === 'function';
      const classCount = document.getElementsByClassName('div').length;
      return JSON.stringify({
        dummyFnHidden: !dummyFnVisible,
        classLookupRan: Number.isInteger(classCount) && classCount >= 0,
      });
    })()`,
    probe: `JSON.stringify({
      title: document.title,
      heading: (document.querySelector('h1')?.innerText || '').trim(),
      json: document.querySelector('#detections-json')?.value || '',
    })`,
    judge(data, triggers) {
      const triggerFailures = [];
      if (!triggers?.main?.dummyFnCalled) triggerFailures.push('main-world dummyFn call not confirmed');
      if (!triggers?.main?.idLookupRan) triggerFailures.push('main-world id lookup not confirmed');
      if (!triggers?.isolated?.dummyFnHidden) triggerFailures.push('dummyFn visible in isolated world');
      if (!triggers?.isolated?.classLookupRan) triggerFailures.push('isolated class lookup not confirmed');
      if (!data || data.title !== 'rebrowser-bot-detector' || !/rebrowser-bot-detector/i.test(data.heading || '')) {
        return fail('unrecognized page: missing Rebrowser title or heading');
      }
      let detections;
      try {
        detections = JSON.parse(data.json);
      } catch {
        return fail('unreadable detector JSON');
      }
      if (!Array.isArray(detections) || detections.length < REBROWSER_EXPECTED_TYPES.length) {
        return fail(`incomplete detector output: ${Array.isArray(detections) ? detections.length : 0} results`);
      }
      const byType = new Map(detections.map((d) => [d?.type, d]));
      const missing = REBROWSER_EXPECTED_TYPES.filter((type) => !byType.has(type));
      if (missing.length) return fail(`incomplete detector output: missing ${missing.join(', ')}`);

      const unsafe = detections.filter((d) => typeof d?.rating !== 'number' || d.rating > 0);
      const unexpectedGray = detections.filter((d) => d?.rating === 0 && !REBROWSER_EXPECTED_GRAY.has(d.type));
      const expectedGrayChanged = ['mainWorldExecution', 'exposeFunctionLeak']
        .filter((type) => byType.get(type).rating !== 0);
      const expectedGreenMissing = REBROWSER_EXPECTED_TYPES
        .filter((type) => !REBROWSER_EXPECTED_GRAY.has(type) && byType.get(type).rating >= 0);
      const failedTypes = new Set([
        ...unsafe.map((d) => d?.type || 'malformed result'),
        ...unexpectedGray.map((d) => d.type),
        ...expectedGrayChanged,
        ...expectedGreenMissing,
        ...triggerFailures,
      ]);
      const green = detections.filter((d) => d?.rating < 0).length;
      const calibrationClean = ['dummyFn', 'sourceUrlLeak'].every((type) => byType.get(type).rating < 0);
      return {
        status: failedTypes.size === 0 ? 'pass' : 'fail',
        detail: `${green} green; main-world calibration ${calibrationClean ? 'clean' : 'FAILED'}: dummyFn, sourceUrlLeak;`
          + ' active isolated probe stayed gray: mainWorldExecution; intentionally unexecuted: exposeFunctionLeak'
          + (failedTypes.size ? ` -> unsafe/incomplete: ${[...failedTypes].join(', ')}` : ''),
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
      return JSON.stringify({
        title: document.title,
        hasQuestion: /Are you a bot\\?/i.test(t),
        hasRawDetails: /Raw detection details/i.test(t),
        json: i >= 0 && j > i ? t.slice(i, j + 1) : '',
      });
    })()`,
    judge(data) {
      if (!data || !/bot detection test/i.test(data.title || '') || !data.hasQuestion || !data.hasRawDetails) {
        return fail('unrecognized page: missing bot-test title or result markers');
      }
      let d;
      try {
        d = JSON.parse(data.json);
      } catch {
        return fail('unreadable verdict JSON');
      }
      const details = d?.details;
      if (typeof d?.isBot !== 'boolean' || !details || typeof details !== 'object' || Array.isArray(details)) {
        return fail('malformed verdict JSON');
      }
      const detailKeys = Object.keys(details);
      const missing = DEVICE_INFO_REQUIRED_DETAILS.filter((key) => !detailKeys.includes(key));
      const nonBoolean = detailKeys.filter((key) => typeof details[key] !== 'boolean');
      if (detailKeys.length < 20 || missing.length || nonBoolean.length) {
        return fail(`incomplete verdict: ${detailKeys.length} checks`
          + (missing.length ? `, missing ${missing.join(', ')}` : '')
          + (nonBoolean.length ? `, non-boolean ${nonBoolean.join(', ')}` : ''));
      }
      const flags = Object.entries(details).filter(([, value]) => value === true).map(([key]) => key);
      return {
        status: d.isBot === false && flags.length === 0 ? 'pass' : 'fail',
        detail: `isBot=${d.isBot}, ${detailKeys.length} checks`
          + (flags.length ? ` -> flagged: ${flags.join(', ')}` : ', none flagged'),
      };
    },
  },
  {
    name: 'arh.antoinevastel.com',
    url: 'https://arh.antoinevastel.com/bots/areyouheadless',
    settleMs: 2500,
    probe: `JSON.stringify({
      title: document.title,
      verdict: (document.querySelector('#res')?.textContent || '').trim(),
    })`,
    judge(data) {
      const verdict = data?.verdict || '';
      if (!verdict) return fail('unrecognized page: missing #res verdict');
      return {
        status: /^You are not Chrome headless[.!]?$/i.test(verdict) ? 'pass' : 'fail',
        detail: verdict.replace(/\s+/g, ' ').slice(0, 80),
      };
    },
  },
];

function runJudgeSelfTests() {
  const rebrowser = DETECTORS.find((d) => d.name === 'bot-detector.rebrowser.net');
  const greenTypes = REBROWSER_EXPECTED_TYPES.filter((type) => !REBROWSER_EXPECTED_GRAY.has(type));
  const safeDetections = [
    ...[...REBROWSER_EXPECTED_GRAY].map((type) => ({ type, rating: 0 })),
    ...greenTypes.map((type) => ({ type, rating: -1 })),
  ];
  const rebrowserPage = {
    title: 'rebrowser-bot-detector',
    heading: 'rebrowser-bot-detector',
    json: JSON.stringify(safeDetections),
  };
  const triggers = {
    main: { dummyFnCalled: true, idLookupRan: true },
    isolated: { dummyFnHidden: true, classLookupRan: true },
  };
  const cases = [
    ['SannySoft blank', DETECTORS[0].judge({}), 'fail'],
    ['SannySoft challenge', DETECTORS[0].judge({ title: 'Just a moment...', heading: '', results: [] }), 'fail'],
    ['Rebrowser blank', rebrowser.judge({}, triggers), 'fail'],
    ['Rebrowser unexecuted trigger', rebrowser.judge(rebrowserPage, {}), 'fail'],
    ['Rebrowser calibrated isolated trigger', rebrowser.judge(rebrowserPage, triggers), 'pass'],
    ['Rebrowser uncalibrated gray', rebrowser.judge({
      ...rebrowserPage,
      json: JSON.stringify(safeDetections.map((d) => (
        ['dummyFn', 'sourceUrlLeak'].includes(d.type) ? { ...d, rating: 0 } : d
      ))),
    }, triggers), 'fail'],
    ['Rebrowser main-world leak', rebrowser.judge({
      ...rebrowserPage,
      json: JSON.stringify(safeDetections.map((d) => (
        d.type === 'mainWorldExecution' ? { ...d, rating: 1 } : d
      ))),
    }, triggers), 'fail'],
    ['Device Info blank', DETECTORS[2].judge({}), 'fail'],
    ['Device Info malformed', DETECTORS[2].judge({
      title: 'Bot detection test', hasQuestion: true, hasRawDetails: true, json: '{}',
    }), 'fail'],
    ['Antoine Vastel blank', DETECTORS[3].judge({}), 'fail'],
  ];
  const failures = cases.filter(([, outcome, expected]) => outcome.status !== expected);
  if (failures.length) {
    throw new Error(`judge self-test failed: ${failures.map(([name]) => name).join(', ')}`);
  }
  console.log(`judge self-test: ${cases.length} passed`);
}

async function runGate() {
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
        if (typeof state.status === 'number' && state.status >= 400) {
          return fail(`detector returned HTTP ${state.status}; no trustworthy verdict`);
        }
        await sleep(detector.settleMs);

        const triggers = {};
        if (detector.mainTrigger) {
          try {
            triggers.main = JSON.parse(await session.evaluate(detector.mainTrigger, { world: 'main' }));
          } catch (err) {
            return fail(`main-world calibration failed: ${err.message.replace(/\s+/g, ' ').slice(0, 90)}`);
          }
        }
        if (detector.trigger) {
          try {
            triggers.isolated = JSON.parse(await session.evaluate(detector.trigger));
          } catch (err) {
            return fail(`isolated detector trigger failed: ${err.message.replace(/\s+/g, ' ').slice(0, 90)}`);
          }
        }
        let data;
        try {
          data = JSON.parse(await session.evaluate(detector.probe));
        } catch (err) {
          return fail(`detector probe was unreadable: ${err.message.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
        try {
          return detector.judge(data, triggers);
        } catch (err) {
          return fail(`detector judge rejected its output: ${err.message.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      });
    } catch (err) {
      // Navigation/transport failure is detector unavailability, never a pass.
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
    ? 'RESULT: PASS — reachable fingerprint gate passed in this environment.'
    : `RESULT: FAIL — reachable fingerprint gate did not pass.${passed.length < 3 && failed.length === 0 ? ' (too few reachable detectors for a verdict)' : ''}`);

  process.exitCode = ok ? 0 : 1;
}

if (process.argv.includes('--judge-self-test')) {
  runJudgeSelfTests();
} else {
  await runGate();
}
