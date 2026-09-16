# ADR 0003: Storage is independent of artifact format

Status: Accepted

Supersedes the storage assumptions in the initial implementation, not ADR 0001 or ADR 0002.

## Context

ADR 0001 defines an artifact as an immutable sequence of exact bytes whose identity is the SHA-256 of
those bytes. The first implementation then contradicted that definition in three places:

- The project marker recorded `artifactFormat: "sulai.conversation.v1"`, asserting that every artifact
  in the store had one format.
- Every stored artifact was read back through the synthetic conversation parser, so integrity could
  not be checked without interpreting.
- Import meant parsing a conversation. Material that did not parse was refused rather than stored.

Real provider exports are not one small text file. An export may be an archive containing a large
JSON document, attachments of arbitrary type, and metadata. Some of it will not be understood by any
reader we have written yet, and the parts we do understand will be understood imperfectly at first.

Storage that assumes a format cannot hold that material, and refusing what we cannot yet parse
destroys exactly the evidence needed to improve the parser.

## Decision

The project marker describes the storage format only:

```text
{"format":"sulai.project","version":2}
```

Version 2 removes `artifactFormat`. Version 1 projects are refused with a specific message; this
pre-alpha does not migrate.

**Import preserves; it does not interpret.** `sulai import` stores exact bytes of any kind and
performs no format validation. Storing is not an assertion that the bytes are meaningful.

**Inspection is generic.** `sulai inspect` verifies that every stored artifact still hashes to the
name it is stored under, without parsing any of it.

**Interpretation is a separate, named operation.** `sulai interpret` reads one artifact through one
specific format. It can fail, be changed, or be replaced without affecting what was preserved.

The storage read ceiling (`MAX_ARTIFACT_BYTES`) is a property of the local store, distinct from
`MAX_CONVERSATION_BYTES`, which is a property of one format.

`Artifact.slice()` copies a single half-open range, so resolving a reference costs the size of the
range rather than the size of the artifact.

## Consequences

Material no current reader understands is preserved faithfully. When an adapter improves, it
re-derives from the untouched original instead of requiring the user to import again. This is the
property that makes a deliberately imperfect first provider adapter safe to ship.

Integrity checking no longer depends on any format, so a corrupt store is detected the same way
regardless of what it holds.

Three identities stay separate, and this ADR only settles the first:

```text
same bytes  !=  same import event  !=  same semantic meaning
```

An import occurrence, recording how bytes entered a project, is **not** implemented here. Provider,
timestamp, original filename and container relationships must never enter `ArtifactId`, so they need
their own record. That is deferred rather than designed in advance, because the shape should follow a
real export rather than an imagined one.

Import no longer reports a message count, since it no longer knows what it stored. Callers that want
structure call `interpret`.

**A trap for whoever adds import occurrences.** `importArtifactFile` returns `created`, which today
means "a new content-addressed artifact was written." Once occurrences exist, importing identical
bytes a second time will create **no new artifact and still create a new import occurrence**. So
`created: false` must not be read as "nothing happened," and the return shape will need to distinguish
the two. This follows directly from `same bytes != same import event` above; it is flagged here
because the current single boolean quietly conflates them.

Reads size their buffer from the file's observed size rather than the permitted ceiling, and refuse a
file whose size changes mid-read, since content addressing cannot describe a torn view. Reads are
still fully buffered, so `MAX_ARTIFACT_BYTES` bounds memory rather than expressing a real capability.
Exports larger than the ceiling need streaming identity before the limit can rise usefully; raising
the constant alone would not help. This is a known limitation, not a design position.

Containers are permitted by this model but not implemented. An entry extracted from an archive is a
new artifact derived from the archive artifact, recorded with the extraction method. Decompressed
bytes are not a contiguous byte range of the compressed container and must never be described as one.

## Alternatives considered

Keeping the format in the marker and adding a second artifact kind would have made the store aware of
formats forever, and every new provider would have widened a storage-level enumeration.

Validating on import, then storing, was the original behaviour. It makes the store's contents depend
on the quality of the parser at the moment of import, which is precisely the coupling that prevents
improving a parser after the fact.
