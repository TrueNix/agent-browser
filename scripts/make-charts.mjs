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
 * It renders with agent-browser itself. No chart library, no headless-browser
 * dependency, nothing added to the package: the tool draws its own benchmarks.
 *
 * Dev tooling — `scripts/` is not in package.json "files", so it never ships.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withBrowser } from '../src/client.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const HEAVY_SITES = [
  { url: 'https://en.wikipedia.org/wiki/WebAssembly', label: 'Wikipedia\nWebAssembly' },
  { url: 'https://react.dev', label: 'react.dev' },
  { url: 'https://nextjs.org', label: 'nextjs.org' },
  { url: 'https://github.com/trending', label: 'github.com\n/trending' },
  { url: 'https://apple.com', label: 'apple.com' },
];

/** The two pages behind the "one YC check" cost scenario. */
const COST_PAGES = ['https://news.ycombinator.com', 'https://www.ycombinator.com/blog'];

/**
 * Anthropic rates from the claude-api skill's model table (cached 2026-06-24).
 * OpenAI rates are carried over from the previous chart unverified — they are
 * the comparison column, not a claim this project measured.
 */
const MODELS = [
  { name: 'Haiku 4.5', input: 1.00, output: 5.00 },
  { name: 'Sonnet 5', input: 3.00, output: 15.00 },
  { name: 'Opus 5', input: 5.00, output: 25.00 },
  { name: 'GPT-4o', input: 2.50, output: 10.00 },
  { name: 'GPT-4o mini', input: 0.15, output: 0.60 },
];

const OUTPUT_TOKENS = 500;
const CHARS_PER_TOKEN = 4;

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

const kb = (chars) => (chars >= 10000 ? `${Math.round(chars / 1000)}k` : `${(chars / 1000).toFixed(1)}k`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
      // instead. (GPT-4o mini costs a fraction of a cent and hits this.)
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
  console.log('measuring heavy sites...');
  const heavy = await withBrowser({}, async (session) => {
    const rows = [];
    for (const site of HEAVY_SITES) {
      await session.navigate(site.url, { timeoutMs: 45000 });
      const html = (await session.html()).length;
      const md = (await session.markdown()).length;
      const text = (await session.markdown({ links: 'text' })).length;
      console.log(`  ${site.url.padEnd(42)} html ${kb(html).padStart(6)}  md ${kb(md).padStart(6)}  text ${kb(text).padStart(6)}`);
      rows.push({ ...site, html, md, text });
    }
    return rows;
  });

  console.log('measuring the cost scenario...');
  const cost = await withBrowser({}, async (session) => {
    let html = 0;
    let md = 0;
    for (const url of COST_PAGES) {
      await session.navigate(url, { timeoutMs: 45000 });
      html += (await session.html()).length;
      md += (await session.markdown({ links: 'text' })).length;
    }
    return { html, md };
  });
  const rawIn = Math.round(cost.html / CHARS_PER_TOKEN);
  const leanIn = Math.round(cost.md / CHARS_PER_TOKEN);
  console.log(`  raw ${kb(cost.html)} chars -> ${rawIn} tok | agent-browser ${kb(cost.md)} chars -> ${leanIn} tok`);

  console.log('rendering...');
  await renderPng(barChart({
    width: 900,
    height: 480,
    title: 'Heavy sites: Raw HTML vs agent-browser',
    subtitle: 'Measured live  •  node src/cli.mjs html|markdown <url>  •  wc -c',
    series: [
      { name: 'Raw HTML', color: INK.red },
      { name: 'agent-browser markdown', color: INK.green },
      { name: 'markdown --links text', color: '#7dd3fc' },
    ],
    groups: heavy.map((r) => ({
      label: r.label,
      sub: `${kb(r.md)} md  •  ${kb(r.text)} lean`,
      values: [r.html, r.md, r.text],
      labels: [kb(r.html), kb(r.md), kb(r.text)],
      pill: `${(r.html / r.md).toFixed(1)}x / ${(r.html / r.text).toFixed(1)}x`,
    })),
    footer: 'github.com/TrueNix/agent-browser',
    format: (v) => `${Math.round(v / 1000)}kB`,
  }), { width: 900, height: 480, out: join(root, 'heavy-benchmark.png') });

  const money = (m, inTok) => (inTok / 1e6) * m.input + (OUTPUT_TOKENS / 1e6) * m.output;
  await renderPng(barChart({
    width: 900,
    height: 500,
    title: 'Token Cost: Raw HTML vs agent-browser',
    subtitle: `HN + YC Blog, one check  •  markdown --links text  •  ${(rawIn / 1000).toFixed(1)}k → ${(leanIn / 1000).toFixed(1)}k tokens  •  ${(rawIn / leanIn).toFixed(1)}× smaller payload`,
    series: [
      { name: `Raw HTML (${(rawIn / 1000).toFixed(1)}k in)`, color: INK.red },
      { name: `agent-browser (${(leanIn / 1000).toFixed(1)}k in)`, color: INK.green },
    ],
    groups: MODELS.map((m) => {
      const raw = money(m, rawIn);
      const lean = money(m, leanIn);
      return {
        label: m.name,
        sub: `$${m.input}/$${m.output}`,
        values: [raw, lean],
        labels: [`$${raw.toFixed(3)}`, `$${lean.toFixed(3)}`],
        pill: `-${Math.round((1 - lean / raw) * 100)}%`,
      };
    }),
    note: `+${OUTPUT_TOKENS} out tokens`,
    footer: 'Anthropic claude.com/pricing • OpenAI openai.com/api/pricing • Aug 2026',
    format: (v) => `$${v.toFixed(3)}`,
  }), { width: 900, height: 500, out: join(root, 'token-cost-graph.png') });
}

main().catch((err) => {
  process.stderr.write(`make-charts: ${err.message}\n`);
  process.exitCode = 1;
});
