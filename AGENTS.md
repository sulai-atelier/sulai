# Coding agent instructions

Sulai preserves the evolving semantic state of human and AI projects. This
repository is an early foundation for infrastructure, not a generic chat app.

Read [docs/principles.md](docs/principles.md) for the canonical product invariants,
[CONTRIBUTING.md](CONTRIBUTING.md) for review and public-documentation rules, and
[GOVERNANCE.md](GOVERNANCE.md) for decision authority and history policy before
making changes. Apply those rules to code, documentation, issues, and commits.

## Working rules

- Inspect existing code and instructions before editing. Preserve unrelated work.
- Keep the core independent of the CLI. Prefer Node built-ins; justify dependencies.
- Treat files and deserialized values as untrusted. Validate before persisting or
  resolving references. Never normalize stored raw bytes.
- Use strict TypeScript, explicit byte coordinate conventions, and deterministic
  identities. Do not use timestamps or randomness in content identity.
- Test observable invariants, including malformed input and exact byte round trips.
  Use synthetic fixtures only; never commit real conversation exports or secrets.
- Keep docs, names, comments, and commits concise and suitable for public review.
  Do not put private planning or conversations in the repository. Record accepted
  architectural decisions in ADRs, not unresolved research. Avoid speculative abstractions.
- Scope this foundation to source artifacts, references, and local import/inspect.
  Semantic extraction, reconciliation, accepted state, and hosted features need
  separate designs and requests. Do not silently expand scope.
- Before handoff, run `npm run format`, `npm run lint`, `npm run typecheck`, and
  `npm test`; inspect the diff and report results and remaining limitations.
- Do not describe this foundation as production-ready. Keep commits focused when
  commits are requested; do not publish packages or deploy without authorization.
- Verify the intended author, committer, and authenticated account before committing
  or pushing. Git authentication does not determine commit authorship.
- Inspect remote history before pushing. A history rewrite or visibility change
  requires explicit authorization; never infer it from a request to edit files.
