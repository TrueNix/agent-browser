#!/usr/bin/env node
/**
 * Regenerate the README charts.
 *
 *   node scripts/make-charts.mjs
 *
 * The charts used to be static PNGs with no generator, so when extraction
 * changed they silently became wrong. This script MEASURES first and renders
 * second — the numbers in the image cannot drift from the numbers the code
 * actually produces, because they are the same numbers.
 *
 * It renders with agent-browser itself. There is no chart or headless-browser
 * dependency; gpt-tokenizer is dev-only and supplies exact o200k_base counts.
 *
 * Dev tooling — `scripts/` is not in package.json "files", so it never ships.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { withBrowser } from '../src/client.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The benchmark manifest is the source of truth for the README table, charts,
 * and benchmark-results.json. Every README table row must live here.
 */
const PAGES = [
  {
    id: 'wikipedia-webassembly',
    url: 'https://en.wikipedia.org/wiki/WebAssembly',
    label: 'Wikipedia\nWebAssembly',
    readmeLabel: 'en.wikipedia.org/wiki/WebAssembly',
    readmeTable: true,
  },
  { id: 'react', url: 'https://react.dev', label: 'react.dev', readmeLabel: 'react.dev', readmeTable: true },
  { id: 'nextjs', url: 'https://nextjs.org', label: 'nextjs.org', readmeLabel: 'nextjs.org', readmeTable: true },
  {
    id: 'github-trending',
    url: 'https://github.com/trending',
    label: 'github.com\n/trending',
    readmeLabel: 'github.com/trending',
    readmeTable: true,
  },
  { id: 'apple', url: 'https://apple.com', label: 'apple.com', readmeLabel: 'apple.com', readmeTable: true },
  {
    id: 'hacker-news',
    url: 'https://news.ycombinator.com',
    label: 'Hacker News',
    readmeLabel: 'news.ycombinator.com',
    readmeTable: true,
  },
  {
    id: 'yc-blog',
    url: 'https://www.ycombinator.com/blog',
    label: 'YC Blog',
    readmeLabel: 'www.ycombinator.com/blog',
    readmeTable: false,
  },
];

const TOKENIZER = Object.freeze({
  encoding: 'o200k_base',
  implementation: 'gpt-tokenizer',
  version: '4.0.0',
  exact: true,
});

const YC_SCENARIO_IDS = ['hacker-news', 'yc-blog'];
const README_TABLE_START = '<!-- benchmark-table:start -->';
const README_TABLE_END = '<!-- benchmark-table:end -->';

const INK = {
  bg: '#131313',
  grid: '#282828',
  axis: '#8a8a8a',
  title: '#f2f2f2',
  sub: '#9a9a9a',
  red: '#ff4438',
  green: '#25c65b',
  pill: '#3a3a3a',
};

const formatBytes = (bytes) => (bytes >= 100000
  ? `${Math.round(bytes / 1000)} kB`
  : `${(bytes / 1000).toFixed(1)} kB`);
const formatTokens = (tokens) => (tokens >= 100000
  ? `${Math.round(tokens / 1000)}k`
  : `${(tokens / 1000).toFixed(1)}k`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function payload(text) {
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    tokens: encode(text).length,
  };
}

function sumPayload(rows, key) {
  return rows.reduce((sum, row) => ({
    bytes: sum.bytes + row.payloads[key].bytes,
    tokens: sum.tokens + row.payloads[key].tokens,
  }), { bytes: 0, tokens: 0 });
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function ratio(before, after) {
  return Number((before / after).toFixed(2));
}

function markdownMetric(metric) {
  return `${formatBytes(metric.bytes)} / ${formatTokens(metric.tokens)} tok`;
}

function updateReadmeTable(rows) {
  const path = join(root, 'README.md');
  const readme = readFileSync(path, 'utf8');
  const start = readme.indexOf(README_TABLE_START);
  const end = readme.indexOf(README_TABLE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('README benchmark table markers are missing or out of order');
  }

  const lines = [
    README_TABLE_START,
    '| site | rendered DOM | Markdown | `--links text` | exact token reduction |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows.filter((row) => row.readmeTable).map((row) => {
      const { rawDom, defaultMarkdown, linksText } = row.payloads;
      return `| \`${row.readmeLabel}\` | ${markdownMetric(rawDom)} | **${markdownMetric(defaultMarkdown)}** | ${markdownMetric(linksText)} | ${ratio(rawDom.tokens, defaultMarkdown.tokens)}× / ${ratio(rawDom.tokens, linksText.tokens)}× |`;
    }),
    README_TABLE_END,
  ];

  const next = `${readme.slice(0, start)}${lines.join('\n')}${readme.slice(end + README_TABLE_END.length)}`;
  writeFileSync(path, next);
}

