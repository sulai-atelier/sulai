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

## Now: the smallest practical status primitive

A pilot on Sulai's own development, with its evaluation fixed in advance, asked
whether Sulai can keep a small, useful picture of where a project stands, rebuilt
from the project's observable work, without the user maintaining it and without
claiming objective truth. It passed both of its stages on that one project. A page
rebuilt from evidence held up against a hand-kept one and caught drift the
hand-kept one missed. As a handoff for one real task it did at least as well, with
less unnecessary change. That is one project and one task, not evidence that the
approach works in general.

State revisions are the smallest primitive built to reproduce that value. Sulai
does not write the page or judge it; it records the page and exactly what the page
cites. Structured items, semantic diff and merge are left out until use shows a
need. See [ADR 0007](docs/adr/0007-state-revisions-record-a-view-and-its-evidence.md).

The pilot did not classify who said or decided something. Speaker and authorship
are not the axis that determines project state.

## Later

- **A second source.** Still important, but no longer next. Its job is to test
  whether a state model learned on one project holds when the evidence has a very
  different structure. Official provider exports remain the intended path.
- **Divergent work.** Comparing independently evolved work, and surfacing conflicts
  that matter without manufacturing agreement, remains part of the direction. Its
  design waits on the first status primitive.
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
