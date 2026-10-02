# ADR 0011: Orientation checks the state before serving it

Status: Accepted. Adds `sulai orient` and `sulai record`; the storage format is unchanged.

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

- **`sulai orient <directory>` observes, checks, then serves.** It acquires the roots the head
  revision was recorded against, or, before any revision, the project itself: the commit at HEAD
  when the project is a Git repository, otherwise its folder. It resolves every citation on each
  head's page against that observation and returns each head with its page and:
  - `changed`: each citation that resolved before and now resolves to different bytes, or not at
    all, with the text it cited and the text there now;
  - `uncommitted`: each citation into a file Git reports as changed but not committed, which the
    commit cannot speak for;
  - `unresolved`: the citations that did not resolve when the revision was recorded.
- **Nothing is decided or repaired.** No citation is retargeted and no revision is written. Sulai
  says which recorded evidence no longer matches; what the change means is for the reader. The
  observation is recorded as an occurrence, so what was compared can be inspected afterwards.
- **`sulai record <directory> <page|->` records against a fresh observation** of the same roots. The
  parent is the one head; with several, it must be named with `--parent`. The check of ADR 0008
  applies unchanged.
- **In a Git project the evidence is the commit.** A citation into a file with uncommitted changes
  would resolve against committed text the writer may not have read, so `record` refuses it unless
  `--allow-uncommitted` is given. The working tree is never captured.
- **The store stays out of the project's history.** `init` writes `.sulai/.gitignore` holding `*`,
  so an agent that commits everything does not commit the store. It is not part of the format.
- **Each output names the next step,** so an agent needs no instructions beyond the commands.

## Consequences

On one line of revisions, an agent keeps a project's state with `init`, `orient` and `record`, and
handles no identifiers. A change made outside its session that moves cited evidence is listed the
next time anyone orients, before the page is relied on, whoever made the change.

Each orientation records an occurrence. Unchanged files are stored once, but each occurrence lists
every captured path, so the store grows by one listing per orientation.

An agent must commit what it cites. If that proves to be real friction, capturing the working tree is
the alternative below.

A page that keeps citing a changed line, because its claim was rewritten to match the new text,
still needs `--allow-changed-citations`, and the flag covers the whole page rather than one citation.

## Alternatives considered

**Checking only when recording.** Rejected: it misses the case that matters, a stale state read and
acted on before anything new is recorded.

**Capturing the working tree.** It would let an agent cite uncommitted work. Deferred: it needs a new
kind of root, with rules for ignored and generated files, and so a format change. It should follow a
real case where committing first costs too much.

**Repairing moved citations by finding the old text.** Rejected for the reasons in ADR 0008.

**Observing without recording.** It would keep the store from growing, but the comparison would rest
on bytes that can no longer be inspected.

**A server or editor integration.** Not needed yet: a command that prints JSON works with any agent
that can run one.
