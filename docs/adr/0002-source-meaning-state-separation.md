# ADR 0002: Separate source, derived meaning, and accepted state

Status: Accepted

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
