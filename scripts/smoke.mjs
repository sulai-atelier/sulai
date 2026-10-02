// Installs the packed sulai into a fresh, isolated prefix, offline, and runs a
// first use through the installed command: help, init, orient, record from the
// draft, then an uncommitted change that orient must report. Run after
// `npm run build`; it packs first. Leaves nothing behind.
//
// Usage: node scripts/smoke.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const base = mkdtempSync(join(tmpdir(), 'sulai-smoke-'));
// Git and npm see nothing of the machine's own configuration, nor of this
// repository's: `npm run` passes its settings down as npm_* variables.
const config = join(base, 'gitconfig');
writeFileSync(config, '');
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)),
  ),
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Sulai Smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'Sulai Smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  npm_config_userconfig: join(base, 'npmrc'),
  npm_config_cache: join(base, 'npm-cache'),
};
const exec = (program, args, cwd = base) =>
  run(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  const tarball = execFileSync(
    process.execPath,
    [join(root, 'scripts', 'pack.mjs'), join(base, 'pack')],
    { encoding: 'utf8' },
  ).trim();
  const prefix = join(base, 'prefix');
  exec('npm', [
    'install',
    '--global',
    '--prefix',
    prefix,
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ]);
  const sulai = windows
    ? join(prefix, 'sulai.cmd')
    : join(prefix, 'bin', 'sulai');
  const json = (args) => JSON.parse(exec(sulai, args));

  assert.match(exec(sulai, ['--help']), /^Usage:/);

  const repo = join(base, 'project');
  exec('git', ['init', '-q', '--initial-branch=main', repo]);
  writeFileSync(join(repo, 'config.js'), "export const LIST_SORT = 'date';\n");
  exec('git', ['-C', repo, 'add', '-A']);
  exec('git', ['-C', repo, 'commit', '-q', '-m', 'first']);

  assert.equal(json(['init', repo]).created, true);
  assert.equal(json(['orient', repo]).draft.state, 'ready');
  writeFileSync(
    join(repo, '.sulai', 'draft.md'),
    'Lists sort by date. `r1/config.js#L1`\n',
  );
  const recorded = json(['record', repo]);
  assert.equal(recorded.references.resolved, 1);

  // Changed by someone else, and not committed.
  writeFileSync(join(repo, 'config.js'), "export const LIST_SORT = 'title';\n");
  const oriented = json(['orient', repo]);
  assert.deepEqual(
    oriented.heads[0].changed.map((item) => item.locator),
    ['r1/config.js#L1'],
  );
  assert.equal(
    readFileSync(join(repo, '.sulai', 'draft.md'), 'utf8'),
    'Lists sort by date. `r1/config.js#L1`\n',
  );
  process.stdout.write(`smoke: ${tarball} installs and runs\n`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
