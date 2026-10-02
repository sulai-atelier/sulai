# ADR 0012: A Git working tree is its own source

Status: Accepted. Adds occurrence version 3 and state revision version 3, and raises the storage
format to version 6. Leaves [ADR 0009](0009-git-acquisition-records-a-commit.md) as it is.

## Context

[ADR 0011](0011-orientation-checks-the-state-before-serving-it.md) gives the agent working on a
project two commands, `orient` and `record`. As first built, both took a Git project's evidence
from the commit at HEAD, through the acquisition of ADR 0009. An agent's work lives in the working
tree until someone commits it, so every citation of new work pointed at text the commit did not
hold. The agent had two ways out, and both cost the person something: commit work nobody asked it
to commit, or stop and ask before the state could cite what it had just read. Agents did both. That
is not near-zero bookkeeping.

A commit and a working tree answer different questions. A commit says what the project contained
when it was committed, and it never changes. A working tree says what the project contains now,
which is what an agent reads and what its state should cite. Commit acquisition stays exactly as it
is. The working tree needs a source of its own, and occurrence version 2 cannot express one: its
Git root means one commit, with every blob ID checked against Git's objects.

Calling it a folder walk with `.gitignore` applied would hide the provenance. The record should say
which repository was observed, what HEAD was at the time, and which files Git's rules selected.

## Decision

### Three sources

```text
filesystem     walk a file or folder
git            read one immutable commit from Git's objects
git-worktree   observe a working tree, with Git choosing the files,
               and preserve the bytes present in it
```

A `git-worktree` root records the repository's object format, the commit HEAD named when the
acquisition began and that commit's tree (both `null` before the first commit), and where the working
tree was. HEAD is provenance: it says what the working tree was based on. It is not the identity of
the evidence. As everywhere, the evidence is the preserved bytes and their SHA-256.

### What is selected

**Every tracked file that is present, and every untracked file Git does not ignore.** Tracked means
in the index. This is the union Git lists with `ls-files --cached` and
`ls-files --others --exclude-standard`, minus tracked paths missing from the working tree:

- **A tracked file stays selected even when an ignore rule matches it,** as it does for Git.
- **A tracked file deleted from the working tree is not selected.** Its absence is the working
  tree's state, not a failure to read it.
- **Ignored untracked files are outside the selection and are not listed in the record,** however
  many there are. The root's source says they were left out, so `node_modules`, build output and
  ignored secrets are never enumerated or read.
- **The project's own store is always excluded,** even if it is tracked, because an acquisition
  cannot preserve the store it is writing into. The store `init` makes ignores itself, so usually
  it is simply not selected.
- **A submodule is excluded** with the commit the index names for it, and never entered. A Git
  repository nested in an untracked folder is excluded as `nested-repository` and never entered.
  Either can be acquired as a root of its own.
- **A symbolic link is never followed.** It is skipped with reason `symbolic-link`, as in a folder.
- **The repository is named by its top-level working folder.** Part of a repository, a bare
  repository, and a `.git` directory are refused.

### What is preserved

The bytes present in the working tree, read from the filesystem as a folder walk reads them: streamed
and hashed in one pass, with the changed-during-read guard, and each entry records the file's
modification time. They are not HEAD's blob bytes. A file Git LFS has smudged is preserved as its
content, not as the pointer; a file checked out with CRLF line endings is preserved with them. That
is what the agent reads. Commit acquisition still answers what the commit held.

Entries carry no blob ID. The working-tree bytes need not match any object Git has, and `inspect`
verifies them the way it verifies a folder's: against their own identity.

### Not a snapshot

A commit is atomic. A working tree is not. The record states what Sulai observed during the
acquisition, between `startedAt` and `finishedAt`. A file that changes while it is read is skipped
as `changed-during-read`, and a file that appears after Git listed the selection is not in the
occurrence. `complete` means everything selected was captured, not that the tree held still.

### How Git is run

As in ADR 0009: no network, no replacement objects, no optional locks, no trace output, no
fsmonitor, no pager, and no hook, filter or textconv program. Listing the selection runs only
`ls-files`, which reads the index and walks the folder with Git's ignore rules, and the bytes are read
by Sulai, so no filter runs at all. Nothing is written to the repository. Git's own safety settings,
such as `safe.directory`, apply as configured.

