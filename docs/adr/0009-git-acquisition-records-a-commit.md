# ADR 0009: A Git acquisition records a commit, not a working folder

Status: Accepted. Adds occurrence version 2 and state revision version 2, and raises the storage
format to version 5. Narrows one rule of
[ADR 0005](0005-import-occurrences-record-acquisition-events.md); see "Artifacts stay source-neutral".
Corrected during implementation, in "How Git is run" and "Uncommitted work".

## Context

Acquisition walks filesystem paths. An occurrence root is an absolute path, and every entry carries
the file's modification time. For a Git project this is the wrong object:

- **It captures too much.** Walking a working folder copies dependencies, build output and `.git`.
  On Sulai's own development it read 257 MB to keep 0.47 MB of tracked files.
- **It records the wrong thing.** Nothing says which commit the files came from.
- **The workaround misstates the record.** Exporting HEAD with `git archive` into a folder and
  importing that gives roughly the right files, but the record names a temporary folder, loses the
  commit, and can differ from the commit itself, because `export-ignore` and `export-subst`
  attributes change an archive.

A Git acquisition makes a different claim: **Sulai read the contents one commit represents, from a
repository, rather than the files in a folder.** Occurrence version 1 cannot say that honestly. Its
roots are filesystem paths, and its entries carry modification times that a Git blob does not have.

## Decision

### What a Git acquisition captures

- **One commit.** The named revision, HEAD for now, is resolved once to its full commit ID, and
  everything is read from that commit. A branch name or `HEAD` is how the commit was found, never
  its identity.
- **The commit's tree, through Git's plumbing** (`ls-tree` and `cat-file`), never through
  `git archive` or a checkout. No attributes, filters, end-of-line conversion or LFS smudging are
  applied: the preserved bytes are the blob bytes.
- **Every tracked path in that tree, as committed.** Untracked and ignored files contribute nothing,
  however large. There is no live-store exclusion: a folder walk excludes the project's own store
  because the walk would read the store as it changes, but a commit is immutable, so a tracked path
  under `.sulai/` is preserved like any other.
- **A bare repository works too,** because the source is the object database.
- **A repository with no commit yet** is refused with a result saying no commit exists. An empty
  working folder is not a commit.

### Identity and verification

- **The root records** the repository's object format (`sha1` or `sha256`), the commit ID, and the
  commit's tree ID. The repository's path is recorded as where Sulai observed it; it is not
  identity. Remote URLs are not recorded.
- **Each captured entry records** its path, its mode (`100644`, `100755` or `120000`), its blob ID,
  and the artifact its bytes became.
- **Each blob is verified while it is read.** Sulai streams the blob from `cat-file` into its staged
  artifact, hashing as it goes, with no whole-blob buffering however large the blob is. It computes
  the Git blob ID of the same bytes, and refuses the acquisition if it differs from the ID the tree
  names.
- **`inspect` recomputes each entry's blob ID from the preserved artifact,** which needs no
  repository.
- **The claim stops there.** Sulai keeps no commit or tree objects, so without the repository it
  cannot prove that the tree held exactly these paths, and it preserves no history. A standalone
  proof can be added if someone needs to verify a capture without the repository.

### Special tree entries

- **Regular and executable blobs** are captured, and their mode is kept.
- **Symbolic links** (`120000`) are captured as what the tree holds: a blob whose bytes are the link
  target. The entry keeps mode `120000`, and the link is never dereferenced or followed. A folder
  walk skips links because following one would read outside the root; a Git link's target is only
  bytes in the commit.
- **Submodules** (gitlinks, `160000`) are excluded with reason `submodule`, recording the commit ID
  they name. They name another repository's commit, not bytes in this one, and Sulai never descends
  into another repository.
- **LFS pointer files** are ordinary blobs and are preserved as pointers. Sulai never fetches LFS
  content; that would be a separate acquisition.
- **A path that is not valid UTF-8** is skipped with reason `non-utf8-name`, as for folders.

### How Git is run

