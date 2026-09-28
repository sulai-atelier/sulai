# Architecture

This page explains how Sulai is put together: its records, the boundaries between
them, and how the code is organized. The [format specification](format.md) defines
each record exactly, and the [decision records](adr/) explain why.

## Records

Sulai keeps a project's history as three kinds of immutable record. Each is
identified by the SHA-256 of its exact bytes, and none is ever rewritten.

```text
files you name
      │ import
      ▼
  Artifact         exact bytes, stored once
      ▲
      │ names
  Occurrence       one acquisition: its roots, its inputs, what was skipped and why
      ▲
      │ resolves citations against
  State revision   a page, its parent, and each citation's artifact and byte range
```

- **Artifact.** The exact bytes of one input. Identical bytes are one artifact,
  however often and from wherever they are imported. An artifact has no name, path
  or time; those belong to occurrences.
- **Occurrence.** One acquisition. It lists the roots that were named, numbered
  `r1`, `r2` and so on, every input found under them with the artifact it became,
  and every input that could not be captured, with a reason. The same bytes
  imported twice are one artifact and two occurrences.
- **State revision.** One view of where the project stands. The page is Markdown,
  written by a person or an agent. Each citation on it, such as
  `r1/docs/plan.md#L3-L8`, is resolved against one occurrence to an artifact and
  byte range, or recorded as unresolved with a reason. A revision names its parent,
  so revisions form a history, and the revisions with no children are its heads.

Within an artifact, a **source unit** and a **source span** address byte ranges
for readers that interpret a format, such as the synthetic conversation format.

## Boundaries

These separations are deliberate. Most mistakes would come from blurring one.

| Kept apart                            | Why                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| preservation and interpretation       | `import` stores bytes without reading them through a format, so a reader can fail, change or be added later without touching what was kept |
| artifact identity and acquisition     | the same bytes can arrive many times, and each arrival is its own occurrence                                                               |
| citation resolution and claim support | Sulai proves that a citation points at exact bytes, never that those bytes support the line                                                |
| project state and truth               | a state page is a recorded view, not a verdict                                                                                             |
| acquisition and discovery             | only the paths named are read: links are never followed, and content is never searched for other paths                                     |

## Storage

A project keeps its records under `.sulai/`:

```text
.sulai/
  project.json    storage format marker, version 4
  artifacts/      <sha256>.raw
  occurrences/    <sha256>.json
  states/         <sha256>.json
  tmp/            staging, recreated when needed
```

Preserving and verifying an artifact streams it in bounded chunks, so an
artifact's size is limited only by disk space. Occurrence records and state
revisions are read whole, up to 64 MiB, and a state page is at most 1 MiB.

Every record is staged in `tmp/`, synced, and published by hard link, which fails
rather than replace an existing name. Records are published in dependency order:
artifacts before the occurrence that names them, a page before the revision that
cites it. An interrupted operation can leave unreferenced artifacts, never a
record that names missing ones. This is not a guarantee across power loss; the
[format specification](format.md#local-storage) states what is and is not
promised.

## Packages

```text
packages/core                       records, identities, parsing and validation
packages/cli                        the local store and the sulai command
packages/experimental-claude-code   an unstable reader, kept out of core
```

`core` does no filesystem I/O and depends on no other package here. The
experimental reader depends only on `core`; the CLI depends on both. No package has
a third-party runtime dependency.

Inside `packages/cli/src`:

| Module            | Concern                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `store.ts`        | streaming reads, staging, never-replace publication, verification      |
| `project.ts`      | the `.sulai` layout, the format marker, creating and opening a project |
| `artifacts.ts`    | storing one file; loading one artifact whole                           |
| `acquire.ts`      | checking roots, walking them, and recording an occurrence              |
| `occurrences.ts`  | reading stored occurrences and checking them against their artifacts   |
| `references.ts`   | resolving a page's citations to byte ranges                            |
| `state.ts`        | recording revisions; `status`, `why` and `diff`                        |
| `inspect.ts`      | integrity checks                                                       |
| `interpret.ts`    | reading an artifact through a format                                   |
| `experimental.ts` | the experimental Claude Code command                                   |
| `main.ts`         | argument parsing and output                                            |

## Known limits

- A revision has one parent, so a fork never rejoins.
- A citation is a path and line range within one occurrence. Resolved again
  against a newer occurrence, it can point at different bytes if its file changed
  above those lines. Recording refuses that for citations kept from the parent
  revision ([ADR 0008](adr/0008-a-kept-citation-keeps-its-evidence.md)), but
  correcting them is still manual.
- A revision cites exactly one occurrence, so refreshing a page means acquiring
  again everything it cites.
- Nothing locks the store, so two recordings at once can fork the history.

Removing any of these would change the format. The [roadmap](../ROADMAP.md) says
when that is expected.
