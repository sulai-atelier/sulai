# Roadmap

Sulai aims to keep a project that people and AI systems work on together
understandable and continuable: where it stands now, how it got there, and the
evidence for each part. This roadmap describes direction, not dates or a
commitment to a particular implementation.

## Now: an agent can operate it

Using Sulai today means cloning and building it, preparing snapshots of a
project, and writing a state page with line citations by hand. That is too much
for anyone, developers included, and it is not the product. The engine exists;
what is missing is a front door that an AI agent already working on a project
can use, so that the person never handles snapshots, roots, identifiers or
citation syntax, and only asks where the project stands, what changed, and why.

The work, in order:

- **Kept citations keep their evidence.** Recording refuses a page whose kept
  citations now point at different text. Done:
  [ADR 0008](docs/adr/0008-a-kept-citation-keeps-its-evidence.md).
- **No state file needed.** A page can be recorded from standard input. Done.
- **Git-aware capture.** For a Git repository, `import --git` captures the
  tracked files of the commit at HEAD, and records that commit, instead of
  copying the working folder with its dependencies and build output. Done:
  [ADR 0009](docs/adr/0009-git-acquisition-records-a-commit.md).
- **The local flow, end to end.** An agent sets up Sulai in an ordinary project,
  keeps its state as it works, and answers from it, with no Sulai concepts
  handed to the person. The commands are in
  [ADR 0011](docs/adr/0011-orientation-checks-the-state-before-serving-it.md),
  and a Git project is observed as its working tree, so the agent never commits
  for Sulai: [ADR 0012](docs/adr/0012-a-git-working-tree-is-its-own-source.md).
  Done when an agent given no Sulai instructions keeps the state through a
  change made outside its session.
- **An installable pre-alpha.** A published CLI instead of a clone and a build.

Sulai itself does not call a model. The agent doing the work decides what
changed; Sulai captures, checks and records.

## Next: real use outside Sulai

Once an agent can operate Sulai this way, it goes to a few developers working
with coding agents on real projects. What gets built after that comes from the
friction that recurs across projects.

## Later, when real use shows the need

- **Stable citations.** References that keep pointing at the same evidence when
  files change between acquisitions.
- **Joining forks.** A way for divergent state histories to rejoin.
- **A second source.** Reading a very different kind of material, through
  official provider exports, to test whether the state model still holds.
- **Divergent work.** Comparing independently evolved work, and surfacing the
  conflicts that matter without manufacturing agreement.

The first two would change the storage format, so each should start from a real
case rather than a guess.

## Not planned

- Deciding whether claims are true, or scoring them.
- Ranking material by whether a person or a model wrote it.
- Requiring people to approve, tag or classify material by hand.
- Depending on hidden model reasoning.

## Discussing direction

Propose a concrete problem, relevant source constraints, and a way to evaluate the
result through [Discussions](https://github.com/sulai-atelier/sulai/discussions) or
a design issue. Accepted architectural decisions belong in [ADRs](docs/adr/).
The [governance policy](GOVERNANCE.md) describes who makes those decisions.
