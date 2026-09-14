# Project principles

Sulai preserves the evolving state of human and AI projects. These principles are
the canonical requirements for its design, not a claim that every workflow is
implemented. The [README](../README.md#status) describes current capabilities.

## Source, meaning, and acceptance are distinct

Raw source records what was imported. Derived semantic objects represent an
interpretation of that source. Accepted project state records what the project
explicitly accepts. No layer may silently stand in for another.

## Preserve originals

Raw artifacts are immutable. Preserve their exact bytes, not only normalized text
or parsed messages. Corrections create new material; they do not rewrite originals.
Content identity does not establish authorship, an import occurrence, truth, or
semantic equivalence.

## Make derivations traceable

Every derivation must be traceable to exact source material and the process that
produced it, including any intermediate derivations. A citation must resolve to
the original source, not merely a generated summary of it.

## Keep authority explicit

AI output is neither authoritative nor human-approved by default. Deriving an
assertion, repeating it, or merging it into a proposal does not establish
acceptance. Model consensus and evidentiary support are separate concepts.

## Preserve disagreement and history

Supersession and rejection do not erase history. Genuine conflicts may remain
unresolved; the system must not manufacture agreement to produce a cleaner result.
A merge must expose proposed changes and their provenance for review.

## Record project-state changes

Accepted project state must be explicitly versioned and reconstructable from
recorded history. It must be possible to distinguish a proposed change from an
accepted one and determine how the current state was reached.

## Keep data portable

Source material, references, and recorded project history must remain portable.
Document the formats needed to interpret them. Continuing a project must not
depend on a particular model or hosted service.

## Use observable material

Sulai must never claim access to, require, or depend on hidden model chain-of-thought.
Traceability concerns observable source, inputs, outputs, and method metadata,
not private model reasoning.

The [foundational ADRs](adr/) apply these principles to the initial source model.
