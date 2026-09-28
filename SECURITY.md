# Security policy

Sulai has no stable release or maintained security backport line yet. Reports
against the current default branch are welcome. Response times and remediation
dates are not guaranteed at this stage.

## Reporting

Report suspected vulnerabilities privately to
[suriagajohncyrus@gmail.com](mailto:suriagajohncyrus@gmail.com), monitored by the
lead maintainer, [@jcsuriaga](https://github.com/jcsuriaga). If GitHub offers the
[private reporting form](https://github.com/sulai-atelier/sulai/security/advisories/new),
you may use that channel instead.

Include the affected revision, environment, impact, and a minimal synthetic
reproduction. Do not include real conversation exports, credentials, or unrelated
personal data. Do not disclose an unaddressed vulnerability in a public issue,
Discussion, or pull request. Coordinate disclosure with the maintainer through
the private report.

## Current boundaries

The CLI runs locally and does not send data over the network.

**Git capture runs the local `git`, and never lets it fetch or write.** It runs
only plumbing commands and `status`, with lazy fetching, replacement objects and
optional locks turned off, `core.fsmonitor` off, no pager, and every configured
filter driver turned off for the working-tree check. So nothing is fetched, the
repository is not written, and no hook, filter or fsmonitor program runs. On
Windows, `git` is found on `PATH` only, never in the current folder. Git's own
safety settings, such as `safe.directory`, apply as configured.

**Import accepts arbitrary bytes and performs no format validation.** It streams,
holding at most 1 MiB of an artifact in memory, and has no size ceiling: the limit
is available disk space. Storing material is not an assertion that it is
meaningful or safe. Imported content is never executed, and never interpreted
through a format unless a command such as `interpret` is asked to. `state record`,
`inspect` and `why` read cited ranges only as UTF-8 lines.

**Acquisition reads only the paths you name.** Importing a directory walks it
recursively, but never follows symbolic links or junctions and never reads content
looking for references. There is no discovery of related locations. A file
mentioned by the material you import is not acquired unless it lies under a path
you named, so importing a session that once read a credential file does not copy
that file. Links, unreadable and special files are recorded as skipped, with a
reason, and are not captured.

**Occurrence records contain the absolute path of each acquisition root,** which
can reveal user and directory names. Treat a `.sulai` directory as being as private
as the material in it.

A file that changes size while it is being read is not captured: it is recorded as
skipped (`changed-during-read`) and the import reports a partial acquisition. That
detects growth and truncation only; an in-place overwrite at the same length is not
detected, so do not rely on capturing a file another process is still writing.
Stored content integrity does not depend on that check, because it is verified by
SHA-256.

`interpret` is the only stable command that reads imported content through a
format. It uses only the versioned synthetic conversation format, which limits
input to 1 MiB and 10,000 messages and rejects malformed references. Its output
is JSON **including source content**, so treat captured stdout as potentially
sensitive. `inspect` verifies identity and never emits stored content, though
inspecting an occurrence prints its paths and root locations.

`status` prints state pages, and `why` prints the **exact evidence bytes** a page
cites, up to 1 MiB per reference, so treat their output as being as sensitive as
the material imported. Recording a state reads only artifacts the store already
holds: a reference never causes a path to be read or acquired.

`experimental claude-code-session` also parses, leniently, as an unstable reader
of Claude Code local session transcripts. It holds the whole transcript in memory
and refuses transcripts over 64 MiB. Its output is structure only, never message
text, but it includes record identifiers and content block types.

Stored bytes are hashed on inspection. Imports never overwrite existing artifact
paths. Hashes establish byte identity and detect a mismatch; they do not establish
authorship, truth, model agreement, or human approval.

The local store requires a filesystem with hard-link support. It rejects symbolic
links at checked storage directories and input files, but is not a sandbox against
a malicious process modifying ancestor paths or files concurrently. Users with
filesystem access can still alter or delete data. There is no encryption,
authentication, access-control layer, backup service, or guarantee of durability
across power loss. See [storage limits](docs/format.md#local-storage).

Use synthetic data while evaluating this foundation. Do not treat the local store
as the sole copy of valuable material.
