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

Files are limited to 1 MiB (1,048,576 bytes) and 10,000 messages. The CLI accepts
regular files and performs bounded reads; the core also checks size and count.
Validation of the entire input precedes artifact publication.

## Local storage

```text
<project>/
  .sulai/
    project.json
    artifacts/
      <64-character-sha256-digest>.raw
    tmp/
```

`project.json` is the exact UTF-8 byte sequence below followed by one LF. It is a
format marker written and validated by the CLI, not user-editable configuration:

```text
{"format":"sulai.project","version":1,"artifactFormat":"sulai.conversation.v1"}
```

The marker's version describes the storage format. It is not an accepted project
state version. No accepted state is recorded by this CLI.

Imports write and sync a temporary file, close it, and publish a hard link under
the artifact digest. Linking fails if that name exists, so concurrent identical
imports converge on one complete file. Existing bytes are compared exactly before
reporting an import as already present. Temporary names are random but are never
part of an artifact or source identity. Cleanup retries transient `EBUSY` file
locks up to three times. Normal completion removes temporary files. A persistent
cleanup failure returns an error even if the artifact has already been published;
inspection can confirm its presence, and reimport remains idempotent.
If publication and cleanup both fail, the returned error retains both causes.

There is no mutable artifact index: inspection enumerates sorted artifact names,
checks their hashes, and reconstructs the parser view from the original bytes.
An unexpected store entry or a corrupt artifact causes inspection to fail. To
move a project, copy the entire `.sulai` directory, including empty directories,
while imports are stopped. Stored records contain no absolute paths.

This protocol requires local hard-link support (for example NTFS, APFS, or ext4)
and fails if it is unavailable; there is no fallback that overwrites data. It does
not promise directory-entry durability after power loss, atomic multi-artifact
transactions, or protection from another process editing storage. An interrupted
import may leave an unpublished file in `tmp`; inspection ignores it. Recovery and
cleanup policy are deferred. There is no automatic repair or deletion command.
