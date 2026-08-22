# Changelog

## 1.1.0

### Breaking

- `navigate()`'s `settleMs` now defaults to `0` instead of `250`. The pause was
  never load-bearing — `load` produces identical output on every page measured —
  and where it mattered it was too short anyway. Use `waitUntil: 'idle'` for
  late-rendering pages, or pass `settleMs` explicitly to restore the old pause.
- `session.links()` now returns `{ links, total, truncated }` and
  `session.accessibilityTree()` returns `{ nodes, total, truncated }`, instead of
  bare arrays. Both were capped silently before — 500 links, and an unbounded
  tree that reached 8137 nodes / 508 kB on a single Wikipedia article. An agent
  could not tell a clipped result from a complete one, which is how a confident
  wrong conclusion gets made. The cap is now visible, and adjustable via `limit`
  (`0` for none).

### Fixed

- **Table cells kept none of their inline markup.** Cells were rendered with
  `innerText`, so every link, code span and emphasis inside a table was
  discarded. On a table-based layout that is the entire page: Hacker News has
  229 anchors and none survived. Cells now render through a proper inline pass.
- **Layout tables are no longer forced into pipe syntax.** A table containing
  another table is page furniture, not data; rendering it as Markdown collapsed
  whole sites into one unreadable cell. Those are now descended into normally.
- Tables that hit the row cap say so instead of truncating silently.

### Added

- **Event-driven navigation.** `navigate()` waited by polling
  `document.readyState` every 200 ms and then sleeping a flat 250 ms. It now
  waits on CDP lifecycle events: byte-identical output, 2–3× faster
  (`example.com` 258 ms → 7 ms, `news.ycombinator.com` 466 ms → 218 ms).
- `waitUntil` on `navigate()` and on every page-loading tool —
  `domcontentloaded`, `load` (default), `idle`. The fixed settle was a guess in
  both directions: it taxed every page a quarter second *and* still missed
  content rendered after load. `idle` waits for the network to go quiet, which
  is the actual signal. CLI: `--wait <mode>`, plus `--settle <ms>` for the rare
  case that wants a raw pause.
- `links` extraction mode — `inline` (default), `relative`, `text`. URLs are 36%
  of the characters on a Wikipedia article and 81% on `github.com/trending`, so
  `text` roughly halves a link-dense page when the agent is reading rather than
  navigating. CLI: `--links <mode>`.
- `maxRows` for table extraction (CLI `--max-rows`), `limit` for links and the
  accessibility tree (CLI `--limit`). `0` disables each cap.
- **One shared tool catalogue** (`src/tools.mjs`, exported as
  `@truenix/agent-browser/tools`). The MCP server and the DSH/Cordis plugin now
  derive from it, so DSH gains `browser_html`, `browser_accessibility_tree` and
  `browser_pdf` — it had six tools where MCP had nine.
- `agent-browser tools [--format mcp|openai|anthropic]` prints the schemas, so
  any harness that reads JSON Schema can drive the browser. Each tool carries
  both an in-process `run(session, args)` and an out-of-process `cli(args)`.

### Note

The README's benchmark numbers moved because the extraction fixes recover
content that was previously being dropped. Wikipedia went 97 kB → 120 kB and HN
6.7 kB → 10 kB in the default mode, while gaining 572 and 136 links
respectively. `--links text` lands well below the old figures on both.
`heavy-benchmark.png` and `token-cost-graph.png` still show pre-1.1.0 numbers.

## 1.0.3 (unreleased)

### Fixed

- `launchBrowser` had no `error` listener on the spawned child, so a spawn
  failure (EACCES, a stale `AGENT_BROWSER_BIN`, EAGAIN) surfaced as an unhandled
  event and killed the process: the CLI's catch never ran, an MCP server died
  mid-session, and the temp profile leaked. It now rejects normally.
- `install()` keyed its decision off the dependency rather than the bundle
  entry, so a profile carrying one without the other was told "already
  installed" and left unwired.
- `uninstall()` threw a `TypeError` on any profile with the dependency but no
  `dsh` block.
- `deriveIdentity` hardcoded an `X11; Linux x86_64` User-Agent, which is the
  fallback that runs on macOS and Windows — the browser claimed Linux while
  `navigator.platform` said `MacIntel`. The token now follows the host, and
  `Sec-CH-UA-Arch` follows the real CPU.
- Windows path handling: `path.delimiter` instead of `':'`, `.exe` candidates,
  and a path check that recognises `C:\...\chrome.exe` (which had broken
  `AGENT_BROWSER_BIN` there).
- The MCP server advertised a hardcoded `serverInfo.version` of `1.0.0`.
- A throw inside `MiniWebSocket#feed` escaped the socket's `data` handler as an
  uncaught exception.

## 1.0.2

- npm Trusted Publishing (OIDC) workflow.

## 1.0.1

- Auto-install for DSH: `npx agent-browser install`.

## 1.0.0

- Initial release.
