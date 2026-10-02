// Packs the sulai command as one installable package, with its two workspace
// libraries bundled inside it, so `npm install -g <tarball>` needs nothing else.
// Run `npm run build` first. Prints the tarball's path. Publishes nothing.
//
// Usage: node scripts/pack.mjs [destination-folder]   (default: .tmp/pack)
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] ?? join(root, '.tmp', 'pack'));
const staging = join(destination, 'sulai');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const top = read('package.json');
const cli = read('packages/cli/package.json');
const libraries = ['core', 'experimental-claude-code'];

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// The command itself, at the top of the package.
cpSync(join(root, 'packages/cli/dist'), join(staging, 'dist'), {
  recursive: true,
});
for (const file of ['README.md', 'LICENSE', 'NOTICE']) {
  cpSync(join(root, file), join(staging, file));
}

// The libraries it imports, bundled where Node resolves them from the command.
const bundled = {};
for (const name of libraries) {
  const manifest = read(`packages/${name}/package.json`);
  const target = join(staging, 'node_modules', manifest.name);
  mkdirSync(target, { recursive: true });
  cpSync(join(root, `packages/${name}/dist`), join(target, 'dist'), {
    recursive: true,
  });
  // A bundled copy is not published on its own, so it carries no private flag.
  const published = { ...manifest };
  delete published.private;
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify(published, null, 2)}\n`,
  );
  bundled[manifest.name] = manifest.version;
}

const manifest = {
  name: 'sulai',
  version: top.version,
  description: top.description,
  license: top.license,
  repository: top.repository,
  homepage: top.homepage,
  bugs: top.bugs,
  type: 'module',
  bin: cli.bin,
  files: ['dist', 'README.md', 'LICENSE', 'NOTICE'],
  engines: { node: cli.engines.node },
  dependencies: bundled,
  bundleDependencies: Object.keys(bundled),
};
writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const output = run(
  'npm',
  ['pack', '--json', '--pack-destination', destination],
  {
    cwd: staging,
  },
);
const [packed] = JSON.parse(output);
process.stdout.write(`${join(destination, packed.filename)}\n`);
