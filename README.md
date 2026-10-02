# Sulai

[![CI](https://github.com/sulai-atelier/sulai/actions/workflows/ci.yml/badge.svg)](https://github.com/sulai-atelier/sulai/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Open-source version control for human + AI thinking.

Work on a project is spread across people, AI conversations, documents, and code.
Copying context between them loses history: what changed, where a claim came from,
what is still open, and how the project came to stand where it does. The
conversations are temporary; the project is not.

Sulai gives the project a durable, local history. It preserves the original
evidence exactly, and records versioned views of where the project stands. Each
citation on a view is resolved to exact preserved bytes, or recorded as unresolved
with a reason. Sulai checks the pointer, never the claim: it records what a view
cites, and does not decide whether the view is right.

## Status

Pre-alpha. Formats and APIs will change, and nothing here is production-ready.

What works:

- exact, content-addressed preservation of any files, with no size ceiling
- a record of each acquisition: what was read, what each input became, and what
  could not be captured and why
- several files or directories imported as one acquisition, without following links
- a Git repository's committed files, read from the commit at HEAD rather than the
  working folder, with the commit recorded
- a Git repository's working tree as it is, committed or not: the files Git tracks
  and the untracked ones it does not ignore, with HEAD recorded as provenance
- versioned state pages, each citation resolved to exact preserved bytes or
  recorded as unresolved
- `status`, `why` and `diff` over those pages
- `orient` and `record`, for the agent keeping a project's state: the state is
  checked against the project as it is now before it is shown, and the next page
  is recorded with no identifiers to copy
- integrity checks from each state revision down to the bytes it cites

Not built yet:

- writing or updating state pages automatically
- joining divergent state histories
- integrations with AI providers or tools, beyond one experimental reader
- sync, hosting, or collaboration

Everything runs locally. The CLI sends nothing over the network, and Git capture
never fetches.

## Quick start

Sulai needs Node.js 24.21 or a later 24.x release, and npm 11.

```sh
npm ci --ignore-scripts
npm run build
```

Create a project and preserve some evidence:

```sh
npm run cli -- init .tmp/example
npm run cli -- import .tmp/example fixtures/synthetic.conversation.jsonl
```

`import` prints an occurrence, the record of that acquisition, with its ID. Next,
create `.tmp/STATE.md`, a page saying where the project stands. It cites evidence
as code spans: `r1#L2` is line 2 of the occurrence's first root.

```markdown
# State

- The first message names the project `r1#L2`
```

Record the page against the occurrence, then read it back:

```sh
npm run cli -- state record .tmp/example .tmp/STATE.md --from OCCURRENCE_ID
npm run cli -- status .tmp/example
npm run cli -- why .tmp/example STATE_ID 3
npm run cli -- inspect .tmp/example
```

`why` prints the exact bytes behind line 3 of the page. `inspect` verifies every
artifact, occurrence and state revision against its identity. Commands print JSON
and exit with status 1 on failure; an import that could not capture every input
still records what it did and exits with status 3. `npm run cli -- --help` lists
every command.

To capture a Git repository's committed files rather than a folder, name it with
`--git`. This reads the commit the clone has checked out, not its working folder,
and refuses while the working tree differs from that commit. To capture the
working tree as it is instead, name it with `--worktree`:

```sh
npm run cli -- import .tmp/example --git .
npm run cli -- import .tmp/example --worktree .
```

### Keeping a project's state as its agent

The commands above show the records. An agent working in a project needs only
three, and never handles an identifier:

```sh
npm run cli -- init ../my-project
npm run cli -- orient ../my-project
npm run cli -- record ../my-project
```

`orient` observes the project as it is, the working tree for a Git repository, and
prints where it stands: each current page, and every citation whose evidence has
changed since the page was recorded, with the text it cited and the text there
now. It does not decide what the change means or repair anything. It keeps the
current page in `.sulai/draft.md`, where the agent edits it, citing each claim's
evidence in backticks after it:

```markdown
Lists sort by date. `r1/src/config.js#L3`
```

`record` saves the draft as the next page, against the project as it is then, so
nothing needs committing first. Both print what to do next.

## How it works

Sulai keeps three kinds of record, each identified by the SHA-256 of its bytes and
never rewritten:

| Record             | What it holds                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Artifact**       | exact bytes, stored once however often they are imported                                                             |
| **Occurrence**     | one acquisition: the roots it read, the artifact each input became, and what it could not capture and why            |
| **State revision** | a page saying where the project stands, its parent, and every citation resolved to a byte range or marked unresolved |

Preservation and interpretation are separate. `import` stores bytes without
reading them through any format, so material no current reader understands is
still kept exactly, and a later reader can derive from the original. Reading an
artifact as a conversation is a separate command, `interpret`, whose only stable
format today is a documented synthetic one.

The [architecture overview](docs/architecture.md) explains the model and its
boundaries. The [format specification](docs/format.md) defines every record.

## Principles

- Preserve original source, and keep everything derived from it traceable to it.
- Track how the project evolves, not who owned each thought. Human and AI
  reasoning mix, and Sulai does not try to split them.
- Do not judge truth. A state page is a recorded view, not a verdict.
- Keep history, including superseded work, conflicts and open questions.
- Cost less than it saves: never make people classify, approve or tag material
  by hand.

The [project principles](docs/principles.md) define these in full.

## Known limitations

- A state history that forks never rejoins, because a revision has one parent.
- A citation carried forward to a new acquisition can point at different bytes if
  its file changed above the cited lines. Recording refuses that for citations kept
  from the previous revision, but correcting them is still manual.
- A citation that resolves shows what a line points at, not that the line is right.
- Git capture reads the commit at HEAD or the working tree, and needs git 2.45 or
  later.
- People and agents write state pages; Sulai records and checks them.

## Documentation

- [Architecture](docs/architecture.md): records, boundaries and code layout
- [Format specification](docs/format.md): the exact encoding of every record
- [Principles](docs/principles.md): the design requirements
- [Decision records](docs/adr/): why the design is the way it is
- [Roadmap](ROADMAP.md): what is being worked on and what waits

## Experimental

`sulai experimental claude-code-session` reports the structure of a stored Claude
Code session transcript, never its message text. That file layout is another
product's internal detail, not a published format, so the command is unstable and
may be removed. See [its README](packages/experimental-claude-code/README.md).

## Contributing

Focused contributions, bug reports, synthetic test cases, and technical discussion
are welcome. Changes affecting persistent formats, provenance, or project-state
semantics need discussion first.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and review expectations,
[GOVERNANCE.md](GOVERNANCE.md) for decision-making, and the
[Code of Conduct](CODE_OF_CONDUCT.md) for community standards.

## Security

See [SECURITY.md](SECURITY.md) for private reporting and current security boundaries.

## License

Copyright 2026 Sulai contributors. Sulai is licensed under the
[Apache License 2.0](LICENSE).
