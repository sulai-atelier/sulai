# ADR 0005: Import occurrences record acquisition events

Status: Accepted. The CLI now fills several roots per acquisition; see
[ADR 0006](0006-several-roots-in-one-acquisition.md).

## Context

[ADR 0003](0003-storage-is-independent-of-artifact-format.md) separated three identities, `same bytes
!= same import event != same semantic meaning`, and deferred the import event until a real input showed
its shape. Until now a stored artifact answered "which bytes" and nothing answered "which file, from
where, when, and what was missed".

A real coding-agent project store has since been examined. Four facts from it shaped this design:

- **A work surface spans more than one directory.** Session files, tool outputs, scratch files and
  backups live under several roots.
- **Links between those files are mostly absolute path strings inside content**, not content hashes.
  Resolving one after the files move requires knowing where its root was when it was read.
- **Some files are still being written while they are read.**
- **Recorded activity mentions sensitive locations,** such as credential directories. A reference to a
  path says nothing about whether copying it is safe.

## Decision

**An import occurrence is an immutable record of one acquisition event**, separate from artifact
identity. It records which inputs were attempted, which exact bytes each became, which were already
stored, and which could not be captured and why.

It is stored as `.sulai/occurrences/<sha256>.json`. Its identity is `occurrence:v1:` followed by the
SHA-256 of its exact bytes. The encoding is canonical, one compact JSON line with a fixed field order,
and a record that is not byte-for-byte canonical is refused. Publication uses the same hard-link,
never-replace protocol as artifacts. [The format](../source-format.md#import-occurrences) lists every
field and rule.

**A random nonce makes each acquisition its own event.** Acquiring unchanged bytes twice, even in the
same millisecond, gives two occurrences. Randomness enters event identity only, never artifact
identity.

**The format holds several roots.** Each entry names its root. The CLI acquires one root per call
today, but a work surface that spans several roots needs no format change.

**Path provenance is split between portable and local.** Entry paths are relative to their root,
`/`-separated, and portable. Each root records its `locator`, the absolute path observed at
acquisition, together with the acquiring `platform`. The locator is history:

- it never enters artifact identity;
- Sulai never opens it again.

It is kept because it is the only way to resolve absolute links in the preserved content later. This
replaces the earlier blanket rule that stored records contain no absolute paths.

**An acquisition reads only what the caller chose.** It never follows symbolic links or junctions, and
never reads content looking for references. A file that some content mentions is not acquired unless
it lies under a chosen root. Recording such references is interpretation, which belongs to readers,
and v1 records none. The project's own store is excluded when it lies inside a root, and the
exclusion is listed.

**A partial acquisition cannot pass for a complete one.** Every input the walk found is recorded
either as an entry or as skipped, with one of these reasons:

- `symbolic-link`
- `not-regular-file`
- `unreadable`
- `vanished`
- `changed-during-read`
- `non-utf8-name`

The record's `status` is `partial` exactly when something was skipped, and the CLI then exits with
status 3. Even `complete` means only that everything the walk found was captured. A walk is not
atomic, and no occurrence claims to be a snapshot of one instant.

**Artifacts are published first and the occurrence last.** An occurrence therefore never names bytes
the store does not hold. An input that cannot be captured is skipped and the walk continues. A failure
of the store stops the acquisition, and no record is written.

**New and existing are counted separately.** Each entry says whether this acquisition added its bytes
to the store, and the CLI reports `newArtifacts` and `existingArtifacts`. This resolves the `created`
trap recorded in ADR 0003: re-importing identical bytes adds no artifact and still records an event.

**The storage format becomes version 3.** Occurrences change what a complete project is. So versions
1 and 2 are refused by name, and this pre-alpha does not migrate them. An older build refuses a
version 3 project rather than reporting it healthy without having checked its occurrences.

**Core stays provider-neutral.** Its vocabulary is roots, relative paths, artifacts, observed
metadata, and skipped and excluded inputs. No provider's concepts appear in core or in the record.

## Consequences

**Every path gets a version history for free.** Acquire a directory twice and a file that grew shows
up as one path with two artifacts across two events. That is an observation. It does not assert that
the later bytes supersede the earlier ones.

**Locators disclose local paths,** such as user and directory names. Treat a `.sulai` directory as
being as private as the material in it. Sharing occurrences shares those paths, and redaction for
sharing is future work.

**Known limits:**

- Inputs that appear during a walk may be missed.
- An in-place overwrite at the same length is not detected ([ADR 0004](0004-streaming-preservation-without-a-storage-ceiling.md)).
- Empty directories are not recorded.
- Modification times are the filesystem's claim, and they are not verified.
- A name that is not valid UTF-8 is skipped rather than captured, and it is recorded through a lossy
  decoding, so two such names can coincide in the record.
- One record is held in memory while it is built and verified, bounded at 64 MiB.
- Occurrences are never merged, deduplicated or deleted.

**The storage primitive `importArtifactFile` records no occurrence.** It remains available to library
callers, and the CLI does not use it.

## Alternatives considered

**A basename-only root with no absolute paths** was the first proposal. Rejected: it cannot resolve
the absolute links found in real content.

**A separate, mutable map from root ids to locations** would keep the record portable. Rejected: where
a root was at acquisition is a historical fact, so it belongs in the immutable record.

**Following references in content to capture everything a session touched.** Rejected on security
grounds. A session that read a credential file must not cause Sulai to copy it. Scope is what the
caller chose, and nothing else.

**Adding occurrences as an optional extension to version 2.** Rejected: an older inspector would
ignore them and still report the project healthy.

**Snapshotting a live file up to its last complete record.** Rejected for v1. It depends on knowing
the file's format, and it would make a new claim about live files. The file is skipped instead.

**Relying on timestamps alone to tell events apart.** Rejected: two acquisitions in the same
millisecond would collide.
