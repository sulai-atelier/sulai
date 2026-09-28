# Sulai

Open-source version control for human + AI thinking.

AI-assisted work is spread across conversations, models, documents, and people.
Copying context between them loses history: what changed, what was rejected,
where a claim came from, and why a decision became current.

Sulai is being built to preserve that history and turn fragmented work into a
traceable, versioned project state. The project, not the chat, is the durable unit.

## Status

Sulai is pre-alpha. The repository implements the source-preservation foundation:
immutable content-addressed artifacts, byte-precise source references,
format-independent integrity-checked local storage, and import occurrences that
record each acquisition as its own event, including several roots at once. Storage
accepts exact bytes of any kind; reading them through a format is a separate, named
operation. The only stable reader is a synthetic conversation format. An
experimental reader for Claude Code local session transcripts also ships, in its
own package and behind an `experimental` command (see below).

Above that foundation, Sulai records **state revisions**: a page saying where a
project stands, with each reference on it resolved to exact preserved bytes or
marked unresolved. Sulai checks the pointer, never the claim. It does not write the
page or judge it. Storage is at format version 4.

The APIs and project format are evolving. This is not a production-ready release.

## Principles

- Preserve original source; keep everything derived from it traceable to it.
- Track how the project evolves, not who owned each thought. Human and AI
  reasoning mix, and Sulai does not try to split them.
- Do not judge truth. Project state is what Sulai can reconstruct from evidence,
  not an objective verdict; consensus is not evidentiary support.
- Preserve history, including superseded work, unresolved conflicts, and
  uncertainty.
- Cost users less effort than the coordination it saves them.
- Remain model-neutral, portable, and independent of hidden model chain-of-thought.

The [project principles](docs/principles.md) define these requirements in full.

## Direction

Sulai is being developed so that a project worked on across people, models,
tools, documents, and code stays understandable and continuable: where it stands
now, what is open, what changed, where its sources diverge, and the evidence for
each.

A pilot on Sulai's own development asked whether a small, evidence-backed picture
of where a project stands can be rebuilt from its observable work. It passed on
that one project. State revisions were then built to record such a picture:
`sulai status` shows where a project stands, `sulai why` the exact evidence behind
one line, and `sulai diff` how the page changed. See
[ADR 0007](docs/adr/0007-state-revisions-record-a-view-and-its-evidence.md).

Internal trials since then, each with its evaluation fixed in advance, changed the
direction:

- **A citation that resolves is not a citation that supports its line.** Sulai
  checks the pointer; whoever writes the page still has to check the claim.
- **State should be maintained, not regenerated.** A page rewritten from scratch
  on the same evidence reworded most of its lines, so `diff` showed change where
  there was none. A page updated from its previous revision did not.
- **State should be read when a task needs it.** On self-contained code tasks,
  handing an agent the state page gave no benefit.
- **The current format has two known limits.** A fork never rejoins, because a
  revision has one parent. A citation recorded against a new acquisition can point
  at different bytes if the file was edited above the cited lines.

The current work is using Sulai on real projects, not adding schema or adapters.
What gets built next depends on what that use shows. These trials cover one
project and are not evidence that the approach works in general.

Earlier versions of this README named provider adapters as the next focus. A
second source remains important, through official provider exports, but it is no
longer next. See the [public roadmap](ROADMAP.md) for the sequence and what
changed.

## Try the current foundation

Use Node.js 24.21.0 or a later 24.x release and npm 11. The repository pins the
development runtime in `.node-version`.

```sh
npm ci --ignore-scripts
npm run build
npm run cli -- init .tmp/example
npm run cli -- import .tmp/example fixtures/synthetic.conversation.jsonl
npm run cli -- inspect .tmp/example
```

The import prints an occurrence: the record of that acquisition, with how many
inputs it captured, how many of their byte sequences were new to the store, and
anything it could not capture. `import` also takes directories, and several paths
at once as one acquisition; it walks them without following links. `inspect` verifies every stored artifact and occurrence
without parsing any artifact, and lists the artifact IDs. To read the artifact
through the conversation format, and see its decoded messages, source units and
exact raw records, substitute its ID for `ARTIFACT_ID`:

```sh
npm run cli -- interpret .tmp/example ARTIFACT_ID
```

To record where the project stands, write a page, say `.tmp/STATE.md`, whose lines
cite evidence as code spans such as `r1#L2`: line 2 of the occurrence's first root.
Record it against the occurrence the import printed, then read it back:

```sh
npm run cli -- state record .tmp/example .tmp/STATE.md --from OCCURRENCE_ID
npm run cli -- status .tmp/example
npm run cli -- why .tmp/example STATE_ID 1
```

**Import preserves; it does not interpret.** Storing exact bytes performs no
format validation, so material that no current reader understands is still kept
faithfully and a later reader can re-derive from the untouched original. That is
why `interpret` is a separate command, and why it can fail on bytes that were
stored successfully without affecting them. See
[ADR 0003](docs/adr/0003-storage-is-independent-of-artifact-format.md).

Commands emit JSON; failures go to stderr with exit code 1. An import that could
not capture everything still records what it did and exits with code 3. Reimporting
identical bytes reuses the artifact and records a new occurrence. Initialization
and import never replace existing stored content. Inspection checks the stored
content against its identity. See
[ADR 0005](docs/adr/0005-import-occurrences-record-acquisition-events.md).

Storage accepts any bytes. The only stable **interpreter** is the documented
[synthetic conversation format](docs/source-format.md), exercised by
[the synthetic fixture](fixtures/synthetic.conversation.jsonl). No data is sent to
a model or external service by the CLI.

`sulai experimental claude-code-session <directory> <artifact-id>` reads a stored
Claude Code local session transcript and reports its structure only, never its
message text. That file layout is another product's internal detail, not a
published format, so the command is unstable and may be removed. See
[its package README](packages/experimental-claude-code/README.md).

## Architecture and specifications

The core library lives in `packages/core`; local persistence and the CLI live in
`packages/cli`. The experimental Claude Code reader lives in
`packages/experimental-claude-code`; the CLI depends on it, and core cannot import
it. None has third-party runtime dependencies. Packages are not published to npm
yet.

[Source identity and storage conventions](docs/source-format.md) describe the
current format. The [ADRs](docs/adr/) record the decisions to preserve immutable
raw artifacts, keep storage independent of artifact format, stream preservation,
record each acquisition as an occurrence, and record state revisions against it.
ADR 0002 separated source, derived meaning, and accepted state; its accepted-state
layer has since been retired, as the ADR records.

## Contributing

Focused contributions, bug reports, synthetic test cases, and technical discussion
are welcome. Changes affecting persistent formats, provenance, or project-state
semantics require deliberate review.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and review expectations,
[GOVERNANCE.md](GOVERNANCE.md) for decision-making, and the
[Code of Conduct](CODE_OF_CONDUCT.md) for community standards.

## Security

See [SECURITY.md](SECURITY.md) for private reporting and current security boundaries.

## License

Copyright 2026 Sulai contributors. Sulai is licensed under the
[Apache License 2.0](LICENSE).
