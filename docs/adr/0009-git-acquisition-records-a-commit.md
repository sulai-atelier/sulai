# ADR 0009: A Git acquisition records a commit, not a working folder

Status: Proposed. Would add occurrence version 2 and state revision version 2, and raise the storage
format to version 5.

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
- **Not the working folder.** Untracked and ignored files contribute nothing, however large.
- **A bare repository works too,** because the source is the object database.

### Identity and verification

- **The root records** the repository's object format (`sha1` or `sha256`), the commit ID, and the
  commit's tree ID. The repository's path is recorded as where Sulai observed it; it is not
  identity. Remote URLs are not recorded.
- **Each captured entry records** its path, its mode (`100644` or `100755`), its blob ID, and the
  artifact its bytes became.
- **Each blob is verified while it is read.** Sulai computes the Git blob ID of the bytes as it
  streams them, and refuses the acquisition if it differs from the ID the tree names.
- **`inspect` recomputes each entry's blob ID from the preserved artifact,** which needs no
  repository.
- **The claim stops there.** Sulai keeps no commit or tree objects, so without the repository it
  cannot prove that the tree held exactly these paths, and it preserves no history. A standalone
  proof can be added if someone needs to verify a capture without the repository.

### Special tree entries

- **Regular and executable blobs** are captured, and their mode is kept.
- **Symbolic links** (`120000`) are excluded with reason `symbolic-link`: recorded, never followed,
  not preserved.
- **Submodules** (gitlinks, `160000`) are excluded with reason `submodule`, recording the commit ID
  they name. Sulai never descends into another repository.
- **LFS pointer files** are ordinary blobs and are preserved as pointers. Sulai never fetches LFS
  content; that would be a separate acquisition.
- **A path that is not valid UTF-8** is skipped with reason `non-utf8-name`, as for folders.
- **A tracked path inside the project's own store** is excluded with reason `project-store`, as for
  folders.

A symbolic link found in a folder walk is recorded as skipped. In a Git tree it is excluded instead:
the tree states exactly what the entry is, and nothing about it was unreadable.

### Uncommitted work

Before reading, Sulai asks Git whether the working tree differs from HEAD: staged changes, modified
tracked files, or untracked files that are not ignored.

- **If it differs, the acquisition is refused,** naming how many paths differ, unless the caller
  explicitly asks to capture the commit anyway.
- **The root records `worktree`:** `clean`, `differs` (captured anyway), or `absent` (a bare
  repository).

The likely caller is an agent that has just changed files. Capturing HEAD while that work sits
uncommitted, and reporting success, would misstate what the project holds.

Sulai runs Git read-only: plumbing commands only, with `core.fsmonitor` off, no pager, no hooks and
no filters. It does not override Git's own safety settings, such as `safe.directory`.

### Mixed roots

One occurrence can mix Git roots and folder roots, numbered `r1`, `r2` and so on in order, as now. A
Git root is refused if a folder root lies inside or contains its working folder, or if another Git
root names the same repository, so every input still belongs to exactly one root.

### Citations do not change

A state page cites `r1/src/server.ts#L30-L38` whether `r1` is a folder or a commit. Resolution finds
the entry by root and path and cuts the range from its artifact, as it does now. The kept-citation
check of ADR 0008 applies unchanged.

### Format and compatibility

- **Occurrence version 2,** identified as `occurrence:v2:<sha256>`. Each root has a `source`, either
  `filesystem` or `git`. Folder roots and entries are as in version 1; Git roots and entries carry
  the fields above and no modification time. Version 1 records stay valid and readable.
- **State revision version 2,** identical to version 1 except that its occurrence and its parent may
  be of either version. New revisions are written as version 2; version 1 revisions stay valid.
- **Storage format 5.** A version 4 build must not half-read a store holding records it cannot
  parse, so the marker changes. A version 5 build refuses a version 4 store with a message naming
  `sulai upgrade`, which verifies the store as it is and then replaces the marker. Nothing else
  changes, because every version 4 record is a valid version 5 record. Versions 1 to 3 stay refused.

### Not decided here

The command name and the agent-facing flow are chosen once the record is right. Capturing the working
tree with its uncommitted changes, and capturing part of a repository, wait until real use needs
them.

## Consequences

An agent can capture a Git project without preparing an export, and the record says which commit it
read. Filesystem acquisition is unchanged and needs nothing new. Git acquisition needs a `git`
executable.

The store gains a second version of occurrences and of state revisions, and the code that reads them
grows to match.

## Acceptance

The implementation is accepted when its tests show that:

- a large untracked `node_modules` contributes nothing;
- a modified working-tree file is never mistaken for its HEAD blob. With uncommitted work the
  acquisition is refused, and it records `differs` only when asked to capture anyway;
- two acquisitions of one commit share every artifact and are two occurrences;
- the commit, the tree and the object format are recorded, and executable mode is kept;
- symbolic links are not followed and submodules are not entered. An LFS pointer stays a pointer;
- `export-ignore` and `export-subst` do not change what is captured;
- a bare repository can be captured;
- `inspect` recomputes every blob ID from the preserved bytes;
- a state citation into a Git root resolves exactly as one into a folder;
- a version 4 store is refused until upgraded, and upgrading changes only the marker.

## Alternatives considered

**Running `git archive` behind `import`.** Rejected: an archive is an export with attributes applied,
and the record would still claim a folder.

**Checking out into a temporary folder and importing it.** Rejected for the same reason. It would
record a folder that never existed for the user, and lose the commit.

**Git-only occurrences, kept apart from folder occurrences.** Rejected: one acquisition may need a
repository and a folder of research together.

**Reading Git objects directly, without the `git` executable.** Deferred: it means parsing packfiles
and deltas, and Git is present wherever there is a repository.

**Keeping commit and tree objects for a standalone proof.** Deferred until someone needs to verify a
capture without the repository.

**Refusing version 4 stores with no upgrade.** Rejected: every version 4 record is valid in version
5, and early stores would be lost for no reason.
