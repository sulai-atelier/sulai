# ADR 0006: Several roots in one acquisition

Status: Accepted. Extends [ADR 0005](0005-import-occurrences-record-acquisition-events.md) without changing the
occurrence format.

## Context

ADR 0005 gave the occurrence format several roots, because a real work surface spans several places,
but the CLI could fill only one. One real coding-agent session was found to span six roots:

- its project store;
- a session temporary directory;
- three sibling project directories;
- a file-history directory.

Recording that session as six separate events would misstate it as six acquisitions.

## Decision

`sulai import <project> <path>...` records **one occurrence for one acquisition event, even when the
material chosen for it spans several roots.**

- **Roots are numbered in the order given:** `r1`, `r2`, and so on.
- **Every root is chosen explicitly.** There is no discovery of related locations and no following of
  references. A root is read because it was named, never because something mentions it.
- **All roots are checked before anything is captured.** A root that is missing, is a link, is neither
  a file nor a directory, or lies inside the project store refuses the whole acquisition, and nothing
  is recorded. The v1 record cannot state that a named root was absent, and dropping one silently
  would misstate what was chosen. `partial` therefore keeps its meaning: an input found under a
  checked root could not be captured.
- **Overlapping roots are refused.** Nesting would record the same inputs twice. Roots are compared by
  real path, so a root named through a linked ancestor is still recognized. Directory roots are also
  compared by filesystem identity, and the walk stops if it meets another root's directory under a
  different path. Two paths that are hard links to one file are not an overlap: they are two inputs.
- **The project's own store is excluded** in whichever root contains it, as before.
- **Identical bytes under different roots are one artifact and separate entries.** Whether the
  acquisition added them is decided once for the whole event.
- **A root that cannot be listed once the walk has begun still stops the acquisition.** The artifacts
  already stored remain unreferenced, and no record is written.

The CLI reports `roots` as a list, and each skipped or excluded item names its root.

## Consequences

One real session's work surface is one event. Tested on six real roots, the acquisition recorded
2,465 entries and every root's file count matched the disk. Of 771 artifacts, 429 appeared under more
than one root, so 231.8 MB read became 99.7 MB stored.

Choosing roots is still the user's job. Nothing here knows which directories belong to a session,
and that knowledge would be provider interpretation, which stays out of acquisition.

## Alternatives considered

**One occurrence per root.** Rejected: one event would read as several, with nothing linking them.

**Recording a missing root inside the occurrence.** Not possible in the v1 format without changing
it, and a root that cannot be read at the start is better refused than half-recorded.

**Allowing overlap and deduplicating by path.** Rejected: which root an input belongs to would depend
on argument order, and an input would appear under two roots.
