# Format specification

This document defines Sulai's records and its local storage, format version 6. It
is pre-alpha: the format may change. A version 4 or 5 project is upgraded with
`sulai upgrade`; older projects are refused rather than migrated. The
[architecture overview](architecture.md) explains how the pieces fit together. All
committed fixture data is synthetic.

## Artifacts and source references

`Artifact` stores exact bytes, exposes their `byteLength` and ID, and returns copies
through `bytes()`. It can represent arbitrary bytes; the conversation interpreter
applies the more restrictive validation below. Neither filenames nor import times
are identity fields.

| Object     | Fields                                       | Identity                         |
| ---------- | -------------------------------------------- | -------------------------------- |
| Artifact   | `id`, `byteLength`, private raw bytes        | `sha256:` + SHA-256(raw bytes)   |
| SourceUnit | `id`, `artifactId`, `startByte`, `endByte`   | `source-unit:v1:` + digest below |
| SourceSpan | `id`, `sourceUnitId`, `startByte`, `endByte` | `source-span:v1:` + digest below |

A unit identifies an addressable record; a span selects part or all of a unit. Both
use absolute byte offsets into the artifact, starting at zero, with an exclusive
end. Ranges must be nonempty safe integers, within the artifact, and spans must
also lie within their referenced unit. Units may overlap. The generic byte model
permits a range to divide a UTF-8 character; consumers requesting text must select
appropriate character boundaries. Offsets are never JavaScript string indices,
code-point counts, or positions in decoded JSON content.

The digests use SHA-256 over the UTF-8 encoding of compact `JSON.stringify` arrays:

```text
unit: ["source-unit",1,artifactId,startByte,endByte]
span: ["source-span",1,sourceUnitId,startByte,endByte]
```

The prefixes, field order, integer encoding, and absence of whitespace are part of
version 1. Lowercase hexadecimal is used throughout. The span's parent binds it
transitively to the artifact. Identical text at another location gets a different
unit ID. Changing the parent or range changes the reference ID.

`parseSourceUnit` and `parseSourceSpan` accept unknown deserialized values and
recompute identities and bounds against the supplied artifact and parent. The
resolvers perform those checks too and return exact byte copies. TypeScript types
alone are not the trust boundary.

`Artifact.slice(startByte, endByte)` copies one half-open range and applies the
same range rules as a source reference. Resolving a reference costs the size of
the range rather than the size of the artifact, which matters once artifacts are
whole provider exports rather than small fixtures. `Artifact.bytes()` still
copies everything and should be used only when the whole artifact is genuinely
needed.

## Synthetic conversation format

Input is UTF-8 without a BOM. The first line has exactly one field:

```json
{ "format": "sulai.conversation.v1" }
```

At least one message follows, one flat JSON object per line:

```json
{ "role": "user", "content": "A synthetic message." }
```

Allowed roles are `system`, `user`, and `assistant`. Content is a well-formed
Unicode string; an empty string is allowed. Missing, unknown, or duplicate fields
(including escaped duplicate keys), unsupported versions, invalid UTF-8, invalid
JSON, and unpaired surrogate escapes in content are rejected. Fields may appear
in either order. No field expresses approval or semantic acceptance.

LF and CRLF delimiters are accepted, including mixed delimiters; the final delimiter
is optional. Blank lines are invalid. JSON whitespace and escape spelling are
preserved. Each message's source unit covers the entire raw JSON record including
surrounding whitespace, excluding its LF or CRLF delimiter. The header and all
delimiters remain in the artifact even though they have no message unit.

Decoded `content` is a parser view. A raw substring such as `\u0061` occupies six
source bytes even though it decodes to `a`. This interpreter does not map arbitrary
decoded substrings back through JSON escapes. A caller can cite the full message
unit or explicitly select a byte span from its raw record.

This format is limited to 1 MiB (1,048,576 bytes) and 10,000 messages. The whole
input is validated before any message is returned.

These are limits on **interpretation**, not on storage. An artifact larger than
1 MiB can be stored successfully and then be refused by this interpreter, because
storage has no size ceiling. The interpreter refuses an oversized artifact from its
filesystem size before reading any of it. Validation no longer precedes artifact
publication: publication does not validate at all.

## Local storage

