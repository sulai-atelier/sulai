# ADR 0013: The agent edits a draft Sulai keeps

Status: Accepted. Changes how `sulai orient` and `sulai record` behave; the storage format is
unchanged.

## Context

With [ADR 0011](0011-orientation-checks-the-state-before-serving-it.md) and
[ADR 0012](0012-a-git-working-tree-is-its-own-source.md), an agent keeps a project's state with no
help from a person and no commits. It still spends too much doing so. Most of that goes into getting
a page into `sulai record`: where to put the page so it does not become evidence, a page on
standard input that the agent's own shell refuses to pass, citations written without their
backticks and refused, and rewriting the page after each refusal. Starting before `sulai init` gives
a bare file-not-found error. None of this is about the evidence or the state; it is the interface.

## Decision

### The draft

- **`orient` keeps the next page in `.sulai/draft.md`,** inside the store, which `init` normally
  asks Git to ignore. `orient` and `record` never acquire the draft as project evidence. With one
  head, it holds that head's page; before any revision, it is empty.
  The agent edits it there with its ordinary file tools, changing only the lines that changed.
- **`sulai record <directory>` with no page records the draft.** A page given as a file or as `-`
  is recorded as before.
- **Beside the draft, `.sulai/draft.json` says which state it began from** and what Sulai last wrote
  into it, so Sulai can tell an edited draft from one it wrote itself.
- **Neither file is part of the format.** They remain mutable workspace for the agent, outside
  Sulai's persistent format: never project evidence for `orient` or `record`, never a record, and
  not checked by `inspect`.

### When the draft may change

- **`orient` never overwrites an edited draft.** It writes the draft only when there is none, or
  when the draft is exactly what Sulai last wrote, so it holds no one's work.
- **A draft begun from an earlier state is kept,** and `orient` says so, naming where it began.
  `record` refuses it unless the agent names the parent with `--parent`, so an old draft never
  silently continues a newer head.
- **With several heads, no draft is chosen for the agent.** `orient` writes none, and `record`
  without `--parent` refuses, as it does for a page.
- **A draft whose starting state is unknown,** because `draft.json` is missing or unreadable, is
  treated as begun from an unknown state: it is kept, and `record` needs `--parent`.
- **After a successful `record`,** the draft holds the page just recorded and begins from the new
  revision, ready for the next change. Recording a page from a file leaves an edited draft alone.
- **`record` refuses an empty draft, and a draft unchanged from the page it began from,** since
  either would record nothing the agent wrote.

### The rest of the front door

- **Citations are shown by example.** `--help` and `orient` show a whole line with its citation in
  backticks, such as ``Lists sort by date. `r1/src/config.js#L3` ``.
- **`orient` and `record` before `init`** refuse with a message that names `sulai init`.

## Consequences

An agent keeps the state with `orient`, edits to one file it already knows how to edit, and
`record`. It needs no page file of its own, no place for one, and no shell feature beyond running a
command. The draft is the one file in the store meant to be edited by hand, and the store's README
says so.

Nothing in the format or the records changes. A store written before this has no draft until the
next `orient`.

## Alternatives considered

**A page file in the project.** Rejected: it becomes evidence in a working-tree observation, and
agents moved it outside the project, which leaves files in the user's folders.

**Accepting citations without backticks.** Rejected: what counts as a citation is part of the
format, and existing pages would resolve differently.

**Letting `orient` always refresh the draft.** Rejected: it would destroy an agent's unrecorded work.
