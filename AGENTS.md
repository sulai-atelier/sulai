# Coding agent instructions

Sulai tracks how projects that people and AI systems work on together evolve.
This repository is an early foundation for infrastructure, not a generic chat app.

Before making changes, read [docs/architecture.md](docs/architecture.md) for how the
pieces fit, [docs/principles.md](docs/principles.md) for the design requirements,
[CONTRIBUTING.md](CONTRIBUTING.md) for review and documentation rules, and
[GOVERNANCE.md](GOVERNANCE.md) for decision authority. Apply those rules to code,
documentation, issues, and commits.

## Working rules

- Inspect existing code and instructions before editing. Preserve unrelated work.
- Keep the core independent of the CLI. Prefer Node built-ins; justify dependencies.
- Treat files and deserialized values as untrusted. Validate before persisting or
  resolving references. Never normalize stored raw bytes.
- Use strict TypeScript, explicit byte coordinate conventions, and deterministic
  identities. Do not use timestamps or randomness in content identity; an
  import occurrence is an event, and its nonce and times are event data only.
- Test observable invariants, including malformed input and exact byte round trips.
  Use synthetic fixtures only; never commit real conversation exports or secrets.
- Keep docs, names, comments, and commits concise and suitable for public review.
  Record accepted architectural decisions in ADRs, not unresolved research. Avoid
  speculative abstractions.
- Scope work to source artifacts, references, import occurrences, state revisions,
  and the local CLI commands. Acquisition reads only the roots a user names: never
  follow links, and never acquire a path because content refers to it. See
  [ADR 0005](docs/adr/0005-import-occurrences-record-acquisition-events.md).
  A state revision records a page and what it cites; it never certifies the page.
  See [ADR 0007](docs/adr/0007-state-revisions-record-a-view-and-its-evidence.md).
  Deriving state pages inside Sulai, semantic extraction, reconciliation, provider
  adapters, and hosted features need separate designs and requests. Do not
  silently expand scope.
- Storage is at format version 6; change it only when a request calls for it. The
  experimental Claude Code reader stays as it is: do not extend it or build on it
  without a request.
- Do not add a notion of who decided or who owns an idea. Accepted state and
  explicit acceptance were retired; see
  [ADR 0002](docs/adr/0002-source-meaning-state-separation.md).
- Storage never depends on an artifact format. Import preserves exact bytes and
  validates nothing; inspection verifies identity and interprets no artifact;
  interpretation is separate and may fail without affecting what was preserved.
  Do not reintroduce format knowledge into the storage or identity layer. See
  [ADR 0003](docs/adr/0003-storage-is-independent-of-artifact-format.md).
- Before handoff, run `npm run format`, `npm run lint`, `npm run typecheck`, and
  `npm test`; inspect the diff and report results and remaining limitations.
- Do not describe this foundation as production-ready. Do not publish packages,
  and do not rewrite published history.
