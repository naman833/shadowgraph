# Security policy

## Supported versions

ShadowGraph is currently pre-1.0. Security fixes are applied to the latest
revision on the default branch.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Report them privately
to the repository maintainers through the security-reporting channel listed in
the repository's hosting settings. If no private channel is configured, contact
the maintainer directly before sharing technical details publicly.

Include:

- A concise description and affected component
- Reproduction steps or proof of concept
- Potential impact
- Suggested mitigation, if known

Do not include real credentials, private metadata, or production data. The
maintainers will acknowledge the report, assess severity, and coordinate a fix
and disclosure timeline.

## Sensitive areas

Security reviews should pay particular attention to:

- GitHub webhook signature verification and replay prevention
- GitHub App key and installation-token handling
- DataHub token scope and server-side storage
- SQL parsing and isolated DuckDB execution
- Secret and sensitive-literal redaction in reports
- Commit-SHA binding of check results
- Authorization and idempotency of DataHub writeback

The current vertical slice uses deterministic reference data and does not yet
consume GitHub or DataHub credentials.
