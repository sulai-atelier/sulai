# Roadmap

Sulai aims to keep a project that people and AI systems work on together
understandable and continuable: where it stands now, how it got there, and the
evidence for each part. This roadmap describes direction, not dates or a
commitment to a particular implementation.

## Now: real use

Preservation, acquisition records and state revisions exist; see the
[README](README.md#status). The next evidence has to come from using them on real
projects. For now this is a working procedure that people and agents follow.
Sulai automates none of it:

- A state page is maintained from its previous revision, as part of the work, and
  only when the project's state actually changed. A page regenerated from scratch
  rewords most of its lines, so `diff` would show change where there was none.
- It is read when a task needs the project's wider context, not handed to every
  task. Self-contained code tasks gained nothing from it.
- A project keeps one line of revisions, so that forks do not arise yet.
- When a revision carries a citation forward to a new acquisition, whoever records
  it checks that the citation still points at the same bytes.

The question is whether this removes work: context nobody had to reconstruct,
stale assumptions caught before they did damage. And what keeping the page
current costs.

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
