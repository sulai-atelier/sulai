# Contributing

Sulai is early infrastructure work. Small changes with a clear problem,
bounded scope, and evidence are easier to review than speculative frameworks.
Read the [project principles](docs/principles.md),
[governance policy](GOVERNANCE.md), and [foundational ADRs](docs/adr/) first.
Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Start with the problem

Use the issue templates for bugs, design proposals, and importer requests.
For exploratory questions, use
[Discussions](https://github.com/sulai-atelier/sulai/discussions). Check for an
existing discussion before opening another. Security reports belong in the
private channels described in [SECURITY.md](SECURITY.md), not public issues.

Discuss substantial changes with a maintainer before investing in an implementation,
especially changes to persistent formats, source mappings, or acceptance semantics.
Agreement on a problem is not approval of every proposed implementation.

Submit a focused pull request explaining the problem, behavior change, validation,
and compatibility impact. Maintainers may request revisions, defer a proposal, or
decline it with an explanation. See [ROADMAP.md](ROADMAP.md) for project direction.

## Local checks

Use the Node 24 release in `.node-version` and npm 11. From the repository root:

```sh
npm ci --ignore-scripts
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
```

`typecheck` builds both packages and checks the tests. `test` builds the packages
and uses Node's built-in test runner with TypeScript support. Tests exercise the
built package boundary and run the compiled CLI in separate processes. Temporary
projects are isolated and removed after each test.

CI runs these checks on Linux, macOS, and Windows. Do not commit `dist`, dependency
directories, local project stores, or machine-specific tooling.

## Dependencies

npm workspaces and TypeScript project references are sufficient for two packages;
there is no separate monorepo orchestrator or bundler. Runtime code uses Node
built-ins, with the CLI depending only on the local core package.

Development dependencies have these purposes:

- `typescript` and `@types/node`: strict compilation and Node API declarations.
- `eslint`, `@eslint/js`, and `typescript-eslint`: JavaScript rules and TypeScript
  parsing/rules. TypeScript 6.0 is pinned within the installed linter's supported
  peer range; upgrading the compiler requires checking that compatibility.
- `prettier`: consistent formatting across code, configuration, and documentation.

Keep direct versions pinned and commit the lockfile. Justify new dependencies in
the change description. The current flat format is small enough to validate
explicitly without a schema library; expanding the format requires revisiting that
choice, not accumulating an ad hoc general-purpose parser.

## Review expectations

- Describe the concrete problem, resulting behavior, and validation performed.
- Preserve raw bytes and source identity semantics. Add deterministic regression
  cases for changed trust boundaries, identity rules, or storage behavior.
- Use synthetic fixtures exclusively. Never submit real conversation exports,
  private prompts, credentials, or private project data, including in issues.
- Discuss incompatible format changes and consequential architectural decisions
  before implementing them. Record accepted decisions in an ADR.
- Keep commits focused and descriptions factual. Do not mix formatting churn with
  unrelated behavior changes or imply that tests establish production readiness.
- Review all contributed code, including code produced with AI assistance. The
  contributor is responsible for its correctness, provenance, and licensing.

## Public documentation

The repository explains how Sulai works, how to use and evaluate it, and how the
project is governed. Before publishing text, ask whether it helps a user,
contributor, maintainer, auditor, integrator, or security researcher understand,
trust, use, modify, or govern the project.

Keep claims tied to implemented behavior or clearly identified future direction.
Explain technical tradeoffs and limitations candidly. Accepted architectural
decisions belong in ADRs; proposals seeking community input belong in a design
issue or RFC. Not every exploratory thought needs a public record.

Private conversations, personal or customer data, and internal company planning
do not belong in repository files, issues, comments, or commit messages. Keep
private material outside this repository, not in a nominally private subdirectory.
Use the [history policy](GOVERNANCE.md#publication-and-history) when correcting
published material.

## Contribution terms

Contributions use the ordinary Apache-2.0 contribution terms. Only submit material
you are entitled to share under that license. Identify third-party material and
preserve its required notices.

No CLA or DCO sign-off is required. Any change to contribution requirements must
be explicitly decided and documented before affected contributions are accepted.
