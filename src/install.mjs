/**
 * `agent-browser install` — wire @truenix/agent-browser into a DSH profile automatically.
 * Intended for `npx -y @truenix/agent-browser install` when the user *means* DSH.
 * Never runs on plain `npm install`; only when explicitly invoked.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const PACKAGE = '@truenix/agent-browser';

/**
 * Pin a newly wired profile to the major THIS copy belongs to. It was hardcoded
 * to '^1.0.0', which would have quietly installed the previous major the moment
 * a 2.x installer ran.
 */
const VERSION_RANGE = (() => {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return `^${version}`;
  } catch { return '*'; }
})();

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

  // The mount now comes from the package's own cordis.patch.yml (dsh.bundle
  // layer), so NO manual insert goes into the profile file. A legacy manual
  // mount left by older installers would double-mount id `agent-browser`
  // ("duplicate prefix route") — strip it as a migration.
  const legacy = /- insert:\s*\n\s+- id: agent-browser[\s\S]*?timeoutMs:.*\n/m;
  if (legacy.test(raw)) {
    const next = raw.replace(legacy, '');
    writeFileSync(cordisPatchPath, next);
    return { changed: true, raw: next };
  }
  return { changed: false, raw };
}

/**
 * Add the dependency and the bundle entry to a parsed profile package.json.
 * Pure (mutates and reports), so the wiring rules are testable without touching
 * a disk or invoking a package manager.
 *
 * The dependency and the bundle entry are INDEPENDENT, and it is the BUNDLE
 * entry that actually loads the tools. A profile routinely carries one without
 * the other — a hand-added dep, or an install interrupted halfway — so each is
 * checked and repaired on its own. Keying the whole decision off the dependency
 * used to print "already installed" over a profile whose tools were never
 * wired: a silent failure behind a success message.
 *
 * @param {object} pkg parsed package.json, mutated in place
 */
export function addToPackageJson(pkg) {
  pkg.dependencies ||= {};
  const addedDependency = !pkg.dependencies[PACKAGE];
  if (addedDependency) pkg.dependencies[PACKAGE] = VERSION_RANGE;

  pkg.dsh ||= {};
  pkg.dsh.profile ||= {};
  pkg.dsh.profile.bundles ||= ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  const addedBundle = !pkg.dsh.profile.bundles.includes(PACKAGE);
  // Third-party bundles go after the core ones so their patches merge last.
  if (addedBundle) pkg.dsh.profile.bundles.push(PACKAGE);

  return { changed: addedDependency || addedBundle, addedDependency, addedBundle };
}

/**
 * Remove the dependency and the bundle entry from a parsed profile package.json.
 * Mirrors addToPackageJson, and assumes NEITHER `dsh` nor `dsh.profile` exists —
 * reaching straight through `pkg.dsh.profile` threw a TypeError on any profile
 * that carried the dependency but no dsh block.
 *
 * @param {object} pkg parsed package.json, mutated in place
 */
export function removeFromPackageJson(pkg) {
  let changed = false;
  if (pkg.dependencies?.[PACKAGE]) {
    delete pkg.dependencies[PACKAGE];
    changed = true;
  }
  const bundles = pkg.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes(PACKAGE)) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PACKAGE);
    changed = true;
  }
  return { changed };
}

function ensurePackageJson(profile) {
  const pkgPath = join(profile, 'package.json');
  if (!existsSync(pkgPath)) return { changed: false };
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const result = addToPackageJson(pkg);
  if (!result.changed) return { changed: false };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  return { ...result, pkg };
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

export function uninstall({ profile = 'web' } = {}) {
  const dir = profileDir(profile);
  const patchPath = join(dir, 'cordis.patch.yml');
  if (existsSync(patchPath)) {
    const raw = readFileSync(patchPath, 'utf8');
    // Remove a legacy manual insert block, if an older installer left one.
    const next = raw.replace(/- insert:\s*\n\s+- id: agent-browser[\s\S]*?timeoutMs:.*\n/m, '');
    if (next !== raw) {
      writeFileSync(patchPath, next);
      console.log(`[agent-browser] removed from ${patchPath}`);
    }
  }

  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!removeFromPackageJson(pkg).changed) return;

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[agent-browser] removed from ${pkgPath}`);
  const cmd = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm install --prod' : 'npm install --prod';
  try { execSync(cmd, { cwd: dir, stdio: 'inherit' }); }
  catch (e) { console.warn(`[agent-browser] ${cmd} failed — run it manually in ${dir}: ${e.message}`); }
}