```text
<project>/
  .sulai/
    .gitignore
    README.md
    project.json
    artifacts/
      <64-character-sha256-digest>.raw
    occurrences/
      <64-character-sha256-digest>.json
    states/
      <64-character-sha256-digest>.json
    tmp/
```

`.gitignore` holds `*`, so a project that is also a Git repository never
commits its store. `README.md` tells whoever finds the store to read it through
the `sulai` command. `sulai init` writes each when it is absent. Neither is part
of the format: nothing reads them, and a file already there is kept.

`project.json` is the exact UTF-8 byte sequence below followed by one LF. It is a
format marker written and validated by the CLI, not user-editable configuration:

```text
{"format":"sulai.project","version":6}
```

The marker describes the **storage** format and deliberately says nothing about
the format of the artifacts inside, because an artifact is exact bytes of any
kind. Version 1 embedded `artifactFormat`; version 2 had no occurrence records;
version 3 had no state revisions; version 4 had no version 2 occurrences or state
revisions; version 5 had no version 3 ones. Versions 1 to 3 are refused with a
specific message before anything in the project is touched, and this pre-alpha does
not migrate them. The marker's version is not a state revision. See
[ADR 0003](adr/0003-storage-is-independent-of-artifact-format.md),
[ADR 0005](adr/0005-import-occurrences-record-acquisition-events.md),
[ADR 0007](adr/0007-state-revisions-record-a-view-and-its-evidence.md),
[ADR 0009](adr/0009-git-acquisition-records-a-commit.md) and
[ADR 0012](adr/0012-a-git-working-tree-is-its-own-source.md).

A version 4 or 5 project is refused with a message naming
`sulai upgrade <project>`. Every earlier record is a valid version 6 record, so
upgrading changes only the marker. It first verifies the whole store as `inspect`
does, and stops if anything fails or if the store holds a record its marker's
version could not have written: version 4 holds only version 1 records, and
version 5 only version 1 and 2 records. Then it stages the version 6 marker in
`tmp`, syncs it, and renames it over `project.json`, so an interruption leaves
one whole marker or the other. `project.json` is the only
stored file that is ever replaced, and only by this command.

`.sulai/tmp` is ephemeral. It is recreated on demand, so its absence does not
make a project invalid. Storage directories are created with mode `0700`, which
POSIX systems enforce and Windows ignores.

Imports stream the source in 1 MiB chunks, feeding each chunk to SHA-256 and to a
temporary file in the same pass, then sync the temporary file, close it, and
publish a hard link under the artifact digest. Linking fails if that name exists,
so concurrent identical imports converge on one complete file. When the name is
already taken, the stored file is re-hashed by streaming and must match the new
identity before an import is reported as already present; a corrupt file under the
right name is refused rather than counted as a duplicate. Temporary names are random but are never
part of an artifact or source identity. Cleanup treats `EBUSY`, `EPERM` and
`EACCES` as transient and retries up to three times, because Windows reports a
locked file differently depending on which component holds it; `ENOENT` means the
file is already gone and is success. Normal completion removes temporary files. A
persistent cleanup failure returns an error even if the artifact has already been
published; inspection can confirm its presence, and reimport remains idempotent.
If publication and cleanup both fail, the returned error retains both causes.

## Preservation and interpretation are separate operations

`import` stores exact bytes and performs no format validation at all. Material
that no current reader understands is preserved faithfully, so a later reader can
re-derive from the untouched original rather than requiring a fresh import. Each
import also records one occurrence, described below.

`inspect` verifies that every stored artifact still hashes to the name it is
stored under, without parsing any artifact. It then verifies every occurrence the
same way, parses it strictly, checks that every artifact it names is stored at
the size it records, and recomputes the blob ID of every Git entry from its bytes.
Last it verifies every state revision, as described below.

`interpret` reads one artifact through one specific format. It may fail on bytes
that were stored successfully, and that failure leaves the artifact untouched.

Storage has **no size ceiling**. Import and inspection both stream, holding at most
one 1 MiB chunk of an artifact in memory whatever its size, so the constraint is
disk space rather than memory. A format limit such as the conversation format's
1 MiB constrains a reader, never storage. See
[ADR 0004](adr/0004-streaming-preservation-without-a-storage-ceiling.md).

