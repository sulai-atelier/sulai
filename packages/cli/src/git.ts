/**
 * Reading one commit from a Git repository (ADR 0009), and listing what a
 * working tree holds (ADR 0012). Sulai runs `git`, but relies on none of the
 * user's configuration for what must not happen: nothing is fetched, no
 * replacement object is read, nothing is written, and no hook, filter, pager
 * or fsmonitor program runs. Only plumbing and `status` run.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  GIT_OBJECT_FORMATS,
  MAX_OCCURRENCE_BYTES,
  ValidationError,
} from '@sulai/core';
import type { GitObjectFormat } from '@sulai/core';
import {
  assertUnchangedSize,
  hasCode,
  openRegularFile,
  readChunks,
} from './store.js';

/**
 * Variables that would point Git at another repository, index, object store or
 * configuration file than the one named.
 */
const REDIRECTING_VARIABLES = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

/**
 * Git can write trace output to any file or socket. Inherited trace and, on
 * Windows, output-redirecting variables are removed. Trace2 can also be sent
 * somewhere by system or global configuration, which `-c` does not override
 * because Git reads it first; its own variables set to 0 do.
 */
const WRITING_PREFIXES = ['GIT_TRACE', 'GIT_REDIRECT_'];

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (REDIRECTING_VARIABLES.has(upper)) continue;
    if (WRITING_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    env[name] = value;
  }
  return {
    ...env,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE2: '0',
    GIT_TRACE2_EVENT: '0',
    GIT_TRACE2_PERF: '0',
  };
}

/** Set on every command, so no configuration can turn these back on. */
const GLOBAL_OPTIONS = [
  '--no-pager',
  '--no-lazy-fetch',
  '--no-replace-objects',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
];

/**
 * The `git` executable on PATH. Windows looks for a bare program name in the
 * current folder first, and that may be the repository being read, so there the
 * path is found from PATH alone.
 */
async function findGit(): Promise<string> {
  if (process.platform !== 'win32') return 'git';
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const folder = entry.replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(folder)) continue;
    const candidate = join(folder, 'git.exe');
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not in this folder; keep looking.
    }
  }
  throw new ValidationError('Git acquisition needs git on PATH');
}

interface Result {
  readonly code: number;
  readonly stdout: Buffer;
}

interface RunOptions {
  /** Exit statuses that are answers rather than failures. */
  readonly allowed?: readonly number[];
  /** What to say when the output passes the bound on what is held. */
  readonly tooLarge?: string;
}

function execute(
  program: string,
  args: readonly string[],
  {
    allowed = [0],
    tooLarge = `git printed more than ${MAX_OCCURRENCE_BYTES} bytes`,
  }: RunOptions = {},
): Promise<Result> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      program,
      [...GLOBAL_OPTIONS, ...args],
      {
        env: environment(),
        encoding: 'buffer',
        maxBuffer: MAX_OCCURRENCE_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : error.code;
        if (typeof code === 'number' && allowed.includes(code)) {
          resolvePromise({ code, stdout });
          return;
        }
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new ValidationError(tooLarge));
          return;
        }
        const detail = stderr.toString('utf8').trim() || error?.message;
        reject(new ValidationError(`git failed: ${detail}`, { cause: error }));
      },
    );
  });
}

let checked: Promise<string> | undefined;

/**
 * Finds `git` and checks, once, that it supports the switches above. An older
 * Git would silently ignore their environment variables, so it is refused.
 */
function git(): Promise<string> {
  checked ??= (async () => {
    const program = await findGit();
    try {
      await execute(program, ['version']);
    } catch (error) {
      checked = undefined;
      throw new ValidationError(
        hasCode(error instanceof Error ? error.cause : null, 'ENOENT')
          ? 'Git acquisition needs git on PATH'
          : 'Git acquisition needs git 2.45 or later, which can refuse to fetch missing objects',
        { cause: error },
      );
    }
    return program;
  })();
  return checked;
}

