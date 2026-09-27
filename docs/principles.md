# Project principles

Sulai tracks how projects that people and AI systems work on together evolve.
These principles are the canonical requirements for its design, not a claim that
every workflow is implemented. The [README](../README.md#status) describes current
capabilities.

## Source, derived meaning, and project state are distinct

Raw source records what was imported. Derived material represents an
interpretation of that source. Project state is where the project stands as Sulai
can reconstruct it from evidence: what is current, open, changed, or divergent.
No layer may silently stand in for another.

## Preserve originals

Raw artifacts are immutable. Preserve their exact bytes, not only normalized text
or parsed messages. Corrections create new material; they do not rewrite originals.
Content identity does not establish authorship, an import occurrence, truth, or
semantic equivalence.

## Make derivations traceable

Every derivation must be traceable to exact source material and the process that
produced it, including any intermediate derivations. A citation must resolve to
the original source, not merely a generated summary of it. Provenance answers
where the evidence can be inspected.

## Track the project, not the ownership of thoughts

Human and AI reasoning mix in real work and cannot be cleanly split, and Sulai
does not try. It does not classify material by who contributed it or rank sources
by who wrote them. If a source names an author, those bytes are preserved like any
others; authorship is not the axis that determines project state.

## Do not judge truth

Sulai is infrastructure, not an arbiter of truth. Project state is not objective
truth. Deriving an assertion, repeating it, or merging it into a proposal does not
make it true or current. Model consensus and evidentiary support are separate
concepts. Correctness does not depend on whether a person or a model said
something. Sulai may point out that things appear inconsistent or superseded; those
are observations, not verdicts.

## Preserve disagreement, uncertainty, and history

Supersession and rejection do not erase history. Genuine conflicts may remain
unresolved; the system must not manufacture agreement to produce a cleaner result.
An open or uncertain question is valid project state, not a defect. Sulai must not
require people to settle a question so that it can proceed. A merge must expose
proposed changes and their provenance for review.

## Make project state reconstructable

It must be possible to determine how the current state was reached and which
evidence supports each part of it, from recorded history.

## Cost less than it saves

Sulai must reduce the coordination cost of AI-assisted work faster than it adds
management cost of its own. It must not turn that work into classifying,
approving, tagging, or curating material by hand.

## Keep data portable

Source material, references, and recorded project history must remain portable.
Document the formats needed to interpret them. Continuing a project must not
depend on a particular model or hosted service.

## Use observable material

Sulai must never claim access to, require, or depend on hidden model chain-of-thought.
Traceability concerns observable source, inputs, outputs, and method metadata,
not private model reasoning.

## Earlier versions

Until 2026-09-27 these principles also required that accepted project state record
explicit acceptance and that authority be kept explicit, distinguishing proposed
from accepted changes. That model was retired; see
[ADR 0002](adr/0002-source-meaning-state-separation.md) and the
[roadmap](../ROADMAP.md#earlier-sequence).

The [foundational ADRs](adr/) apply these principles to the initial source model.