There is no mutable artifact index: inspection enumerates sorted artifact names
and checks their hashes. It interprets no artifact and reconstructs no parser view, so a
store holding material that no reader understands still verifies cleanly. An
unexpected store entry or a corrupt artifact causes inspection to fail. Integrity
is the SHA-256 identity, so corruption that leaves the length unchanged is still
detected. Separately, a file whose size changes between being opened and being read
to the end is refused. That guard detects growth and truncation only; it does not
detect another process overwriting bytes in place at the same length, so it is not
an atomic snapshot of a live file. To move a project,
copy the entire `.sulai` directory while imports are stopped; `.sulai/tmp` is
ephemeral and need not be copied. No artifact name or identity contains a path.
Occurrence records do contain the absolute location of each acquisition root, as
history; see below.

This protocol requires local hard-link support (for example NTFS, APFS, or ext4)
and fails if it is unavailable; there is no fallback that overwrites data. It does
not promise directory-entry durability after power loss, atomic multi-artifact
transactions, or protection from another process editing storage. An interrupted
import may leave an unpublished file in `tmp`; inspection ignores it. Recovery and
cleanup policy are deferred. There is no automatic repair or deletion command.

## Import occurrences

An occurrence is an immutable record of one acquisition event. It is separate from
artifact identity: the same bytes can arrive in many events, and each event is
recorded. See [ADR 0005](adr/0005-import-occurrences-record-acquisition-events.md).

`sulai import <project> <root>... [--allow-uncommitted]` takes one or more
roots, each a file or directory path, `--git <repository>` for the commit at a
repository's HEAD, or `--worktree <repository>` for its working tree. Each is one root of a single occurrence, numbered `r1`, `r2`
and so on in the order given, whatever its kind. A directory is walked
recursively and each regular file under it is preserved. A file root has a single
entry with the empty path, meaning the root itself.

Every root is checked before anything is captured. If a root is missing, is a link,
is neither a file nor a directory, lies inside the project store, or overlaps
another root, the whole acquisition is refused and nothing is recorded. Overlap is
judged by real path, and directory roots also by filesystem identity. Identical
bytes under different roots are one artifact with separate entries. See
[ADR 0006](adr/0006-several-roots-in-one-acquisition.md).

**Git roots.** A Git root reads one commit from the repository's objects, never
from the working folder. HEAD is resolved once to the full commit ID, and every
path in that commit's tree is read through `git ls-tree` and `git cat-file`, with
no attributes, filters, end-of-line conversion or LFS smudging applied: the
preserved bytes are the blob bytes. Untracked and ignored files contribute
nothing. A tracked path under `.sulai` is preserved like any other. A symbolic
link is preserved as the blob the tree holds, whose bytes are its target, and is
never followed. A submodule is excluded with the commit it names, and never
entered. An LFS pointer is preserved as the pointer. Each blob is hashed while it
streams, and the acquisition is refused if its Git blob ID differs from the one
the tree names. See [ADR 0009](adr/0009-git-acquisition-records-a-commit.md).

The repository is named by its top-level working folder, or, when bare, by the
repository itself; capturing part of a repository is not supported. A repository
with no commit is refused. Git and folder roots can mix in one occurrence, but a
folder root may not lie inside or contain a Git root's working folder, and two
roots may not be the same commit of the same repository.

Before reading, Sulai asks Git whether the working tree differs from HEAD: staged
changes, changed tracked files, or untracked files that are not ignored. The
project's own store does not count when it lies inside the working tree, and a
submodule counts when a different commit is checked out in it. If anything differs,
the acquisition is refused, naming the paths, unless `--allow-uncommitted` is
given. An untracked folder is named whole. The root records what the check found.

The check runs no filter program. So a file whose working copy a filter
transforms, such as one Git LFS has smudged, counts as differing once its cached
details are stale, where `git status`, which runs the filter, would call it clean.
`worktree` is the result of Sulai's own check, not Git's verdict.

