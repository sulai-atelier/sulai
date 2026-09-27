# @sulai/experimental-claude-code

**Experimental. Expect it to change or be deleted.**

A structural reader for one Claude Code local session transcript, the JSON Lines file Claude Code
keeps on disk for each session.

## Why it is separate

That file layout is an internal detail of another product, not a published interchange format. It can
change in any release. This package exists to learn from real local AI history now, instead of waiting
on an official provider export, without letting an undocumented format leak into Sulai.

The boundary is enforced by the dependency graph rather than by convention:

- `@sulai/core` does not depend on this package and cannot import it.
- Nothing this reader produces is persisted. Storage preserves the transcript as exact bytes, as it
  does any other artifact; this reader only interprets those bytes when asked.
- It is not a provider adapter interface. No abstraction shared with other providers is declared
  here, and none will be until a second real provider has been read.

## What it reports

Structure only, never message text:

- every record, with its line number and an exact `SourceUnit` covering its bytes
- a kind for each record: `message`, `metadata`, `unknown`, or `unparseable`
- the `uuid` / `parentUuid` tree: explicit roots, branch points, parents that resolve to nothing, and
  duplicated uuids
- for message records, the role and the ordered content block types, such as
  `thinking, text` or `tool_use`

## Lenient on purpose

The synthetic conversation format in `@sulai/core` is strict, because Sulai defines it. This reader is
the opposite, because nobody promises what this format contains. A line it cannot decode or parse is
reported as `unparseable`, with its exact source unit, rather than failing the whole transcript. A
record type it has never seen is reported as `unknown`. A final record with no newline, which is what
an interrupted write leaves behind, is read like any other.

## Limit

The reader holds a whole transcript in memory to build its tree, so it refuses transcripts over
64 MiB. That is a limit on this reader, not on storage: Sulai streams preservation and has no storage
ceiling, so a larger transcript is still preserved exactly and can be read by a future streaming
reader.
