# ADR 0008: A kept citation keeps its evidence

Status: Accepted. Changes how `sulai state record` behaves; the storage format is unchanged.

## Context

A citation names a path and a line range within one occurrence. When a page is carried forward and
recorded against a newer acquisition, each citation it keeps is resolved again. If its file changed
above the cited lines, the citation still resolves, but to different text, and `inspect` still
passes, because the new revision is consistent with its own occurrence. Using Sulai on its own
development hit this repeatedly: one edit near the top of a file silently retargeted every citation
below it.

Recording also needed a file on disk for the page. A project had to hold a state document even when
an agent wrote the page and nobody wanted it in the project.

## Decision

- **A kept citation must still cite the same text.** When a revision has a parent, every citation
  the page keeps from that parent, and that resolved there, is compared: the bytes it cited then
  against the bytes it cites now. If any now cites different text, or no longer resolves, recording
  is refused and the refusal names each citation and its page lines. Nothing is written.
- **Recording anyway is explicit.** `--allow-changed-citations` records the revision, and the result
  lists the changed citations as `changedCitations`, so the choice stays visible.
- **The comparison is by bytes, streamed.** The same text in a changed file is not a change.
- **The page need not be a file.** It can be given on standard input as `-`, or as bytes through
  the library, so a project needs no state file of its own.

## Consequences

Carrying a page forward can no longer silently change what its citations point at. The check reads
only the kept citations whose artifact or range changed; the rest cost nothing.

It does not make citations stable across edits. A person or an agent still has to correct them.
Citations that survive edits remain a later question for the format.

## Alternatives considered

**Keeping the check in project tooling.** Rejected: any project that carries a page forward meets
the problem, so the check belongs where pages are recorded.

**Retargeting automatically by finding the old text.** Rejected: moved text can carry a new meaning
in its new place, and Sulai never retargets a reference.

**Refusing with no override.** Rejected: a file can change on purpose, and whoever records the page
may mean the new text.