**Working-tree roots.** A working-tree root observes a repository's working tree
and preserves the bytes present in it, committed or not. Git chooses the files:
every tracked file, meaning every index entry, that is present in the working
tree, and every untracked file Git does not ignore by its standard rules, as
`git ls-files --stage` and `git ls-files --others --exclude-standard` list them.
A tracked file stays selected even when an ignore rule matches it. A tracked file
missing from the working tree is not selected; its absence is the tree's state.
Ignored untracked files are outside the selection and are never listed. The
project's own store is excluded even if tracked. A submodule is excluded with the
commit the index names for it, and a repository nested in untracked files is
excluded as `nested-repository`; neither is entered. A symbolic link is skipped,
never followed. The bytes are read from the filesystem as a folder walk reads
them, so a file a filter has transformed, such as one Git LFS has smudged, is
preserved as its working copy. The repository is named by its top-level working
folder; part of a repository and a bare repository are refused. See
[ADR 0012](adr/0012-a-git-working-tree-is-its-own-source.md).

A working tree is not a snapshot. The record states what was observed between
`startedAt` and `finishedAt`: a file that changes while it is read is skipped as
`changed-during-read`, and one that appears after Git listed the selection is
not in the occurrence.

Git acquisition needs `git` 2.45 or later on `PATH`. Every Git command runs with
lazy fetching, replacement objects and optional locks turned off
(`--no-lazy-fetch`, `--no-replace-objects`, `--no-optional-locks`, and their
environment variables), with `core.fsmonitor` off and no pager. The working-tree
check turns off every configured filter driver and passes its own flags:
`--porcelain=v1`, `-z`, `--untracked-files=normal`, `--ignore-submodules=dirty`
and `--no-renames`. A working-tree root runs only `ls-files`, which reads the
index and walks the folder with Git's ignore rules but reads no file's content. Variables that would point Git at another repository, index,
object store or configuration file are cleared. Trace output is off: inherited
`GIT_TRACE*` and `GIT_REDIRECT_*` variables are removed, and `GIT_TRACE2`,
`GIT_TRACE2_EVENT` and `GIT_TRACE2_PERF` are set to `0`, which overrides a
Trace2 target in system or global configuration. So nothing is fetched, nothing
is written, and no hook, filter, textconv, pager or fsmonitor program runs. Git's
own safety settings, such as `safe.directory`, apply as configured.

The record is one line of compact JSON followed by one LF, with the fields in this
order and no others:

| Field        | Meaning                                                                      |
| ------------ | ---------------------------------------------------------------------------- |
| `format`     | `"sulai.occurrence"`                                                         |
| `version`    | `3`                                                                          |
| `nonce`      | 32 lowercase hexadecimal characters, random per acquisition                  |
| `startedAt`  | acquisition start, `YYYY-MM-DDTHH:MM:SS.sssZ`, the acquiring machine's clock |
| `finishedAt` | acquisition end, same form, not before `startedAt`                           |
| `status`     | `"partial"` exactly when `skipped` is nonempty, otherwise `"complete"`       |
| `roots`      | nonempty; each a folder, Git or working-tree root, below                     |
| `entries`    | captured inputs, below                                                       |
| `skipped`    | inputs found but not captured; each `{root, path, reason}`                   |
| `excluded`   | inputs deliberately not read, below                                          |

Roots are numbered `r1`, `r2` and so on, in order:

| Root         | Fields                                                                                 |
| ------------ | -------------------------------------------------------------------------------------- |
| Folder       | `{id, source: "filesystem", kind, platform, locator}`                                  |
| Git          | `{id, source: "git", objectFormat, commit, tree, worktree, platform, locator}`         |
| Working tree | `{id, source: "git-worktree", objectFormat, head, tree, selection, platform, locator}` |

`kind` is `file` or `directory`. `platform` is the acquiring platform, such as
`linux`, `darwin` or `win32`. It says how to read `locator`, which is the absolute
path of the root, or of the repository, as observed at acquisition. The locator is
history: it never enters artifact identity, and Sulai never opens it again.
`objectFormat` is `sha1` or `sha256`. `commit` and `tree` are full, lowercase
object IDs in that format. `worktree` is what the working-tree check found:
`clean`, `differs` when captured anyway, or `absent` for a bare repository.
In a working-tree root, `head` is the commit HEAD named when the acquisition
began and `tree` is that commit's tree, both `null` before the first commit.
`selection` is `"tracked-and-unignored"`, the rule above. HEAD is provenance;
the evidence is the bytes.

