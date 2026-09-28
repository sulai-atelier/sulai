# ADR 0007: State revisions record a view and its evidence

Status: Accepted. Raises the storage format to version 4.

## Context

A project's current state (what holds now, what changed, what is open, where sources disagree) is
usually kept in a page maintained by hand. It drifts: it stops matching later work, and nothing shows
which lines still rest on anything. A page rebuilt from evidence does the job, but only if each line
can be traced to the exact bytes it cites, and only if earlier versions of the page stay available.

Whether a line is right is not something Sulai can decide. A cited source can be wrong, and so can
the line that cites it.

## Decision

> **A state revision does not certify its claims. It immutably records a project-state view, plus
> exactly what evidence that view cited. Every citation is either resolved to exact preserved bytes
> or explicitly unresolved.**

Sulai checks the pointer, never the claim. It does not write the page and does not judge it.

**The page** is UTF-8 Markdown of at most 1 MiB, written by whoever or whatever derives it. A
**reference** is an inline code span whose whole content is `rN/<path>#L<a>` or
`rN/<path>#L<a>-L<b>`, or `rN#L<a>[-L<b>]` for a file root. `rN` is a root ID of one named
occurrence, never a locator. Lines are 1-based and inclusive. Any other code span is just code.

**Lines.** A line ends at LF, and a CR immediately before it is part of the terminator. The last line
may have no LF, and a trailing LF does not start a new line. `#La-Lb` is the byte range from the
start of line `a` to the end of line `b`'s content, without its terminator. The range must be valid
UTF-8.

**Recording** (`sulai state record <project> <page> --from <occurrence-id> [--parent <state-id>]`):

- **The occurrence is always named.** Nothing looks for "the latest occurrence".
- **Heads decide the parent, never time.** The parent is the one given; otherwise the only head;
  otherwise none, for the first revision. With several heads and no parent given, recording refuses
  and lists them.
- **Each distinct reference is resolved once, here**, by streaming, to an artifact and a byte range.
  A reference that cannot be resolved stays unresolved with one reason and is never retargeted:
  `unknown-root`, `path-not-in-occurrence`, `not-captured` (skipped or excluded in the occurrence),
  `invalid-lines`, `line-out-of-range` or `not-utf8-text`.
- **The page is published first and the revision last.** A crash can leave an unreferenced page
  artifact, never a revision that names bytes the store does not hold.

**The revision** is canonical JSON in `.sulai/states/`, identified as `state:v1:<sha256 of its
bytes>`. It holds `parent` (or null), `createdAt`, `page`, `occurrence`, and `references` in page
order, each with its `locator` and `status`, plus `artifact`, `startByte` and `endByte` when
resolved, or `reason` when not. It holds no confidence, actor, acceptance, model metadata or semantic
links. The exact encoding is in [the source format](../source-format.md#state-revisions).

**Reading:**

- **`sulai status <project>`** prints every head: its page and the counts recorded at record time.
  With several heads it names no winner. It hashes every stored revision and each head's page, but
  never reads the evidence the pages cite, so large evidence does not slow it down.
- **`sulai why <project> <state-id> <line>`** takes one line of that page, not a semantic item. For
  each reference on it, it returns the resolution and, when resolved, the exact bytes. It verifies
  the artifact's hash by streaming before it reads the range, and cuts off output over 1 MiB per
  reference, marking it.
- **`sulai diff <project> <a> <b>`** is a deterministic line diff of the two pages: lines removed and
  added, in order. It is not a semantic diff, a merge or a supersession.
- **`sulai inspect`** proves each revision down the chain: the revision hashes to its name and
  parses canonically; its parent is stored; its page and occurrence verify; its references are
  exactly the page's references; and resolving them again against the occurrence's artifacts gives
  exactly the stored ranges and reasons.

**Storage format 4.** An inspector that ignores `states/` could call a project healthy without
checking its state history, so versions 1 to 3 are refused. This pre-alpha does not migrate them.

## Consequences

A state page becomes a recorded, versioned view whose every line can be followed to preserved bytes,
or shown to rest on nothing.

A fork does not close. A revision has exactly one parent, so no revision can join two heads:
recording on one head extends it and leaves the others as heads. Once a project has forked, `status`
reports every head from then on, and every recording has to name its parent. A fork comes from
`--parent` naming a revision that already has a child, or from two recordings made at once, which
can both choose the same parent because nothing locks the store. Joining views would need a merge,
which this decision does not include.

Resolution happens once. `status` hashes no evidence, `why` hashes only the evidence its one line
cites, and `inspect` hashes all of it.

`why` prints evidence bytes to the terminal. Those bytes can be sensitive; see
[SECURITY.md](../../SECURITY.md).

## Alternatives considered

**Using the newest revision as the parent.** Rejected: clocks differ and forks are real. Picking by
time would hide a divergence instead of showing it.

**References by file name or locator.** Rejected: names repeat across roots and locators are
machine-specific. A root ID within one named occurrence is exact.

**Resolving references when they are read.** Rejected: the answer would depend on what the store
holds later, and `status` would have to hash evidence every time.

**Structured items instead of lines.** Deferred. Lines are enough to trace a claim, and items would
need a schema this project does not yet have evidence for.
