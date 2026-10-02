# Governance

Sulai is currently founder/maintainer-led. The lead maintainer is
[@jcsuriaga](https://github.com/jcsuriaga).

## Responsibilities and decisions

Maintainers are responsible for project direction, architecture, releases,
contribution review, and community moderation. They decide what is accepted into
the project and are accountable for explaining consequential decisions.

Technical discussion and disagreement are welcome. A contribution, vote, or
popular proposal does not by itself establish project policy. Decisions should
consider the [project principles](docs/principles.md), evidence, compatibility,
maintenance cost, and the scope of the problem.

Use issues for bounded implementation work and Discussions for exploratory
questions. Maintainers may request an RFC when wider technical input would help.
An ADR records an accepted architectural decision, its consequences, and the
alternatives seriously considered; it is not a running research notebook.

Changes are reviewed through pull requests and must pass the repository checks
before merging. There is currently one maintainer, so an independent second
reviewer cannot be guaranteed. Sensitive security and conduct matters use the
private channels in [SECURITY.md](SECURITY.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Maintainership

Maintainers may invite contributors who have demonstrated sustained sound
judgment, constructive review, and willingness to maintain their work. Invitations
require the contributor's agreement; code volume alone does not confer authority.
Responsibilities and access should match the work undertaken.

The maintainer list and material governance changes are recorded in this document.
Contributors may propose changes to governance through the same public review
process used for other project changes.

## Contribution policy

Current contribution terms are documented in [CONTRIBUTING.md](CONTRIBUTING.md).
Changes to licensing or contribution requirements need an explicit maintainer
decision and must be documented before affected contributions are accepted.

## License commitment

The Sulai primitive (its formats, specifications, and reference implementation in
`packages/core` and `packages/cli`) stays under Apache-2.0, including all future
versions. Hosted and commercial layers built above it are outside this commitment.
[ADR 0010](docs/adr/0010-the-primitive-stays-apache-2.0.md) defines what the
primitive includes and what it leaves out.

## Project identity

The Sulai name and project identity identify the official Sulai project. Modified
distributions should use a distinct name and may accurately describe themselves as
based on or derived from Sulai.

## Publication and history

Before initial publication, maintainers may curate unpublished history with
explicit approval from affected contributors. Once the repository is public,
published history is preserved and corrections use new commits. Rewriting
published history is reserved for serious security or legal reasons, with
maintainer authorization and coordination with affected contributors. Explain
such changes publicly to the extent it is safe to do so.

Do not move published release tags to different content. Repository publication,
releases, and exceptional history changes require explicit maintainer approval.
