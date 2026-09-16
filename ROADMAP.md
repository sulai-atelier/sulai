# Roadmap

Sulai aims to make independently evolved human and AI work reviewable as one
traceable, versioned project. This roadmap describes intended outcomes, not release
dates or a commitment to a particular implementation.

## Current foundation

The repository provides immutable byte artifacts, deterministic source references,
and a local CLI whose storage is independent of any artifact format. Import
preserves arbitrary exact bytes, inspection verifies identity without parsing, and
interpretation is a separate command that today understands only a synthetic
conversation format. It is a reference foundation, not yet a general
provider-import or project-state system, and it records no import occurrence: how
material entered a project is not yet represented.

## Intended sequence

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

Each stage should be validated with concrete cases before the next abstraction is
fixed. Benchmarks should publish reproducible methodology and data that is safe
and permitted to share; repository fixtures remain synthetic.

## Discussing direction

Propose a concrete problem, relevant source constraints, and a way to evaluate the
result through [Discussions](https://github.com/sulai-atelier/sulai/discussions) or
a design issue. Accepted architectural decisions belong in [ADRs](docs/adr/).
The [governance policy](GOVERNANCE.md) describes who makes those decisions.
