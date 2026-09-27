import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The experimental reader must never become part of the Sulai model. That is
// enforced here mechanically, because a rule written in prose does not stop a
// later change from quietly adding the import.
const packages = fileURLToPath(new URL('../../', import.meta.url));
const EXPERIMENTAL = '@sulai/experimental-claude-code';

async function sourceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('@sulai/core does not depend on the experimental reader', async () => {
  const manifest = JSON.parse(
    await readFile(join(packages, 'core', 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  assert.equal(Object.hasOwn(manifest.dependencies ?? {}, EXPERIMENTAL), false);
  for (const file of await sourceFiles(join(packages, 'core', 'src'))) {
    assert.equal(
      (await readFile(file, 'utf8')).includes('experimental'),
      false,
      `${file} references the experimental reader`,
    );
  }
});

test('the storage module does not import the experimental reader', async () => {
  const storage = await readFile(
    join(packages, 'cli', 'src', 'project.ts'),
    'utf8',
  );
  assert.equal(storage.includes(EXPERIMENTAL), false);
  assert.equal(storage.includes('./experimental'), false);
});