### Format and compatibility

- **Occurrence version 3,** identified as `occurrence:v3:<sha256>`. A root's `source` is
  `filesystem`, `git` or `git-worktree`. A `git-worktree` root is
  `{id, source, objectFormat, head, tree, selection, platform, locator}`, where `selection` is
  `"tracked-and-unignored"`, the rule above. Its entries are folder entries,
  `{root, path, artifact, byteLength, modifiedAt, new}`. Its exclusions are `project-store`,
  `submodule` with the commit the index names, and `nested-repository`. Folder and Git roots are
  as in version 2. Version 1 and 2 records stay valid.
- **State revision version 3,** identical to version 2 except that its occurrence and its parent may
  be of any version, so a history continues across the upgrade. A version 2 revision still names
  only version 1 or 2 records.
- **New records are written as version 3,** whatever their roots.
- **Storage format 6.** A version 5 build must not half-read a store holding records it cannot
  parse, so the marker changes.

### Upgrading

`sulai upgrade` takes a version 5 store to version 6, and a version 4 store directly to version 6,
the same way ADR 0009 took version 4 to 5: verify the whole store first, refuse if it holds a
record its marker's version could not have written, then stage, sync and rename the new marker.
Nothing else is touched, because every earlier record is valid in version 6.

### The agent-facing flow uses it

`orient` and `record` observe a Git project as its working tree. A revision recorded against a
commit is checked against the working tree too, since the question is whether its evidence still
holds for the project as it is now. The agent never needs to commit for Sulai, and the flow has no
`--allow-uncommitted`. `import --git` keeps reading the commit, and `import --worktree <repository>`
reads the working tree.

### Citations do not change

`r1/src/config.js#L3` is written and resolved the same way against a folder, a commit or a working
tree. The kept-citation check of ADR 0008 applies unchanged.

## Consequences

An agent can cite what it has just written, before anything is committed, and the next agent's
`orient` compares those exact bytes with the working tree as it is then. A change by anyone, committed
or not, that moves cited evidence is reported, and nobody has to commit or answer a question first.

Untracked files that are not ignored are preserved. A large file nobody added to `.gitignore` is
stored once, then shared by every later occurrence that holds the same bytes.

The store gains a third version of occurrences and of state revisions, and the readers grow to
match.

## Acceptance

The implementation is accepted when its tests show that:

- a modified tracked file is preserved as its working-tree bytes, not its HEAD blob;
- an untracked file that is not ignored is preserved, and a large ignored folder contributes nothing
  and is not listed;
- a tracked file matching an ignore rule is preserved;
- a deleted tracked file is not selected, and the occurrence is complete;
- the project's store is excluded, even when tracked;
- a submodule is excluded with the commit the index names, and a nested repository is excluded; neither
  is entered;
- a symbolic link is skipped and never followed;
- a file a filter transforms is preserved as the working copy, and no filter program runs;
- the index is unchanged by the acquisition;
- HEAD's commit and tree are recorded, or `null` before the first commit, when untracked files are
  still preserved;
- part of a repository and a bare repository are refused;
- a citation into a working-tree root resolves exactly as one into a folder;
- `orient` reports an uncommitted change that moves cited evidence, with no commit by anyone;
- state version 2 refuses to name an occurrence version 3, and state version 3 continues a version 2
  history;
- a version 5 store and a version 4 store are refused until upgraded, and upgrading changes only the
  marker; a store holding a record its marker's version could not have written refuses the upgrade.

## Alternatives considered

**Commits as the only evidence.** Rejected: it forces the agent to commit unasked or to stop and
ask.

**A folder root with Git's ignore rules applied.** Rejected: the record would claim a folder walk,
and lose the repository, HEAD and the selection rule.

**Capturing the working tree as a synthetic commit,** through a temporary index and a private object
store, to keep the format unchanged. Rejected: a Git root's commit would no longer be a commit anyone
made.

**Preserving a symbolic link's target as bytes,** as a Git root does. Deferred: a working tree's link
is a filesystem object, so it is treated as in a folder, until a real case needs its target.

**An atomic snapshot of the working tree.** Rejected: a live filesystem has none to offer, and
pretending would add complexity with no evidence that it is needed.