Git acquisition must keep the promise that the CLI sends nothing over the network and changes nothing
it reads. So Sulai never relies on the user's configuration for these, and sets them explicitly:

- **No network.** Lazy fetching is disabled (`--no-lazy-fetch`, `GIT_NO_LAZY_FETCH=1`). In a partial
  clone, an object that is not present locally makes the acquisition fail with a clear message; Sulai
  never contacts a remote to get it.
- **No replacement objects.** Replacement refs are ignored (`--no-replace-objects`,
  `GIT_NO_REPLACE_OBJECTS=1`), so the bytes read are the objects the commit actually names.
- **No writes.** Optional locks are disabled (`--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`), so
  checking the working tree does not refresh the index. Trace output is off: inherited `GIT_TRACE*`
  variables, and on Windows `GIT_REDIRECT_*`, are removed, and `GIT_TRACE2`, `GIT_TRACE2_EVENT` and
  `GIT_TRACE2_PERF` are set to `0`. Those variables override a Trace2 target set in system or global
  configuration, which a `-c` setting does not, because Git reads that configuration first.
- **No external programs.** `core.fsmonitor` is off, there is no pager, and only plumbing and status
  commands run. `status` rehashes a file whose cached details are stale through that file's filter,
  and the Git LFS filter also writes to the repository, so every configured filter driver is turned
  off for the check. No hook, filter or textconv program runs.
- **Explicit flags.** The status check passes its own flags, such as `--untracked-files=normal` and
  `--ignore-submodules=dirty`, rather than taking them from configuration. An untracked folder is
  reported whole, so Git never lists every file in one, the project's own store included. A
  submodule counts as changed when a different commit is checked out in it. Its own working tree
  belongs to another repository, which Sulai never enters; `none` would run Git inside it.
- **Git's own safety settings stay.** Sulai does not override `safe.directory` or similar.

Sulai checks that the `git` it finds supports these switches, and refuses Git acquisition if it does
not.

### Uncommitted work

Before reading, Sulai asks Git whether the working tree differs from HEAD: staged changes, modified
tracked files, or untracked files that are not ignored. The project's own store is not the user's
work, so its untracked files do not count when it lies inside the working tree.

- **If it differs, the acquisition is refused,** naming how many paths differ, unless the caller
  explicitly asks to capture the commit anyway.
- **The root records `worktree`:** `clean`, `differs` (captured anyway), or `absent` (a bare
  repository).

`worktree` is what Sulai's own check found, not Git's verdict. The check runs no filter program, so
a file whose working copy a filter transforms, such as one Git LFS has smudged, counts as differing
once its cached details are stale, where Git would run the filter and call it clean. The check
refuses rather than run the program.

The record is truthful either way: it names the commit, and says what the check of the working tree
found. Refusing by default is a fail-safe for the caller, most likely an agent that has just changed
files and could mistake the committed evidence for its current work. It is a policy of the command,
not part of what a Git acquisition means, so real use can change the default without changing the
format.

### Mixed roots

One occurrence can mix Git roots and folder roots, numbered `r1`, `r2` and so on in order, as now. A
Git root is refused if a folder root lies inside or contains its working folder, so every input
still belongs to exactly one root.

Two Git roots may name the same repository. At different commits they are two coherent pieces of
evidence, and the format allows it. The first command captures only HEAD, so it refuses the
accidental duplicate of one repository at one commit twice; that is a check of the command, not a
rule of the format.

### Citations do not change

A state page cites `r1/src/server.ts#L30-L38` whether `r1` is a folder or a commit. Resolution finds
the entry by root and path and cuts the range from its artifact, as it does now. The kept-citation
check of ADR 0008 applies unchanged.

### Artifacts stay source-neutral

[ADR 0005](0005-import-occurrences-record-acquisition-events.md) kept every source's concepts out of
core and the record. That still holds for artifacts: bytes are preserved the same way whatever they
came from. It no longer holds for an occurrence. A Git root records Git's commit, tree and blob IDs
and its modes, because a commit's identity cannot be stated honestly in generic filesystem terms.
Provenance may carry source-specific facts when generic metadata cannot represent the source.

