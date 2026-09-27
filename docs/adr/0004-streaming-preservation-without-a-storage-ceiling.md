# ADR 0004: Streaming preservation without a storage ceiling

Status: Accepted

Supersedes the storage read ceiling in ADR 0003. The rest of ADR 0003 stands.

## Context

ADR 0003 separated storage from artifact format but kept every read fully buffered, bounded by a
64 MiB local-store ceiling (`MAX_ARTIFACT_BYTES`). It recorded that ceiling as a known limitation
rather than a design position, and said explicitly that raising the constant would not help.

Real AI session history already exceeds it. A single Claude Code session transcript on a working
machine measured 109.7 MB and had grown to 111.0 MB by the time this was built, because it belongs to
a session that was still running. The buffered path refused it outright. A whole-account provider
export can be larger still.

Buffering also cost memory proportional to the artifact on every import and every inspection, and
inspection copied a second time when constructing an `Artifact`.

## Decision

Preservation and verification stream. Neither holds more than one chunk (`STREAM_CHUNK_BYTES`,
1 MiB) of an artifact in memory at a time, whatever its size.

**Import** reads the source in chunks, feeding each one to SHA-256 and to a new temporary file in the
same pass, so the identity is known when the last byte is written. The temporary file is synced and
then published under its content address by hard link, which refuses to replace an existing name.
This is the same atomic, non-replacing publication as before; only the path to it changed.

**When the content address is already taken**, the stored file is re-hashed by streaming and compared
with the new identity, rather than being byte-compared with an in-memory copy or trusted by its name.
A corrupt file under the right name is therefore refused rather than reported as a duplicate.

**Inspection** streams every stored artifact through SHA-256 and compares the result with the name it
is stored under. It holds one chunk at a time and constructs no `Artifact`.

**There is no storage size ceiling.** The ceiling existed only to bound memory, and streaming removes
that reason. The real constraint is disk space; running out of it fails and cleans up the temporary
file like any other write error.

**Interpretation keeps its own limit.** A format that must hold the whole artifact in memory to parse
it bounds its input, and refuses an oversized artifact from filesystem metadata before reading any of
it. `MAX_CONVERSATION_BYTES` is such a limit. It constrains a reader, never storage.

## Consequences

The 111.0 MB transcript that motivated this was preserved byte-exact and verified with 3.2 MB of peak
memory growth, in about 0.2 s to import and 0.2 s to inspect.

A file whose size changes between being opened and being read to the end is refused, and a partially
written temporary file is removed. **This detects growth and truncation only.** Another process
overwriting bytes in place at the same length is not detected, so Sulai does not provide an atomic
snapshot of a live file. It is correct for files that have finished being written, such as an export
archive. Reading a session transcript while its session is still running is exactly the case where
this guard may refuse, and refusing is the right outcome.

Content integrity does not rely on that size check. Integrity is the SHA-256 identity, so corruption
that leaves the length unchanged is still detected by inspection and by re-import.

Preservation doubles disk use while a copy is made, since the source is untouched and the store holds
its own exact copy. That is inherent to preserving an original rather than referencing it.

The on-disk format is unchanged. The project marker stays at version 2 and existing projects need no
migration, because only how bytes are read and written changed, not how they are laid out.

## Alternatives considered

Raising `MAX_ARTIFACT_BYTES` would have moved the failure to a larger file while making every import
of a large artifact cost that much memory. ADR 0003 already rejected it.

Node read and write streams with `pipeline` would work, but a manual chunk loop over file handles
makes the memory bound explicit, keeps the no-follow open that rejects symbolic links, and allows the
target to be synced before publication without depending on stream internals.