/** A grouped bar chart, drawn as plain SVG in the existing dark house style. */
function barChart({ width, height, title, subtitle, groups, series, footer, note, format }) {
  const padTop = 66;
  const labelLines = Math.max(...groups.map((g) => g.label.split('\n').length));
  // Two-line site names, the per-group sub line, then the legend and footer.
  const padBottom = 62 + labelLines * 13 + (groups.some((g) => g.sub) ? 14 : 0);
  const padLeft = 62;
  const padRight = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const max = Math.max(...groups.flatMap((g) => g.values));
  // Round the top of the scale up to a clean step so the axis reads
  // "1000kB", not "1093kB".
  const rough = max * 1.18;
  const step = 10 ** Math.floor(Math.log10(rough / 4));
  const ceiling = Math.ceil(rough / (4 * step)) * 4 * step;
  const y = (v) => padTop + plotH - (v / ceiling) * plotH;

  const bands = groups.length;
  const bandW = plotW / bands;
  const barW = Math.min(34, (bandW * 0.62) / series.length);
  const gap = 10;
  const clusterW = series.length * barW + (series.length - 1) * gap;

  const out = [];
  out.push(`<rect width="${width}" height="${height}" fill="${INK.bg}"/>`);
  out.push(`<text x="${width / 2}" y="26" text-anchor="middle" fill="${INK.title}" font-size="17" font-weight="700">${esc(title)}</text>`);
  out.push(`<text x="${width / 2}" y="46" text-anchor="middle" fill="${INK.sub}" font-size="10.5">${esc(subtitle)}</text>`);

  // gridlines + y axis
  for (let i = 0; i <= 4; i += 1) {
    const v = (ceiling / 4) * i;
    const gy = y(v);
    out.push(`<line x1="${padLeft}" y1="${gy}" x2="${width - padRight}" y2="${gy}" stroke="${INK.grid}" stroke-width="1"/>`);
    out.push(`<text x="${padLeft - 10}" y="${gy + 3.5}" text-anchor="end" fill="${INK.axis}" font-size="9.5">${format(v)}</text>`);
  }

  groups.forEach((group, gi) => {
    const centre = padLeft + bandW * gi + bandW / 2;
    const startX = centre - clusterW / 2;

    group.values.forEach((value, si) => {
      const bx = startX + si * (barW + gap);
      const by = y(value);
      const bh = Math.max(2, padTop + plotH - by);
      out.push(`<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="5" fill="${series[si].color}"/>`);
      out.push(`<text x="${bx + barW / 2}" y="${by - 7}" text-anchor="middle" fill="${series[si].color}" font-size="10" font-weight="700">${esc(group.labels[si])}</text>`);
    });

    // saving pill, anchored between the first and last bar
    if (group.pill) {
      const px = startX + clusterW / 2;
      // Normally the pill tucks just under the tallest bar's cap. When every bar
      // in the group is short there is no room under it — the pill would land on
      // the value labels, or on the axis label below them — so it goes above
      // instead.
      const topY = y(Math.max(...group.values));
      const cramped = padTop + plotH - topY < plotH * 0.22;
      const py = cramped ? topY - 30 : topY + 26;
      const pw = group.pill.length * 6.2 + 16;
      out.push(`<rect x="${px - pw / 2}" y="${py - 11}" width="${pw}" height="19" rx="9.5" fill="${INK.pill}"/>`);
      out.push(`<text x="${px}" y="${py + 2.5}" text-anchor="middle" fill="#eaeaea" font-size="10" font-weight="700">${esc(group.pill)}</text>`);
    }

    group.label.split('\n').forEach((line, li) => {
      out.push(`<text x="${centre}" y="${padTop + plotH + 20 + li * 13}" text-anchor="middle" fill="${INK.title}" font-size="11">${esc(line)}</text>`);
    });
    if (group.sub) {
      // Fixed baseline, so a one-line and a two-line site name still line up.
      out.push(`<text x="${centre}" y="${padTop + plotH + 22 + labelLines * 13}" text-anchor="middle" fill="${INK.sub}" font-size="9">${esc(group.sub)}</text>`);
    }
  });

  // legend
  let lx = padLeft;
  series.forEach((s) => {
    out.push(`<rect x="${lx}" y="${height - 36}" width="11" height="11" rx="3" fill="${s.color}"/>`);
    out.push(`<text x="${lx + 17}" y="${height - 27}" fill="${INK.sub}" font-size="10">${esc(s.name)}</text>`);
    lx += 17 + s.name.length * 5.9 + 22;
  });
  if (note) out.push(`<text x="${width - padRight}" y="${height - 27}" text-anchor="end" fill="${INK.sub}" font-size="9.5">${esc(note)}</text>`);
  out.push(`<text x="${width / 2}" y="${height - 10}" text-anchor="middle" fill="#6b6b6b" font-size="9">${esc(footer)}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">${out.join('')}</svg>`;
}

/** Render one SVG to PNG using this package's own browser. */
async function renderPng(svg, { width, height, out }) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    // overflow:hidden — a scrollbar would otherwise be baked into the PNG.
    res.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:${INK.bg}}svg{display:block}</style>${svg}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const png = await withBrowser({ width, height }, async (session) => {
      await session.setViewport({ width, height, deviceScaleFactor: 2 });
      await session.navigate(`http://127.0.0.1:${server.address().port}/`);
      return session.screenshot();
    });
    writeFileSync(out, png);
    console.log(`  wrote ${out}  (${width}x${height} @2x, ${(png.length / 1024).toFixed(1)} kB)`);
  } finally { server.close(); }
}

