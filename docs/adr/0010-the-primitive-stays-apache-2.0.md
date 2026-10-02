# ADR 0010: The primitive stays Apache-2.0

Status: Accepted. Changes no code and no format.

## Context

Sulai is meant to be a primitive that other tools build on: they read and write its records, and
depend on its formats. Builders take that dependency only if the primitive cannot later be pulled out
from under them. Open developer infrastructure has been relicensed under more restrictive terms, and
the communities that depended on it forked rather than follow
([OpenTofu](https://www.linuxfoundation.org/press/announcing-opentofu),
[Valkey](https://www.linuxfoundation.org/press/linux-foundation-launches-open-source-valkey-community)).

Sulai is already licensed under Apache-2.0. Contributions come in under the same terms, with no CLA
and no copyright assignment ([CONTRIBUTING.md](../../CONTRIBUTING.md)). That fixes the license of
what has been published. It says nothing about future versions.

## Decision

**The Sulai primitive stays under the Apache License 2.0, including all future versions.** It will
not be relicensed under terms that restrict use, modification or redistribution more than Apache-2.0
does.

The primitive is:

- **The formats:** the records and the local storage of a Sulai project, including future versions
  of them published in this repository. They are currently defined in [docs/format.md](../format.md).
- **The specifications** needed to implement Sulai independently, wherever they are kept. Currently
  they are `docs/format.md`, with `docs/architecture.md` and these decision records.
- **The reference implementation:** the canonical deterministic local implementation of the
  primitive, its engine, library and command line, including any code that replaces those
  components in implementing the committed formats. It is currently in `packages/core` and
  `packages/cli`.

Moving or renaming any of these does not narrow the commitment.

**Outside this commitment:**

- **Anything built above the primitive:** hosted services, managed sync and collaboration,
  organization and enterprise capabilities, future applications, and optional commercial layers.
  Their licensing is not decided, and this record does not decide it. Nothing in the primitive
  depends on them.
- **`packages/experimental-claude-code`.** It is Apache-2.0 while it ships here, but it is
  experimental and may be removed.
- **The Sulai name and project identity.** These are covered by
  [GOVERNANCE.md](../../GOVERNANCE.md), not by the license.

## Consequences

A tool can depend on Sulai's formats and reference implementation and know the terms will not tighten
under it. A fork of the primitive is never needed just to keep the license it already had.

The commitment narrows the project's options: commercial work happens above the primitive, never by
restricting the primitive itself.

## Alternatives considered

**Leaving the license of future versions open.** Rejected: an open question about the core is what
makes a dependency risky to take.

**Committing everything Sulai ever builds to Apache-2.0.** Rejected: that would also bind hosted
services and products that do not exist yet. The commitment covers what others build on.

**A copyleft license for the primitive.** Rejected: it would add obligations for the tools Sulai
wants to build on it. Apache-2.0 also carries an explicit patent license.
