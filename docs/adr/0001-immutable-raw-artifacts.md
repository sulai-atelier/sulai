# ADR 0001: Preserve raw artifacts as immutable bytes

Status: Accepted

## Context

Reconciliation must be auditable against what was actually imported. Rewriting
JSON, normalizing Unicode, or changing line endings can discard distinctions and
invalidate positions even when the displayed text appears unchanged.

## Decision

An Artifact is an immutable byte sequence. Its ID is `sha256:` followed by the
lowercase SHA-256 digest of those exact bytes. Filenames, import times, parser
versions, provider labels, and inferred meaning are not part of artifact identity.
Identical bytes share an artifact ID; equivalent decoded text need not.

The in-memory artifact copies input and returned bytes. The local store publishes
complete files without replacement and verifies identity when reading them.
Reimport checks any existing bytes and refuses to replace a mismatch. Corrections
must produce new artifacts; supersession cannot rewrite old ones.

Source units and spans use nonempty, half-open byte ranges in the artifact. Their
versioned identities bind the range to its parent. The precise encoding and
coordinate conventions are specified in [the format document](../format.md).

## Consequences

Exact originals and references survive a directory copy and can be checked without
a model or database. Raw bytes remain the reference when parsers change.

Byte identity is not an import occurrence, proof of authorship, semantic equality,
or evidentiary support. Occurrence metadata and provider-specific provenance are
deferred. No mutable semantic fields belong on an artifact.

Immutability is enforced by the API and write protocol, not by tamper-proof storage.
Filesystem owners can change or remove files. This first store does not solve
backup, migration, power-loss durability, or deliberate deletion policies.

## Alternatives considered

Storing only parsed or normalized messages would lose source fidelity. Random IDs
alone would not provide deterministic deduplication or content verification.
Canonicalized semantic hashes would conflate source identity with an interpretation.