async function main() {
  const startedAt = new Date().toISOString();
  let browser = null;

  console.log('measuring live page-input payloads...');
  const pages = await withBrowser({}, async (session) => {
    const rows = [];
    for (const page of PAGES) {
      const state = await session.navigate(page.url, { timeoutMs: 45000, throwOnHttpError: true });
      if (!browser) {
        const value = await session.evaluate(`JSON.stringify({
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemoryGiB: navigator.deviceMemory ?? null
        })`);
        browser = JSON.parse(value);
      }

      const rawDom = await session.html();
      const defaultMarkdown = await session.markdown();
      const linksText = await session.markdown({ links: 'text' });
      const payloads = {
        rawDom: payload(rawDom),
        defaultMarkdown: payload(defaultMarkdown),
        linksText: payload(linksText),
      };
      console.log(
        `  ${page.url.padEnd(42)} DOM ${formatBytes(payloads.rawDom.bytes).padStart(8)}`
        + ` / ${formatTokens(payloads.rawDom.tokens).padStart(6)} tok`
        + `  md ${formatBytes(payloads.defaultMarkdown.bytes).padStart(8)}`
        + ` / ${formatTokens(payloads.defaultMarkdown.tokens).padStart(6)} tok`
        + `  text ${formatBytes(payloads.linksText.bytes).padStart(8)}`
        + ` / ${formatTokens(payloads.linksText.tokens).padStart(6)} tok`,
      );
      rows.push({
        ...page,
        finalUrl: state.url,
        title: state.title,
        httpStatus: state.status,
        capturedAt: new Date().toISOString(),
        payloads,
      });
    }
    return rows;
  });

  const scenarioRows = YC_SCENARIO_IDS.map((id) => pages.find((page) => page.id === id));
  if (scenarioRows.some((row) => !row)) throw new Error('YC scenario references a page missing from the manifest');
  const scenarioPayloads = {
    rawDom: sumPayload(scenarioRows, 'rawDom'),
    defaultMarkdown: sumPayload(scenarioRows, 'defaultMarkdown'),
    linksText: sumPayload(scenarioRows, 'linksText'),
  };
  const scenario = {
    id: 'hacker-news-and-yc-blog',
    label: 'Hacker News + YC Blog',
    pageIds: YC_SCENARIO_IDS,
    aggregation: 'sum of independently tokenized page payloads',
    payloads: scenarioPayloads,
    tokenReduction: {
      defaultMarkdown: ratio(scenarioPayloads.rawDom.tokens, scenarioPayloads.defaultMarkdown.tokens),
      linksText: ratio(scenarioPayloads.rawDom.tokens, scenarioPayloads.linksText.tokens),
    },
  };

  const results = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    measurementStartedAt: startedAt,
    tokenizer: TOKENIZER,
    extraction: {
      rawDom: 'document.documentElement.outerHTML after page load',
      defaultMarkdown: { main: true, links: 'inline', maxRows: 60 },
      linksText: { main: true, links: 'text', maxRows: 60 },
    },
    source: {
      repository: commandOutput('git', ['remote', 'get-url', 'origin']),
      branch: commandOutput('git', ['branch', '--show-current']),
      commit: commandOutput('git', ['rev-parse', 'HEAD']),
      workingTreeDirtyAtGeneration: Boolean(commandOutput('git', ['status', '--porcelain'])),
    },
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      os: commandOutput('uname', ['-sr']),
      browser,
    },
    pages,
    scenarios: [scenario],
    limitations: [
      'Live pages change over time, so results are a dated snapshot.',
      'A successful HTTP status is required, but HTTP 200 challenge or experiment pages are still possible.',
      'Counts cover page-input payloads only, not prompts, tool schemas, retries, caches, or model output.',
      'Token totals use o200k_base and may differ for models with another tokenizer.',
    ],
  };

  console.log('rendering...');
  const readmeRows = pages.filter((page) => page.readmeTable);
  await renderPng(barChart({
    width: 900,
    height: 480,
    title: 'Live page payload: Rendered DOM vs agent-browser',
    subtitle: 'UTF-8 bytes  •  rendered DOM after load  •  extracted Markdown',
    series: [
      { name: 'Rendered DOM', color: INK.red },
      { name: 'agent-browser markdown', color: INK.green },
      { name: 'markdown --links text', color: '#7dd3fc' },
    ],
    groups: readmeRows.map((r) => ({
      label: r.label,
      sub: `${formatBytes(r.payloads.defaultMarkdown.bytes)} md  •  ${formatBytes(r.payloads.linksText.bytes)} lean`,
      values: [r.payloads.rawDom.bytes, r.payloads.defaultMarkdown.bytes, r.payloads.linksText.bytes],
      labels: [
        formatBytes(r.payloads.rawDom.bytes),
        formatBytes(r.payloads.defaultMarkdown.bytes),
        formatBytes(r.payloads.linksText.bytes),
      ],
      pill: `${ratio(r.payloads.rawDom.bytes, r.payloads.defaultMarkdown.bytes)}x / ${ratio(r.payloads.rawDom.bytes, r.payloads.linksText.bytes)}x`,
    })),
    footer: 'Measured live by npm run charts  •  details in benchmark-results.json',
    format: (v) => `${Math.round(v / 1000)} kB`,
  }), { width: 900, height: 480, out: join(root, 'heavy-benchmark.png') });

  const tokenGroups = [
    ...scenarioRows.map((row) => ({ label: row.label, payloads: row.payloads })),
    { label: 'Combined\n(2 page inputs)', payloads: scenarioPayloads },
  ];
  await renderPng(barChart({
    width: 900,
    height: 500,
    title: 'Page-input tokens: Rendered DOM vs agent-browser',
    subtitle: `Hacker News + YC Blog  •  exact o200k_base  •  ${formatTokens(scenarioPayloads.rawDom.tokens)} → ${formatTokens(scenarioPayloads.linksText.tokens)} tokens  •  ${scenario.tokenReduction.linksText}× smaller`,
    series: [
      { name: 'Rendered DOM', color: INK.red },
      { name: 'Markdown', color: INK.green },
      { name: 'Markdown --links text', color: '#7dd3fc' },
    ],
    groups: tokenGroups.map((group) => ({
      label: group.label,
      sub: 'input payload only',
      values: [
        group.payloads.rawDom.tokens,
        group.payloads.defaultMarkdown.tokens,
        group.payloads.linksText.tokens,
      ],
      labels: [
        formatTokens(group.payloads.rawDom.tokens),
        formatTokens(group.payloads.defaultMarkdown.tokens),
        formatTokens(group.payloads.linksText.tokens),
      ],
      pill: `${ratio(group.payloads.rawDom.tokens, group.payloads.linksText.tokens)}x smaller`,
    })),
    note: 'Excludes prompts, retries, output',
    footer: 'Exact o200k_base tokens  •  details in benchmark-results.json',
    format: (v) => formatTokens(Math.round(v)),
  }), { width: 900, height: 500, out: join(root, 'token-cost-graph.png') });

  updateReadmeTable(pages);
  writeFileSync(join(root, 'benchmark-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log('  wrote benchmark-results.json and synchronized the README table');
}

main().catch((err) => {
  process.stderr.write(`make-charts: ${err.message}\n`);
  process.exitCode = 1;
});
