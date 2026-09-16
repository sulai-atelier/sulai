# Sulai

Open-source version control for human + AI thinking.

AI-assisted work is spread across conversations, models, documents, and people.
Copying context between them loses history: what changed, what was rejected,
where a claim came from, and why a decision became current.

Sulai is being built to preserve that history and turn fragmented work into a
traceable, versioned project state. The project, not the chat, is the durable unit.

## Status

Sulai is pre-alpha. The repository implements the source-preservation foundation:
immutable content-addressed artifacts, byte-precise source references, and
format-independent integrity-checked local storage. Storage accepts exact bytes
of any kind; reading them through a format is a separate, named operation, and
the only reader today is a synthetic conversation format. Provider imports,
import-occurrence provenance, and reconciliation are future work.

The APIs and project format are evolving. This is not a production-ready release.

## Principles

- Preserve original source; keep derived meaning traceable to it.
- Require explicit acceptance; distinguish model consensus from evidentiary support.
- Preserve history, including superseded work and unresolved conflicts.
- Make project-state changes versioned, reviewable, reconstructable, and portable.
- Remain model-neutral, without relying on hidden model chain-of-thought.

The [project principles](docs/principles.md) define these requirements in full.

## Direction

Sulai is being developed toward workflows where independently evolved work, such
as separate ChatGPT and Claude project histories, can be imported, compared,
reconciled, reviewed, and continued as one versioned project.

The next focus is provenance-aware imports and provider adapters. See the
[public roadmap](ROADMAP.md) for the intended sequence and scope.

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

The import prints an artifact ID. `inspect` verifies stored identity without
parsing anything. To read that artifact through the conversation format, and see
its decoded messages, source units and exact raw records, substitute the ID for
`ARTIFACT_ID`:

```sh
npm run cli -- interpret .tmp/example ARTIFACT_ID
```

**Import preserves; it does not interpret.** Storing exact bytes performs no
format validation, so material that no current reader understands is still kept
faithfully and a later reader can re-derive from the untouched original. That is
why `interpret` is a separate command, and why it can fail on bytes that were
stored successfully without affecting them. See
[ADR 0003](docs/adr/0003-storage-is-independent-of-artifact-format.md).

Commands emit JSON; failures go to stderr with exit code 1. Reimporting identical
bytes reuses the artifact. Initialization and import never replace existing
stored content. Inspection checks the stored content against its identity.

Storage accepts any bytes. The only **interpreter** is the documented
[synthetic conversation format](docs/source-format.md), exercised by
[the synthetic fixture](fixtures/synthetic.conversation.jsonl). No data is sent to
a model or external service by the CLI.

## Architecture and specifications

The core library lives in `packages/core`; local persistence and the CLI live in
`packages/cli`. Neither has third-party runtime dependencies. Packages are not
published to npm yet.

[Source identity and storage conventions](docs/source-format.md) describe the
current format. The [foundational ADRs](docs/adr/) record the decisions to preserve
immutable raw artifacts and separate source, derived meaning, and accepted state.

## Contributing

Focused contributions, bug reports, synthetic test cases, and technical discussion
are welcome. Changes affecting persistent formats, provenance, authority, or
project-state semantics require deliberate review.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and review expectations,
[GOVERNANCE.md](GOVERNANCE.md) for decision-making, and the
[Code of Conduct](CODE_OF_CONDUCT.md) for community standards.

## Security

See [SECURITY.md](SECURITY.md) for private reporting and current security boundaries.

## License

Copyright 2026 Sulai contributors. Sulai is licensed under the
[Apache License 2.0](LICENSE).
