/**
 * `agent-browser install` — wire @truenix/agent-browser into a DSH profile automatically.
 * Intended for `npx -y @truenix/agent-browser install` when the user *means* DSH.
 * Never runs on plain `npm install`; only when explicitly invoked.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function profileDir(name = 'web') {
  return join(dshHome(), 'profiles', name);
}

function ensurePatch(cordisPatchPath) {
  let raw = existsSync(cordisPatchPath) ? readFileSync(cordisPatchPath, 'utf8') : '';
  // If file doesn't end with newline, normalize
  if (raw && !raw.endsWith('\n')) raw += '\n';

  // Idempotent: if already has agent-browser, skip
  if (raw.includes('agent-browser')) return { changed: false, raw };

  const snippet = `- insert:
  - id: agent-browser
    name: '@truenix/agent-browser/cordis'
    config:
      timeoutMs: 180000
`;
  // Preserve header comment if exists
  const next = raw + (raw.endsWith('\n\n') || raw === '' ? '' : '\n') + snippet;
  writeFileSync(cordisPatchPath, next);
  return { changed: true, raw: next };
}

function ensurePackageJson(profile) {
  const pkgPath = join(profile, 'package.json');
  if (!existsSync(pkgPath)) return { changed: false };
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.dependencies ||= {};
  if (pkg.dependencies['@truenix/agent-browser']) return { changed: false };
  pkg.dependencies['@truenix/agent-browser'] = '^1.0.0';
  pkg.dsh ||= {};
  pkg.dsh.profile ||= {};
  pkg.dsh.profile.bundles ||= ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  if (!pkg.dsh.profile.bundles.includes('@truenix/agent-browser')) {
    // keep third-party bundles after core bundles but before theme — insert before last if theme exists
    pkg.dsh.profile.bundles.push('@truenix/agent-browser');
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  return { changed: true, pkg };
}

export function install({ profile = 'web', yes = false, dryRun = false } = {}) {
  const dir = profileDir(profile);
  if (!existsSync(dir)) {
    throw new Error(`DSH profile not found at ${dir} (DSH_HOME=${dshHome()})`);
  }
  const patchPath = join(dir, 'cordis.patch.yml');
  const pkgPath = join(dir, 'package.json');

  if (dryRun) {
    let raw = '';
    try { raw = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '(missing)'; }
    catch (e) { return { dryRun: true, patchPath, pkgPath, error: e.message, wouldPatch: true }; }
    return { dryRun: true, patchPath, pkgPath, wouldPatch: !raw.includes('agent-browser') };
  }

  // 1. patch cordis
  const patch = ensurePatch(patchPath);
  // 2. patch package.json
  const pkg = ensurePackageJson(dir);

  // 3. install deps (pnpm if lock exists, else npm)
  let installed = false;
  if (patch.changed || pkg.changed) {
    if (!yes) console.log(`[agent-browser] patched ${patchPath}${pkg.changed ? ' + package.json' : ''}`);
    const hasPnpm = existsSync(join(dir, 'pnpm-lock.yaml'));
    const cmd = hasPnpm ? 'pnpm install --prod' : 'npm install --prod';
    try {
      execSync(cmd, { cwd: dir, stdio: 'inherit' });
      installed = true;
    } catch (e) {
      console.warn(`[agent-browser] ${cmd} failed — run it manually in ${dir}: ${e.message}`);
    }
  } else {
    console.log('[agent-browser] already installed in DSH profile');
  }

  return { profile: dir, patchChanged: patch.changed, pkgChanged: pkg.changed, installed };
}

export function uninstall({ profile = 'web', yes = false } = {}) {
  const dir = profileDir(profile);
  const patchPath = join(dir, 'cordis.patch.yml');
  if (existsSync(patchPath)) {
    let raw = readFileSync(patchPath, 'utf8');
    // Remove the - insert block that contains agent-browser
    const next = raw.replace(/- insert:\s*\n\s+- id: agent-browser[\s\S]*?timeoutMs:.*\n/m, '');
    if (next !== raw) writeFileSync(patchPath, next);
    console.log(`[agent-browser] removed from ${patchPath}`);
  }
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.dependencies?.['@truenix/agent-browser']) {
      delete pkg.dependencies['@truenix/agent-browser'];
      pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles || []).filter(b => b !== '@truenix/agent-browser');
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`[agent-browser] removed from ${pkgPath}`);
      try { execSync(existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm install --prod' : 'npm install --prod', { cwd: dir, stdio: 'inherit' }); } catch {}
    }
  }
}
