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

**Import accepts arbitrary bytes and performs no format validation**, bounded by a
64 MiB local-store ceiling. Storing material is not an assertion that it is
meaningful or safe. Raw content is never executed, and no stored bytes are parsed
unless a command explicitly interprets them.

`interpret` is the only command that parses, and only through the versioned
synthetic conversation format, which limits input to 1 MiB and 10,000 messages and
rejects malformed references. Its output is JSON **including source content**, so
treat captured stdout as potentially sensitive. `inspect` verifies identity and
never emits stored content.

Stored bytes are hashed on inspection. Imports never overwrite existing artifact
paths. Hashes establish byte identity and detect a mismatch; they do not establish
authorship, truth, model agreement, or human approval.

The local store requires a filesystem with hard-link support. It rejects symbolic
links at checked storage directories and input files, but is not a sandbox against
a malicious process modifying ancestor paths or files concurrently. Users with
filesystem access can still alter or delete data. There is no encryption,
authentication, access-control layer, backup service, or guarantee of durability
across power loss. See [storage limits](docs/source-format.md#local-storage).

Use synthetic data while evaluating this foundation. Do not treat the local store
as the sole copy of valuable material.
