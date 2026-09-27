# Source and local storage format

This is the initial format, not a compatibility promise for real provider exports.
All committed fixture data is synthetic.

## Artifacts and source references

`Artifact` stores exact bytes, exposes their `byteLength` and ID, and returns copies
through `bytes()`. It can represent arbitrary bytes; the conversation importer
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
source bytes even though it decodes to `a`. This importer does not map arbitrary
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
    project.json
    artifacts/
      <64-character-sha256-digest>.raw
    occurrences/
      <64-character-sha256-digest>.json
    tmp/
```

`project.json` is the exact UTF-8 byte sequence below followed by one LF. It is a
format marker written and validated by the CLI, not user-editable configuration:

```text
{"format":"sulai.project","version":3}
```

The marker describes the **storage** format and deliberately says nothing about
the format of the artifacts inside, because an artifact is exact bytes of any
kind. Version 1 embedded `artifactFormat`; version 2 had no occurrence records.
Both are refused with a specific message before anything in the project is
touched, and this pre-alpha does not migrate them. The marker's version is not a
project state version. No project state is recorded by this CLI. See
[ADR 0003](adr/0003-storage-is-independent-of-artifact-format.md) and
[ADR 0005](adr/0005-import-occurrences-record-acquisition-events.md).

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
same way, parses it strictly, and checks that every artifact it names is stored at
the size it records.

`interpret` reads one artifact through one specific format. It may fail on bytes
that were stored successfully, and that failure leaves the artifact untouched.

Storage has **no size ceiling**. Import and inspection both stream, holding at most
one 1 MiB chunk of an artifact in memory whatever its size, so the constraint is
disk space rather than memory. A format limit such as the conversation format's
1 MiB constrains a reader, never storage. See
[ADR 0004](adr/0004-streaming-preservation-without-a-storage-ceiling.md).

There is no mutable artifact index: inspection enumerates sorted artifact names
and checks their hashes. It parses nothing and reconstructs no parser view, so a
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

`sulai import <project> <path>...` takes one or more files or directories. Each
path is one root of a single occurrence, numbered `r1`, `r2` and so on in the order
given. A directory is walked recursively and each regular file under it is
preserved. A file root has a single entry with the empty path, meaning the root
itself.

Every root is checked before anything is captured. If a root is missing, is a link,
is neither a file nor a directory, lies inside the project store, or overlaps
another root, the whole acquisition is refused and nothing is recorded. Overlap is
judged by real path, and directory roots also by filesystem identity. Identical
bytes under different roots are one artifact with separate entries. See
[ADR 0006](adr/0006-several-roots-in-one-acquisition.md).

The record is one line of compact JSON followed by one LF, with the fields in this
order and no others:

| Field        | Meaning                                                                      |
| ------------ | ---------------------------------------------------------------------------- |
| `format`     | `"sulai.occurrence"`                                                         |
| `version`    | `1`                                                                          |
| `nonce`      | 32 lowercase hexadecimal characters, random per acquisition                  |
| `startedAt`  | acquisition start, `YYYY-MM-DDTHH:MM:SS.sssZ`, the acquiring machine's clock |
| `finishedAt` | acquisition end, same form, not before `startedAt`                           |
| `status`     | `"partial"` exactly when `skipped` is nonempty, otherwise `"complete"`       |
| `roots`      | nonempty; each `{id, kind, platform, locator}`                               |
| `entries`    | captured inputs; each `{root, path, artifact, byteLength, modifiedAt, new}`  |
| `skipped`    | inputs found but not captured; each `{root, path, reason}`                   |
| `excluded`   | inputs deliberately not walked; each `{root, path, reason}`                  |

Roots are numbered `r1`, `r2` and so on, in order. `kind` is `file` or
`directory`. `platform` is the acquiring platform, such as `linux`, `darwin` or
`win32`. It says how to read `locator`, which is the absolute path of the root as
observed at acquisition. The locator is history: it never enters artifact identity,
and Sulai never opens it again.

Paths are relative to their root and `/`-separated. They have no empty, `.` or `..`
segments. Only a file root uses the empty path, and a file root records exactly one
input. `artifact` is an `ArtifactId`. `byteLength` is its size. `modifiedAt` is the
filesystem's modification time when the input was read, unverified. `new` says
whether this acquisition added the bytes to the store, and entries with the same
artifact agree on it.

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
coincide. That is the only case in which two records may share a path. The only
exclusion reason is `project-store`: the project's own `.sulai` directory when it
lies inside a root.

Entries, skipped inputs and exclusions are each sorted by root and then by the
UTF-8 bytes of the path, without duplicates. No input is both captured and excluded,
and nothing is recorded inside an excluded directory. Every string is well-formed
Unicode.

A record is accepted only if it is byte-for-byte the canonical encoding above, so
each record has one encoding. Its identity is `occurrence:v1:` followed by the
SHA-256 of those bytes, and it is stored as `occurrences/<digest>.json`. In-memory
reads of one record are limited to 64 MiB.

Acquisition order: each input is streamed and published as an artifact first, and
the occurrence is published last, by the same never-replace hard-link protocol. A
failure of the store, or a root that cannot be listed at all once the walk has
begun, stops the acquisition before any record is written, leaving at most
unreferenced artifacts. An input that cannot be captured is skipped and the walk
continues. The walk is not atomic. Inputs that appear during it may be
missed, and `complete` means everything the walk found was captured. It never means
a snapshot of one instant.

The CLI prints `occurrenceId`, `status`, `roots`, `entryCount`, `newArtifacts`,
`existingArtifacts`, `skipped` and `excluded`; each skipped or excluded item names
its root. A partial acquisition exits with
status 3 and still prints its record. `sulai inspect <project> <occurrence-id>`
prints the full record after verifying it and every artifact it names.
