# Roadmap

Sulai aims to keep a project that people and AI systems work on together
understandable and continuable: where it stands now, how it got there, and the
evidence for each part. This roadmap describes intended outcomes, not release
dates or a commitment to a particular implementation.

## Current foundation

The repository provides immutable byte artifacts, deterministic source references,
and a local CLI whose storage is independent of any artifact format. Import
preserves arbitrary exact bytes, inspection verifies identity without parsing, and
interpretation is a separate command that today understands only a synthetic
conversation format. Each import records an occurrence: which inputs were attempted,
which exact bytes each became, and what could not be captured and why. One
occurrence can hold several roots. An experimental, unstable reader reports the
structure of Claude Code local session transcripts.

State revisions sit on top: a page saying where a project stands, each reference
on it resolved to exact preserved bytes or marked unresolved, with `status`,
`why` and `diff` to read them. Storage is at format version 4.

Two limits of the format are known. A fork never rejoins, because a revision has
one parent. A citation recorded against a new acquisition can point at different
bytes if the file was edited above the cited lines.

## How we got here

A pilot on Sulai's own development asked whether Sulai can keep a small, useful
picture of where a project stands, rebuilt from the project's observable work,
without the user maintaining it and without claiming objective truth. It passed on
that one project: a page rebuilt from evidence caught drift that a hand-kept one
missed. State revisions were built to record such a page. Sulai does not write the
page or judge it; it records the page and exactly what the page cites. See
[ADR 0007](docs/adr/0007-state-revisions-record-a-view-and-its-evidence.md).

Internal trials of that primitive, each with its evaluation fixed in advance,
showed:

- **Pointer integrity is not support.** Every citation on a page can resolve while
  some lines are not supported by what they cite. A producer that checked each line
  against its exact evidence and repaired it reached full support on one run.
- **Regenerating state makes `diff` noisy.** On unchanged evidence, a page written
  from scratch reworded most of its lines. A page updated from its previous revision
  changed none of them, and cost far less to produce.
- **Injected state did not help local tasks.** For two self-contained code fixes,
  an agent given the state page did no better than one given the repository and
  ordinary notes. Neither needed the project's wider context.

These cover one project, and the trials used private project material, so their
data is not published here.

## Now: use it on real work

The next evidence has to come from real use, not more trials. The working model:

- The state page is maintained from its previous revision, as part of the work,
  and only when the project's state actually changed.
- It is read when a task needs project context, and not handed to every task.
- A project keeps one line of revisions, so that forks do not arise yet.
- When a revision carries a citation forward to a new acquisition, the citation
  is checked for whether it still points at the same bytes.

What is measured is whether this removes work: context nobody had to reconstruct,
stale assumptions caught, and what keeping the page current cost.

## Later

These wait until real use shows the need:

- **Joining forks and stable citations.** Both known limits would need a format
  change, and that should come from a real case.
- **A second source.** Its job is to test whether a state model learned on one
  project holds when the evidence has a very different structure. Official
  provider exports remain the intended path.
- **Divergent work.** Comparing independently evolved work, and surfacing conflicts
  that matter without manufacturing agreement, remains part of the direction.
- **The experimental Claude Code reader** stays as it is: kept, not extended,
  until a concrete need requires more from it.

Each step should be validated with concrete cases before the next abstraction is
fixed. Benchmarks should publish reproducible methodology and data that is safe
and permitted to share; repository fixtures remain synthetic.

## Earlier sequence

Until September 2026 this roadmap followed this sequence, kept here as it was:

1. **Source preservation.** Harden exact-byte storage, source resolution, and
   portability. Keep raw persistence independent of provider interpretations.
2. **Provenance-aware imports.** Distinguish the identity of raw content from the
   circumstances of its acquisition. Preserve original inputs and document how
   structural interpretations map back to them.
3. **Provider adapters.** Investigate current export formats, implement one adapter,
   and validate its preservation and mapping behavior before adding another.
   Independently developed ChatGPT and Claude histories are the initial use case.
4. **Semantic objects.** Represent source-backed findings, decisions, assumptions,
   evidence, and open questions without implicitly accepting model output.
5. **Reconciliation and review.** Compare independently evolved work, distinguish
   agreement and refinement from genuine conflict, and let people review proposed
   changes against their sources.
6. **Versioned project state.** Record explicit acceptance and retain enough history
   to reconstruct, compare, and continue a project's evolving state.

The first two are what the current foundation implements.

The rest was set aside for two reasons. Provider adapters were no longer the most
useful next step: the question of whether Sulai can represent where one project
stands comes first, and a second source is more valuable as a test of that answer.
And the explicit-acceptance model, in which a project's state is whatever someone
with authority has accepted, was retired. Human and AI reasoning mix and cannot be
cleanly split by who contributed what, so Sulai tracks how the project evolves
rather than who owns each thought. See
[ADR 0002](docs/adr/0002-source-meaning-state-separation.md).

Replaying history as context was also tried and set aside. Early internal trials
that packed reconstructed history into a new session did not meet the bars set for
them in advance, and that approach is stopped. The trials used private project
material, so their data is not published here.

## Discussing direction

Propose a concrete problem, relevant source constraints, and a way to evaluate the
result through [Discussions](https://github.com/sulai-atelier/sulai/discussions) or
a design issue. Accepted architectural decisions belong in [ADRs](docs/adr/).
The [governance policy](GOVERNANCE.md) describes who makes those decisions.
