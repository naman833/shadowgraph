# Contributing to ShadowGraph

Thank you for helping make data changes safer.

## Before you start

Open an issue for substantial behavior or architecture changes so the scope and
evidence contract can be agreed before implementation. Small fixes and
documentation improvements can go directly to a pull request.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

Requirements:

- Node.js 22.13 or newer
- npm

```bash
npm install
npm run dev
```

Before opening a pull request:

```bash
npm test
npm run lint
```

## Pull-request expectations

- Keep changes focused and explain the user-visible outcome.
- Add or update tests for behavior changes.
- Include screenshots for visual changes.
- Update documentation and example output when contracts change.
- Do not commit credentials, private datasets, generated build output, or
  sensitive SQL/query content.
- Distinguish deterministic reference behavior from verified live integrations.

## Evidence design principles

Changes to analysis logic should preserve:

- Commit-scoped and reproducible results
- Explicit measurements and thresholds
- Canonical DataHub entity identity
- Explainable false-positive exclusions
- Inconclusive outcomes when evidence is insufficient
- No production-data mutation during replay

## Reporting bugs

Include the runtime version, reproduction steps, expected result, actual result,
and sanitized logs. Never attach access tokens, private keys, webhook secrets, or
production row data.

## License

Unless stated otherwise, contributions are licensed under the repository's
[Apache License 2.0](LICENSE).
