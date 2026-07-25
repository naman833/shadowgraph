# Self-hosted runner setup

ShadowGraph reads live context from a DataHub instance. In this project DataHub
runs locally (`http://localhost:8080`), which a GitHub-hosted runner cannot
reach, so the `ShadowGraph` workflow targets a self-hosted runner on the same
machine as DataHub.

Nothing in this document should be committed. The runner directory, its
`.credentials`, `.runner`, and registration tokens are machine-local secrets and
are excluded by `.gitignore`.

## Prerequisites

- DataHub running locally and healthy: `curl http://localhost:8080/health`
- Node.js 22.13 or newer: `node --version`
- A repository where you can manage Actions runners (admin on the repo)

## 1. Register the runner

Create the runner directory outside this repository so its files can never be
committed:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o actions-runner-osx-arm64.tar.gz -L \
  https://github.com/actions/runner/releases/latest/download/actions-runner-osx-arm64-2.330.0.tar.gz
tar xzf actions-runner-osx-arm64.tar.gz
```

Get a short-lived registration token (it expires in one hour) and configure the
runner with the labels the workflow selects on:

```bash
gh api -X POST repos/naman833/shadowgraph/actions/runners/registration-token --jq .token
./config.sh \
  --url https://github.com/naman833/shadowgraph \
  --token "<registration-token>" \
  --name shadowgraph-local \
  --labels shadowgraph,datahub \
  --work _work \
  --unattended
```

The `self-hosted` label is added automatically, which completes the
`runs-on: [self-hosted, shadowgraph, datahub]` match.

## 2. Run it

Foreground, so the log is visible while demoing:

```bash
cd ~/actions-runner && ./run.sh
```

Or as a background service:

```bash
cd ~/actions-runner && ./svc.sh install && ./svc.sh start
```

Confirm GitHub sees it as idle:

```bash
gh api repos/naman833/shadowgraph/actions/runners --jq '.runners[] | {name, status, busy}'
```

## 3. Point the workflow at DataHub (optional)

The workflow defaults to `http://localhost:8080`. If DataHub listens elsewhere,
set a repository variable instead of editing the workflow:

```bash
gh variable set DATAHUB_GMS_URL --body 'http://localhost:8080'
```

## Security notes

- A self-hosted runner executes workflow code from pull requests. Keep this
  runner on a private repository, or restrict it to pull requests from branches
  in the same repository — never expose it to forks.
- The workflow requests only `contents: read` and `checks: write`. The
  `GITHUB_TOKEN` it uses is minted per run by GitHub and expires with the job.
- `persist-credentials: false` on checkout keeps that token out of the runner's
  local git config.

## Removing the runner

```bash
gh api -X POST repos/naman833/shadowgraph/actions/runners/remove-token --jq .token
cd ~/actions-runner && ./config.sh remove --token "<remove-token>"
```