### Format and compatibility

- **Occurrence version 2,** identified as `occurrence:v2:<sha256>`. Each root has a `source`, either
  `filesystem` or `git`. Folder roots and entries are as in version 1; Git roots and entries carry
  the fields above and no modification time. Version 1 records stay valid and readable.
- **State revision version 2,** identical to version 1 except that its occurrence and its parent may
  be of either version. New revisions are written as version 2; version 1 revisions stay valid.
- **Storage format 5.** A version 4 build must not half-read a store holding records it cannot
  parse, so the marker changes. Versions 1 to 3 stay refused.

### Upgrading a version 4 store

A version 5 build refuses a version 4 store with a message naming `sulai upgrade`. Upgrading is the
one deliberate mutation of stored metadata, and it touches only the marker:

- **Verify first.** The whole store is verified as version 4, exactly as `inspect` would. If
  anything fails, the upgrade stops and the store is left as it was.
- **Then switch the marker atomically.** The version 5 marker is staged in `tmp/`, synced, and
  renamed over `project.json`. An interrupted upgrade leaves either the valid version 4 marker or
  the valid version 5 marker, never a partial one.
- **Nothing else is touched.** Every version 4 record is a valid version 5 record, so no artifact,
  occurrence or state is rewritten.

`project.json` is the only stored file that is ever replaced, and only by this command. Everything
else keeps the never-replace rule.

### Not decided here

The command name and the agent-facing flow are chosen once the record is right. Capturing the working
tree with its uncommitted changes, and capturing part of a repository, wait until real use needs
them.

## Consequences

An agent can capture a Git project without preparing an export, and the record says which commit it
read. Filesystem acquisition is unchanged and needs nothing new. Git acquisition needs a `git`
executable that supports the switches above.

The store gains a second version of occurrences and of state revisions, and the code that reads them
grows to match.

## Acceptance

The implementation is accepted when its tests show that:

- a large untracked `node_modules` contributes nothing;
- a modified working-tree file is never mistaken for its HEAD blob. With uncommitted work the
  acquisition is refused, and it records `differs` only when asked to capture anyway;
- two acquisitions of one commit share every artifact and are two occurrences;
- the commit, the tree and the object format are recorded, and executable mode is kept;
- a symbolic link is preserved as a `120000` blob of its target and never followed;
- a submodule is excluded with the commit it names, and not entered;
- a tracked path under `.sulai/` is preserved;
- an LFS pointer stays a pointer;
- `export-ignore` and `export-subst` do not change what is captured;
- a replacement ref does not change what is captured;
- a partial clone missing an object refuses without any network access;
- checking the working tree leaves the index untouched;
- a repository with no commit is refused with a clear result;
- a large blob is streamed with bounded memory;
- a bare repository can be captured;
- `inspect` recomputes every blob ID from the preserved bytes;
- a state citation into a Git root resolves exactly as one into a folder;
- a version 4 store is refused until upgraded, and upgrading changes only the marker;
- a corrupt version 4 store refuses the upgrade and keeps its version 4 marker.

## Alternatives considered

**Running `git archive` behind `import`.** Rejected: an archive is an export with attributes applied,
and the record would still claim a folder.

**Checking out into a temporary folder and importing it.** Rejected for the same reason. It would
record a folder that never existed for the user, and lose the commit.

**Git-only occurrences, kept apart from folder occurrences.** Rejected: one acquisition may need a
repository and a folder of research together.

**Excluding Git symbolic links, as a folder walk skips them.** Rejected: a Git link is a blob in the
commit, and preserving its bytes follows nothing, so excluding it would leave a hole in the commit
for no safety gain.

**Reading Git objects directly, without the `git` executable.** Deferred: it means parsing loose
objects, packfiles, deltas, alternates and partial clones, and Git is present wherever there is a
repository.

**Keeping commit and tree objects for a standalone proof.** Deferred until someone needs to verify a
capture without the repository.

**Refusing version 4 stores with no upgrade.** Rejected: every version 4 record is valid in version
5, and early stores would be lost for no reason.