| Entry                         | Fields                                                |
| ----------------------------- | ----------------------------------------------------- |
| In a folder or a working tree | `{root, path, artifact, byteLength, modifiedAt, new}` |
| In a Git root                 | `{root, path, artifact, byteLength, mode, blob, new}` |

Paths are relative to their root and `/`-separated. They have no empty, `.` or `..`
segments. Only a file root uses the empty path, and a file root records exactly one
input. `artifact` is an `ArtifactId`. `byteLength` is its size. `modifiedAt` is the
filesystem's modification time when the input was read, unverified. `mode` is
`100644`, `100755`, or `120000` for a symbolic link. `blob` is the blob ID the tree
names, verified against the bytes when they were read. Within one object format, a
blob ID and an artifact always go together. `new` says whether this acquisition
added the bytes to the store, and entries with the same artifact agree on it.

**Earlier versions** remain valid and are read as written. A version 2 record is
identical except that `version` is `2` and it has no working-tree roots. A
version 1 record is identical to that except that `version` is `1`, and every
root is a folder root written without `source`, as `{id, kind, platform, locator}`.

Skip reasons:

| Reason                | Meaning                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `symbolic-link`       | a link or junction, never followed                                  |
| `not-regular-file`    | a device, socket, pipe or similar                                   |
| `unreadable`          | permission denied, locked, or a read error                          |
| `vanished`            | listed, then gone before it could be read                           |
| `changed-during-read` | its size changed while it was read, or its type after it was listed |
| `non-utf8-name`       | a name that is not valid UTF-8                                      |

A non-UTF-8 name is recorded through a lossy decoding, so two such names can
coincide. That is the only case in which two records may share a path. A Git root
skips nothing else: a commit's tree holds only blobs and submodules.

| Exclusion           | Fields                         | Meaning                                                                             |
| ------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| `project-store`     | `{root, path, reason}`         | the project's own `.sulai` directory, in a folder root or a working tree            |
| `submodule`         | `{root, path, reason, commit}` | a submodule in a Git root or a working tree, and the commit the tree or index names |
| `nested-repository` | `{root, path, reason}`         | a repository nested in a working tree's untracked files                             |

Entries, skipped inputs and exclusions are each sorted by root and then by the
UTF-8 bytes of the path, without duplicates. No input is both captured and excluded,
and nothing is recorded inside an excluded directory. Every string is well-formed
Unicode.

A record is accepted only if it is byte-for-byte the canonical encoding above, so
each record has one encoding. Its identity is `occurrence:v3:`, or `occurrence:v2:`
or `occurrence:v1:` for an earlier record, followed by the SHA-256 of those bytes. It is stored as
`occurrences/<digest>.json` whatever its version, and the version the bytes declare
completes the identity. In-memory reads of one record are limited to 64 MiB.

Acquisition order: each input is streamed and published as an artifact first, and
the occurrence is published last, by the same never-replace hard-link protocol. A
failure of the store, or a root that cannot be listed at all once the walk has
begun, stops the acquisition before any record is written, leaving at most
unreferenced artifacts. An input that cannot be captured is skipped and the walk
continues. The walk is not atomic. Inputs that appear during it may be
missed, and `complete` means everything the walk found was captured. It never means
a snapshot of one instant. A commit does not change, so a Git root is exact. A
missing object, as in a partial clone, refuses the acquisition; Sulai never fetches
it. A working tree is observed as a folder is walked, not read as a commit.

The CLI prints `occurrenceId`, `status`, `roots`, `entryCount`, `newArtifacts`,
`existingArtifacts`, `skipped` and `excluded`; each skipped or excluded item names
its root. Each root is `{id, source, kind, locator}`, for a Git root
`{id, source, locator, commit, worktree}`, and for a working-tree root
`{id, source, locator, head}`. A partial acquisition exits with
status 3 and still prints its record. `sulai inspect <project> <occurrence-id>`
prints the full record after verifying it and every artifact it names, and
recomputing every Git blob ID.

## State revisions

A state revision records one view of where a project stands, as a page, plus
exactly what evidence the page cites. It does not certify the page. Each citation
is either resolved to exact preserved bytes or recorded as unresolved with a
reason. See [ADR 0007](adr/0007-state-revisions-record-a-view-and-its-evidence.md).