async function run(
  args: readonly string[],
  options?: RunOptions,
): Promise<Result> {
  return execute(await git(), args, options);
}

const lines = (bytes: Buffer) => bytes.toString('utf8').trimEnd().split('\n');

function objectFormat(value: string | undefined): GitObjectFormat {
  const format = GIT_OBJECT_FORMATS.find((known) => known === value);
  if (format === undefined) {
    throw new ValidationError(`Git reports an unknown object format: ${value}`);
  }
  return format;
}

/** One commit of one repository, found from where the caller named it. */
export interface GitCommit {
  /** The repository as named, made absolute. Where it was, not what it is. */
  readonly locator: string;
  /** The real path of the working tree, or of the repository when bare. */
  readonly folder: string;
  /** The real path of the shared Git directory, which identifies the repository. */
  readonly repository: string;
  readonly bare: boolean;
  readonly objectFormat: GitObjectFormat;
  readonly commit: string;
  readonly tree: string;
}

async function head(folder: string): Promise<string | null> {
  const { code, stdout } = await run(
    ['-C', folder, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    { allowed: [0, 1] },
  );
  return code === 0 ? (lines(stdout)[0] as string) : null;
}

/**
 * Where a named path is as a repository: its working folder, or the repository
 * itself when bare, and its shared Git directory. The path must be one of those
 * exactly: part of a repository, or its `.git` directory, is refused.
 */
async function locate(locator: string) {
  // A missing or too old git is its own refusal, not a fault of the folder.
  await git();
  let facts: Result;
  try {
    facts = await run([
      '-C',
      locator,
      'rev-parse',
      '--is-bare-repository',
      '--is-inside-work-tree',
      '--path-format=absolute',
      '--git-common-dir',
      '--show-object-format',
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ValidationError(
      `Cannot read ${locator} as a Git repository: ${reason}`,
      { cause: error },
    );
  }
  const [bare, inWorkTree, common, format] = lines(facts.stdout);
  const named = await realpath(locator);
  let folder: string;
  if (bare === 'true') {
    folder = await realpath(common as string);
    if (folder !== named) {
      throw new ValidationError(
        `${locator} is inside the bare repository ${folder}; name the repository itself`,
      );
    }
  } else if (inWorkTree === 'true') {
    const top = lines(
      (await run(['-C', locator, 'rev-parse', '--show-toplevel'])).stdout,
    )[0] as string;
    folder = await realpath(top);
    if (folder !== named) {
      throw new ValidationError(
        `${locator} is inside the repository ${folder}; name its top-level folder, because capturing part of a repository is not supported`,
      );
    }
  } else {
    throw new ValidationError(
      `${locator} is a repository's Git directory; name its working folder`,
    );
  }
  return {
    folder,
    repository: await realpath(common as string),
    bare: bare === 'true',
    objectFormat: objectFormat(format),
  };
}

async function treeOf(folder: string, commit: string): Promise<string> {
  return lines(
    (await run(['-C', folder, 'rev-parse', '--verify', `${commit}^{tree}`]))
      .stdout,
  )[0] as string;
}

/**
 * Resolves HEAD, once, to the full ID of the commit it names. The path must be
 * a repository's top-level working folder, or a bare repository itself:
 * capturing part of a repository is not supported.
 */
export async function openCommit(input: string): Promise<GitCommit> {
  const locator = resolve(input);
  const { folder, repository, bare, objectFormat } = await locate(locator);
  const commit = await head(folder);
  if (commit === null) {
    throw new ValidationError(
      `${locator} has no commit to capture: HEAD names no commit yet`,
    );
  }
  return {
    locator,
    folder,
    repository,
    bare,
    objectFormat,
    commit,
    tree: await treeOf(folder, commit),
  };
}

/** A repository's working tree, found from where the caller named it. */
export interface GitWorktree {
  /** The repository as named, made absolute. Where it was, not what it is. */
  readonly locator: string;
  /** The real path of the top-level working folder. */
  readonly folder: string;
  /** The real path of the shared Git directory, which identifies the repository. */
  readonly repository: string;
  readonly objectFormat: GitObjectFormat;
  /** The commit HEAD names, or null before the first commit. */
  readonly head: string | null;
  readonly tree: string | null;
}

/**
 * Finds a working tree and what HEAD names now (ADR 0012). The path must be
 * the top-level working folder; a bare repository has no working tree.
 */
export async function openWorktree(input: string): Promise<GitWorktree> {
  const locator = resolve(input);
  const { folder, repository, bare, objectFormat } = await locate(locator);
  if (bare) {
    throw new ValidationError(
      `${locator} is a bare repository, which has no working tree; read its commit with --git`,
    );
  }
  const commit = await head(folder);
  return {
    locator,
    folder,
    repository,
    objectFormat,
    head: commit,
    tree: commit === null ? null : await treeOf(folder, commit),
  };
}

/** What Git selects in a working tree, as it names the paths. */
export interface WorktreeListing {
  /** Index entries, one per path: mode, object ID, and the path's bytes. */
  readonly tracked: readonly {
    readonly mode: string;
    readonly id: string;
    readonly path: Buffer;
  }[];
  /**
   * Untracked paths Git does not ignore, by its standard rules. A repository
   * nested in untracked files is named once, with a trailing `/`.
   */
  readonly untracked: readonly Buffer[];
}

/** Splits `-z` output into its fields, keeping each one's bytes. */
function fields(output: Buffer): Buffer[] {
  const items: Buffer[] = [];
  for (let start = 0; start < output.length;) {
    const end = output.indexOf(0, start);
    items.push(output.subarray(start, end === -1 ? output.length : end));
    start = end === -1 ? output.length : end + 1;
  }
  return items;
}

/**
 * Lists the paths a working-tree root holds: every index entry, and every
 * untracked path Git does not ignore. Only `ls-files` runs. It reads the index
 * and walks the folder with Git's ignore rules, reads no file's content, runs
 * no filter, and writes nothing. Ignored files are never listed.
 */
export async function listWorktree(
  worktree: GitWorktree,
): Promise<WorktreeListing> {
  const tooLarge = 'The working tree is too large to record as one occurrence';
  const staged = await run(
    ['-C', worktree.folder, 'ls-files', '-z', '--stage'],
    { tooLarge },
  );
  const tracked = [];
  const seen = new Set<string>();
  for (const item of fields(staged.stdout)) {
    const tab = item.indexOf(0x09);
    const [mode, id] =
      tab === -1 ? [] : item.subarray(0, tab).toString('latin1').split(' ');
    if (id === undefined) {
      throw new ValidationError('git ls-files printed an unexpected line');
    }
    const path = item.subarray(tab + 1);
    // A conflicted path has an entry per stage; the working tree has one file.
    const key = path.toString('latin1');
    if (seen.has(key)) continue;
    seen.add(key);
    tracked.push({ mode: mode as string, id, path });
  }
  const others = await run(
    ['-C', worktree.folder, 'ls-files', '-z', '--others', '--exclude-standard'],
    { tooLarge },
  );
  return { tracked, untracked: fields(others.stdout) };
}

/**
 * Filter drivers can run a program when `status` rehashes a file whose cached
 * details are stale, and Git LFS's also writes to the repository. Every one
 * configured is turned off for the check, so no filter runs.
 */
async function withoutFilters(folder: string): Promise<string[]> {
  const { stdout } = await run(
    [
      '-C',
      folder,
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^filter\\.',
    ],
    { allowed: [0, 1] },
  );
  const drivers = new Set(
    stdout
      .toString('utf8')
      .split('\0')
      .filter((name) => name.includes('.', 'filter.'.length))
      .map((name) => name.slice('filter.'.length, name.lastIndexOf('.'))),
  );
  const options = [];
  for (const driver of drivers) {
    if (driver.includes('=')) {
      throw new ValidationError(
        `The filter driver "${driver}" cannot be turned off, so the working tree is not checked`,
      );
    }
    for (const key of ['clean', 'smudge', 'process']) {
      options.push('-c', `filter.${driver}.${key}=`);
    }
    options.push('-c', `filter.${driver}.required=false`);
  }
  return options;
}

/**
 * The paths where the working tree differs from HEAD: staged changes, changed
 * tracked files, and untracked files that are not ignored. An untracked folder
 * is reported whole, not file by file, so Git never lists everything in one.
 * Untracked paths under `ignoreUntracked` are left out; that is the project's
 * own store, when it lies inside the working tree. A submodule counts when it
 * has a different commit checked out; its own files are another repository's,
 * and not read.
 *
 * No filter runs, so a file whose working copy a filter transforms, such as one
 * Git LFS has smudged, counts as changed once its cached details are stale,
 * where Git would run the filter and call it clean.
 */
export async function worktreeChanges(
  commit: GitCommit,
  ignoreUntracked: string | null,
): Promise<string[]> {
  const { stdout } = await run(
    [
      ...(await withoutFilters(commit.folder)),
      '-C',
      commit.folder,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--ignore-submodules=dirty',
      '--no-renames',
    ],
    { tooLarge: 'The working tree has more changes than Sulai can list' },
  );
  const fields = stdout.toString('utf8').split('\0');
  const changed: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as string;
    if (field === '') continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(code)) index += 1;
    const ignored =
      code === '??' &&
      ignoreUntracked !== null &&
      (path === ignoreUntracked || path.startsWith(`${ignoreUntracked}/`));
    if (!ignored) changed.push(path);
  }
  if ((await head(commit.folder)) !== commit.commit) {
    throw new ValidationError(
      `HEAD in ${commit.locator} moved while its working tree was checked; nothing was recorded`,
    );
  }
  return changed;
}

export interface TreeItem {
  readonly mode: string;
  readonly type: string;
  readonly id: string;
  /** Exactly as the tree holds it, which need not be UTF-8. */
  readonly path: Buffer;
}

/** Every path in the commit's tree, submodules included but not entered. */
export async function listTree(commit: GitCommit): Promise<TreeItem[]> {
  const { stdout } = await run(
    ['-C', commit.folder, 'ls-tree', '-r', '-z', '--full-tree', commit.tree],
    { tooLarge: 'The commit is too large to record as one occurrence' },
  );
  const items: TreeItem[] = [];
  for (let start = 0; start < stdout.length;) {
    const end = stdout.indexOf(0, start);
    const item = stdout.subarray(start, end === -1 ? stdout.length : end);
    start = end === -1 ? stdout.length : end + 1;
    const tab = item.indexOf(0x09);
    const [mode, type, id] =
      tab === -1 ? [] : item.subarray(0, tab).toString('latin1').split(' ');
    if (id === undefined) {
      throw new ValidationError('git ls-tree printed an unexpected line');
    }
    items.push({
      mode: mode as string,
      type: type as string,
      id,
      path: item.subarray(tab + 1),
    });
  }
  return items;
}

/** Hashes bytes as Git names a blob: its header, then its content. */
export function blobHash(format: GitObjectFormat, size: number): Hash {
  return createHash(format).update(`blob ${size}\0`);
}

/** Recomputes a preserved artifact's blob ID, with no repository. */
export async function blobIdOf(
  path: string,
  format: GitObjectFormat,
): Promise<string> {
  const handle = await openRegularFile(path);
  try {
    const expected = (await handle.stat()).size;
    const hash = blobHash(format, expected);
    let size = 0;
    for await (const chunk of readChunks(handle, expected)) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    assertUnchangedSize(size, expected);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Reads a stream by lines and by exact byte counts. It holds at most a short
 * line and one chunk of the stream, whatever the size of a blob.
 */
class StreamReader {
  #buffered: Buffer = Buffer.alloc(0);
  readonly #source: AsyncIterator<Buffer>;

  constructor(stream: Readable) {
    this.#source = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async #fill(): Promise<boolean> {
    const next = await this.#source.next();
    if (next.done === true) return false;
    this.#buffered =
      this.#buffered.length === 0
        ? next.value
        : Buffer.concat([this.#buffered, next.value]);
    return true;
  }

  /** The next line without its LF, or null when the stream has ended. */
  async line(): Promise<string | null> {
    for (;;) {
      const end = this.#buffered.indexOf(0x0a);
      if (end !== -1) {
        const line = this.#buffered.subarray(0, end).toString('utf8');
        this.#buffered = this.#buffered.subarray(end + 1);
        return line;
      }
      if (this.#buffered.length > 1024) {
        throw new ValidationError('git cat-file printed an unexpected line');
      }
      if (!(await this.#fill())) return null;
    }
  }

  /** Exactly `count` bytes, in the chunks they arrive in. */
  async *bytes(count: number): AsyncGenerator<Buffer> {
    let remaining = count;
    while (remaining > 0) {
      if (this.#buffered.length === 0 && !(await this.#fill())) {
        throw new ValidationError(
          'git cat-file stopped in the middle of a blob',
        );
      }
      const chunk = this.#buffered.subarray(
        0,
        Math.min(remaining, this.#buffered.length),
      );
      this.#buffered = this.#buffered.subarray(chunk.length);
      remaining -= chunk.length;
      yield chunk;
    }
  }
}

export interface Blob {
  readonly id: string;
  readonly size: number;
  /**
   * The blob's bytes. Reading past the last one checks them against the blob
   * ID and throws if they differ, so whatever consumed them must be discarded.
   */
  readonly chunks: AsyncIterable<Uint8Array>;
}

/**
 * Streams the named blobs, in order, out of one `git cat-file --batch`. Each
 * blob must be read to its end before the next is asked for. A blob that is
 * missing, as in a partial clone, is refused: Sulai never fetches it.
 */
export async function* readBlobs(
  commit: GitCommit,
  ids: readonly string[],
): AsyncGenerator<Blob> {
  const child = spawn(
    await git(),
    [...GLOBAL_OPTIONS, '-C', commit.folder, 'cat-file', '--batch'],
    { env: environment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    if (stderr.length < 4096) stderr += text;
  });
  const closed = new Promise<void>((resolveClose) => {
    child.on('close', () => resolveClose());
  });
  const failed = new Promise<never>((_, reject) => {
    child.on('error', reject);
  });
  failed.catch(() => {});
  // If Git stops early, its exit and stderr say why; a failed write does not.
  child.stdin.on('error', () => {});
  child.stdin.end(ids.map((id) => `${id}\n`).join(''));
  const reader = new StreamReader(child.stdout);
  try {
    for (const id of ids) {
      const header = await Promise.race([reader.line(), failed]);
      if (header === null) {
        throw new ValidationError(
          `git cat-file stopped before ${id}: ${stderr.trim()}`,
        );
      }
      const [named, type, size] = header.split(' ');
      if (named === id && type === 'missing') {
        throw new ValidationError(
          `Blob ${id} is not in ${commit.locator}. A partial clone may lack it, and Sulai never fetches; nothing was recorded.`,
        );
      }
      const length = Number(size);
      if (
        named !== id ||
        type !== 'blob' ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        throw new ValidationError(`git cat-file described ${id} as ${header}`);
      }
      const hash = blobHash(commit.objectFormat, length);
      let finished = false;
      yield {
        id,
        size: length,
        chunks: (async function* () {
          for await (const chunk of reader.bytes(length)) {
            hash.update(chunk);
            yield chunk;
          }
          finished = true;
          if (hash.digest('hex') !== id) {
            throw new ValidationError(
              `The bytes Git gave for blob ${id} have a different blob ID; nothing was recorded`,
            );
          }
        })(),
      };
      if (!finished) {
        throw new ValidationError(`Blob ${id} was not read to its end`);
      }
      const terminator = await reader.line();
      if (terminator !== '') {
        throw new ValidationError('git cat-file printed an unexpected line');
      }
    }
  } finally {
    child.kill();
    await Promise.race([closed, failed.catch(() => {})]);
  }
}
