// Runs a program without a shell, for the scripts beside this one.
import { execFileSync } from 'node:child_process';
import process from 'node:process';

/**
 * npm runs through the npm that started the calling script, when there is one.
 * A Windows `.cmd` shim runs through `cmd`, with every argument quoted, since
 * it cannot be started directly. Anything else runs as it is.
 */
export function run(program, args, options = {}) {
  const settings = { encoding: 'utf8', ...options };
  if (program === 'npm' && process.env.npm_execpath) {
    return execFileSync(
      process.execPath,
      [process.env.npm_execpath, ...args],
      settings,
    );
  }
  const name =
    program === 'npm' && process.platform === 'win32' ? 'npm.cmd' : program;
  if (process.platform === 'win32' && /\.cmd$/i.test(name)) {
    const line = [name, ...args].map((arg) => `"${arg}"`).join(' ');
    return execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `"${line}"`],
      { ...settings, windowsVerbatimArguments: true },
    );
  }
  return execFileSync(name, args, settings);
}