The **page** is UTF-8 text of at most 1 MiB, stored as an ordinary artifact. A
**reference** is an inline code span whose whole content matches
`rN/<path>#L<a>` or `rN/<path>#L<a>-L<b>`, or `rN#L<a>` and `rN#L<a>-L<b>`
for a file root. `rN` is a root ID of the revision's occurrence and `<path>` is
that occurrence's relative path. Lines are 1-based and inclusive. Every other code
span is not a reference. A page's references are its distinct locators in the
order they first appear.

**Line rules.** A line ends at LF, and a CR immediately before the LF belongs to
the terminator. The last line may have no LF, and a trailing LF does not start a
new line. A range runs from the first byte of line `a` to the end of line `b`'s
content, excluding its terminator, and must be valid UTF-8. An empty line gives an
empty range.

The record is one line of compact JSON followed by one LF, with the fields in this
order and no others:

| Field        | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `format`     | `"sulai.state"`                                                 |
| `version`    | `3`                                                             |
| `parent`     | a state ID, or `null` for a first revision                      |
| `createdAt`  | `YYYY-MM-DDTHH:MM:SS.sssZ`, the recording machine's clock       |
| `page`       | the page's `ArtifactId`                                         |
| `occurrence` | the `OccurrenceId` every reference is resolved against          |
| `references` | in page order; each `{locator, status, ...}` as described below |

A resolved reference is `{locator, status: "resolved", artifact, startByte,
endByte}`, with a half-open byte range into that artifact. An unresolved one is
`{locator, status: "unresolved", reason}`, and is never retargeted:

| Reason                   | Meaning                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `unknown-root`           | the occurrence has no such root                                                        |
| `path-not-in-occurrence` | no input at that path, or a path given for a file root or omitted for a directory root |
| `not-captured`           | the input was skipped, or lies inside an excluded directory                            |
| `invalid-lines`          | line 0, or a range that ends before it starts                                          |
| `line-out-of-range`      | the file has fewer lines                                                               |
| `not-utf8-text`          | the range is not valid UTF-8                                                           |

A record is accepted only if it is byte-for-byte this canonical encoding. Its
identity is `state:v3:`, or `state:v2:` or `state:v1:` for an earlier record,
followed by the SHA-256 of those bytes, and it is stored as `states/<digest>.json`
whatever its version. Earlier records are identical except for `version` and the
records they may name: a version 1 revision names only version 1 records, a
version 2 revision only version 1 or 2 records, and a version 3 revision any, so a
history continues across each upgrade. A citation into a Git root or a working
tree is written and resolved exactly as one into a folder.

**Recording.** `sulai state record <project> <page> --from <occurrence-id>
[--parent <state-id>]` resolves each reference once, streaming each cited artifact
once. The parent is the one given; otherwise the only head, a revision no other
revision names as its parent; otherwise none. With several heads and no parent
given, recording refuses and lists them. Time never chooses. The page artifact is
published first and the revision last, by the never-replace hard-link protocol, so
a failure leaves at most an unreferenced page artifact.

The page may be given as `-`, to read it from standard input. With a parent, every
citation the page keeps from the parent, and that resolved there, must still cite
the same bytes. If one now cites different text or no longer resolves, recording is
refused and names each such citation and its page lines, unless
`--allow-changed-citations` is given; the result then lists them as
`changedCitations`. See
[ADR 0008](adr/0008-a-kept-citation-keeps-its-evidence.md).

**Reading.** `sulai status <project>` prints every head with its page and the
reference counts recorded in it. It verifies every stored revision and each head's
page against their names, and never reads the evidence the pages cite. `sulai why
<project> <state-id> <line>` returns, for each reference on that line of the page,
its resolution and, when resolved, the exact bytes, with where they were: the root,
its locator, the path, and for a Git root the commit, or for a working tree the
HEAD it was observed at. It first verifies the cited
artifact's hash by streaming, then reads only the range, at most 1 MiB of it per
reference, marking a cut-off as `truncated`. `sulai diff <project> <a> <b>`
lists the page lines removed and added, in order.

**Verification.** `inspect` checks that each revision hashes to its name and is
canonical, that its parent is stored, that its page and occurrence verify, that its
references are exactly the page's references, and that resolving them again against
the occurrence gives exactly the recorded ranges and reasons.
