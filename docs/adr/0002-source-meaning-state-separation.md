# ADR 0002: Separate source, derived meaning, and accepted state

Status: Accepted. The accepted-state layer and its explicit-acceptance requirement
were retired on 2026-09-27; see [Later change](#later-change-2026-09-27). The
separation of preserved source from what is derived from it stands.

## Context

A source message, an extracted assertion, and a project's accepted decision have
different authority. Collapsing them would let extraction silently rewrite history
or promote AI output to an approved conclusion.

## Decision

Keep three conceptual layers distinct:

1. Raw artifacts and source references preserve the imported material exactly.
2. Derived semantic objects represent interpretations and must identify exact
   supporting source material and how they were derived. They are not authoritative
   or human-approved by default.
3. Accepted project state records explicit acceptance and must be versioned and
   reconstructable from recorded history. Superseded material remains traceable.

Model consensus and evidentiary support must remain separate concepts. Conflicts
may remain unresolved. A future merge must expose its proposed changes and their
sources for review; merging must not imply agreement or approval.

None of these layers requires hidden model chain-of-thought. Future derivation
records may retain observable inputs, outputs, and method metadata, without
claiming access to private reasoning.

## Consequences

This foundation implements only artifacts, structural source references, and a parser
view of messages. A parsed `role` is a label supplied by the source format; it does
not confer authority. There is no extracted assertion, approval flag, accepted
state object, event log, or semantic version history in this implementation.

Future work must define the smallest semantic and acceptance schemas needed for a
concrete workflow, including provenance through intermediate derivations. This ADR
does not prescribe event sourcing, a database, a graph framework, or a merge
algorithm. Data portability remains a requirement across those choices.

## Alternatives considered

A single mutable project summary would hide which source or acceptance produced
each change. Treating extracted model output as current state would erase the
distinction between observation, interpretation, and explicit acceptance.

## Later change (2026-09-27)

The text above is kept as it was accepted. One part of it no longer describes the
project's direction.

The third layer, accepted project state established by explicit acceptance, is
retired, together with the framing that source, derivation, and state differ by
authority. Human and AI reasoning mix in real work and cannot be cleanly divided
by who contributed what. Sulai tracks how the project evolves, not the ownership
of thoughts. Project state is what Sulai can reconstruct from preserved evidence
about where a project stands: what is current, open, changed, or divergent. It is
not established by an acceptance act or by who said something, and it is not a
claim of objective truth. If a source names who wrote something, those bytes are
preserved like any others; they are not what determines project state.

What still holds: raw source is preserved exactly, derived material must identify
its supporting source and how it was derived, derived material is not true or
current by default, model consensus and evidentiary support remain separate,
superseded material and unresolved conflicts stay traceable, and nothing depends
on hidden model chain-of-thought.

No replacement schema is decided here. The implementation is unaffected, because
no acceptance or state object was ever built. How project state is represented
is still open; the [roadmap](../../ROADMAP.md) describes the next step.

## Later note (2026-09-28)

[ADR 0007](0007-state-revisions-record-a-view-and-its-evidence.md) introduced the
first representation of project state: a state revision records a page and exactly
what it cites. It adopts no schema of semantic items.
