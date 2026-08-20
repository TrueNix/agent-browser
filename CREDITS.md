# Credits

`agent-browser` is original code with zero runtime dependencies, but almost none
of its hardening was invented here. Nearly every measure exists because someone
else published a detection technique, and the implementation was then driven by
running against their work. Credit where it belongs:

## Detection research this project is measured against

- **[rebrowser-bot-detector](https://github.com/rebrowser/rebrowser-bot-detector)**
  ([live](https://bot-detector.rebrowser.net/)) — by far the most useful source for
  this project. Its `runtimeEnableLeak` test is why this client never calls
  `Runtime.enable`, and its `viewport` test caught the 1280×720 default that
  detectors flag by name. The related **rebrowser-patches** project documents the
  CDP leak surface in detail.
- **[bot.sannysoft.com](https://bot.sannysoft.com/)** — the classic fingerprint
  test page. `HEADCHR_UA`, `CHR_MEMORY` and the WebGL renderer rows shaped the
  launch flags.
- **[deviceandbrowserinfo.com](https://deviceandbrowserinfo.com/are_you_a_bot)** —
  its composite verdict, and specifically the `hasInconsistentWorkerValues` check,
  exposed two page-vs-worker mismatches that no single-surface test would catch.
- **[Antoine Vastel](https://antoinevastel.com/)** — long-running public research on
  headless-browser detection, including the `areyouheadless` test.
- **[CreepJS](https://abrahamjuliot.github.io/creepjs/)** by Abraham Juliot — a
  reference for how thorough fingerprint lie-detection can get.

## Prior art in the same space

These solve overlapping problems, several of them more thoroughly. If this
package does not fit your needs, look at them:

- **[Camoufox](https://github.com/daijro/camoufox)** — a patched Firefox that spoofs
  at the C++ level rather than by injecting JavaScript, so there is no JS shim to
  catch with `Function.prototype.toString`. The correct way to do this properly.
- **[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)** and
  **[rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)** — patched
  Playwright/Puppeteer that remove the `Runtime.enable` leak.
- **[nodriver](https://github.com/ultrafunkamsterdam/nodriver)** /
  **undetected-chromedriver** — the same battle from the Python side.

## Standards and platforms

- **[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)** —
  the entire interface this package speaks.
- **Chromium / Google Chrome** — the actual browser doing the work. Its real
  network stack is the part no custom engine can substitute for.
- **RFC 6455** — the WebSocket protocol, implemented from scratch in `src/ws.mjs`
  so the package needs no dependencies.

## Honesty about scope

The hardening here clears *fingerprint-level* detection. It does not defeat
TLS/JA3-JA4 fingerprinting, IP reputation, or behavioural analysis, and it is not
trying to. Commercial challenge products decide largely on those signals, before
any page JavaScript runs. Treat "passes the gate in `test/bot-detection.mjs`" as
"not trivially flagged as automation", never as "undetectable".
