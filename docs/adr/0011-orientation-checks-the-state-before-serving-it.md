# ADR 0011: Orientation checks the state before serving it

Status: Accepted. Adds `sulai orient` and `sulai record`. What they observe in a Git project is
[ADR 0012](0012-a-git-working-tree-is-its-own-source.md).

## Context

The engine can record state, but using it took someone who knows its concepts: import the right
roots, copy an occurrence ID into `state record`, name a parent. Sulai is meant to be kept by the
agent already working on a project, with nobody writing an occurrence ID, a revision ID, a root name
or a state file.

The check on kept citations ([ADR 0008](0008-a-kept-citation-keeps-its-evidence.md)) also runs only
when a revision is recorded. If someone else changes the project between sessions, an agent that
reads the state with `status` gets a page whose citations look as sound as the day they were
recorded. Nothing says the evidence under them moved until a new revision is recorded, which is after
the agent has already relied on the old one. The check has to happen before the state is served.

## Decision

- **`sulai orient <directory>` observes, checks, then serves.** It observes the project as it is
  now: the roots the head revision was recorded against, or, before any revision, the project
  itself, a Git repository's working tree (ADR 0012) or otherwise its folder. It resolves every
  citation on each head's page against that observation and returns each head with its page and:
  - `changed`: each citation that resolved before and now resolves to different bytes, or not at
    all, with the text it cited and the text there now;
  - `unresolved`: the citations that did not resolve when the revision was recorded.
- **Nothing is decided or repaired.** No citation is retargeted and no revision is written. Sulai
  says which recorded evidence no longer matches; what the change means is for the reader. The
  observation is recorded as an occurrence, so what was compared can be inspected afterwards.
- **`sulai record <directory> <page|->` records against a fresh observation** of the same roots. The
  parent is the one head; with several, it must be named with `--parent`. The check of ADR 0008
  applies unchanged. A locator written without its backticks is refused: a page records only code
  spans as citations, so it would be recorded as plain text, citing nothing.
- **The store stays out of the project's history, and says how to read it.** `init` writes
  `.sulai/.gitignore` holding `*`, so an agent that commits everything does not commit the store,
  and `.sulai/README.md`, which tells an agent that finds the store to read it through
  `sulai orient`. An agent that reads the store's files directly gets the state unchecked and never
  learns there is a command. Neither file is part of the format.
- **`init` and `orient` name the next step,** so an agent needs no instructions beyond the
  commands. `status`, which prints the state as recorded without observing anything, says that it
  is unchecked and that `orient` checks it.

## Consequences

On one line of revisions, an agent keeps a project's state with `init`, `orient` and `record`, and
handles no identifiers. A change made outside its session that moves cited evidence is listed the
next time anyone orients, before the page is relied on, whoever made the change.

Each orientation records an occurrence. Unchanged files are stored once, but each occurrence lists
every captured path, so the store grows by one listing per orientation.

A page that keeps citing a changed line, because its claim was rewritten to match the new text,
still needs `--allow-changed-citations`, and the flag covers the whole page rather than one citation.

## Alternatives considered

**Checking only when recording.** Rejected: it misses the case that matters, a stale state read and
acted on before anything new is recorded.

**Taking a Git project's evidence from the commit at HEAD.** Tried first, and replaced by ADR 0012:
an agent's work is uncommitted until someone commits it, so the agent had to commit unasked or stop
and ask before its state could cite what it had read.

**Repairing moved citations by finding the old text.** Rejected for the reasons in ADR 0008.

**Observing without recording.** It would keep the store from growing, but the comparison would rest
on bytes that can no longer be inspected.

**A server or editor integration.** Not needed yet: a command that prints JSON works with any agent
that can run one.
