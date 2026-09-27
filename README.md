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
own package and behind an `experimental` command (see below). Nothing above source
preservation is implemented: Sulai does not yet derive project changes or project
state from what it preserves.

Foundation work is paused at storage format version 3; see [Direction](#direction).

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

A pilot on Sulai's own development, with its evaluation fixed in advance, asked
whether a small, evidence-backed picture of where a project stands can be rebuilt
from its observable work, without the user maintaining it and without claiming
objective truth. It passed both of its stages on that one project. That is one
project, not evidence that the approach works in general.

The next work is the smallest practical project-state primitive that can reproduce
that value: show where a project stands, each part traceable to its evidence. Its
internal representation is still open and will be earned from implementation and
further use.

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
and record each acquisition as an occurrence. ADR 0002 separated source, derived
meaning, and accepted state; its accepted-state layer has since been retired, as
the ADR records.

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
