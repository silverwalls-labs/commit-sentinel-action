# commit-sentinel-action

Validate git commit messages against [Conventional Commits][conventional] and custom rules — with policy enforcement, typed outputs, and a Markdown step summary. A thin GitHub Action wrapper around the [`@silverwalls-labs/commit-sentinel`][cli] CLI.

## Quickstart

```yaml
# .github/workflows/commit-sentinel.yml
name: Commit Sentinel

on:
  pull_request:

jobs:
  lint-commits:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - uses: silverwalls-labs/commit-sentinel-action@v1
        with:
          base: origin/${{ github.event.pull_request.base.ref }}
```

This validates every commit in the pull request (merge commits are skipped). `fetch-depth: 0` is required so the base ref and the PR commits exist in the checkout.

> **Note:** the wrapped CLI requires **Node.js ≥ 24 on the runner's PATH** (the action's own runtime is bundled, but the CLI runs via `npx`). Add a `setup-node` step with `node-version: '24'` before the action.

## Examples

### Validate the pushed commit

```yaml
on:
  push:
    branches: [main]

steps:
  - uses: actions/checkout@v4
  - uses: silverwalls-labs/commit-sentinel-action@v1
    # No source input: defaults to validating HEAD.
```

### Validate the PR title as a commit message

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: silverwalls-labs/commit-sentinel-action@v1
    with:
      message: ${{ github.event.pull_request.title }}
```

### Strict policy: fail on warnings too

```yaml
steps:
  - uses: silverwalls-labs/commit-sentinel-action@v1
    with:
      base: origin/${{ github.event.pull_request.base.ref }}
      fail-on-warning: 'true'
```

### Upload SARIF to GitHub Code Scanning

```yaml
steps:
  - uses: silverwalls-labs/commit-sentinel-action@v1
    id: sentinel
    continue-on-error: true
    with:
      base: origin/${{ github.event.pull_request.base.ref }}
      sarif-file: commit-sentinel.sarif
  - uses: github/codeql-action/upload-sarif@v3
    if: steps.sentinel.outputs.sarif-path != ''
    with:
      sarif_file: ${{ steps.sentinel.outputs.sarif-path }}
```

### Use a custom config

```yaml
steps:
  - uses: silverwalls-labs/commit-sentinel-action@v1
    with:
      base: origin/${{ github.event.pull_request.base.ref }}
      config: lint/commit-sentinel.config.ts
```

Without `config`, the CLI resolves `commit-sentinel.config.ts` in the working directory, falling back to its built-in `strict` preset. See the [configuration docs][cli-config].

## Inputs

| Input               | Default  | Description |
| ------------------- | -------- | ----------- |
| `version`           | `latest` | Version spec of `@silverwalls-labs/commit-sentinel` to run via `npx --yes`. Accepts any spec npm understands — pin (e.g. `0.2.0`) for reproducible builds. |
| `working-directory` | `.`      | Directory to run the CLI in (passed as cwd). |
| `message`           | —        | Validate a literal commit message string. |
| `file`              | —        | Validate the first line of a commit message file, e.g. `.git/COMMIT_EDITMSG`. |
| `commit`            | —        | Git ref whose commit message to validate. Defaults to `HEAD` when no source input is set. |
| `range`             | —        | Git range to validate, e.g. `main..HEAD`. |
| `base`              | —        | PR shorthand: validate all commits from `<ref>..HEAD`. |
| `config`            | —        | Explicit path to a config file; otherwise the CLI resolves its own config. |
| `format`            | `human`  | Format printed to the action log: `human`, `json`, or `sarif`. |
| `fail-on-warning`   | `false`  | Fail the job when `warning-count > 0`, even though the CLI exits 0. |
| `summary`           | `true`   | Write a Markdown report to `$GITHUB_STEP_SUMMARY`. |
| `sarif-file`        | —        | When set, also write SARIF 2.1.0 to this path (extra CLI pass with `--sarif`) for Code Scanning upload. Relative paths resolve against `working-directory`. |

`message`, `file`, `commit`, `range`, and `base` are **mutually exclusive** — setting more than one fails the action before the CLI runs. Range modes (`range`, `base`) skip merge commits.

## Outputs

| Output          | Description |
| --------------- | ----------- |
| `valid`         | `"true"` / `"false"` — overall validation result across all validated commits. |
| `commits-count` | Number of commits validated. |
| `error-count`   | Total rule violations at error level. |
| `warning-count` | Total rule violations at warning level. |
| `policy-passed` | `"true"` if the CLI exited 0 and `fail-on-warning` did not trip; `"false"` otherwise. |
| `report-json`   | Full JSON report, inline — always a JSON array of `ValidationReport` (one entry per commit). Empty string when over GitHub's ~1 MB output limit; read `report-path` instead. |
| `report-path`   | Filesystem path to the full JSON report (`$RUNNER_TEMP/commit-sentinel-report.json`). Always set. |
| `sarif-path`    | Path to the SARIF report. Only set when the `sarif-file` input is provided. |

Consume outputs from a later step:

```yaml
- uses: silverwalls-labs/commit-sentinel-action@v1
  id: sentinel
  with:
    base: origin/${{ github.event.pull_request.base.ref }}
- run: |
    echo "Validated ${{ steps.sentinel.outputs.commits-count }} commit(s)"
    jq '.' "${{ steps.sentinel.outputs.report-path }}"
```

## How it works

The action is a thin wrapper — it does **not** vendor the CLI. Each run invokes:

```
npx --yes @silverwalls-labs/commit-sentinel@<version> [flags]
```

so the action's git tag (e.g. `@v1`) and the CLI version evolve independently, the same way `setup-node` versions independently of Node itself. Pin the `version` input for reproducible runs.

Per run the action makes up to three CLI passes:

1. A silent `--json` pass to parse the report, publish outputs, and classify the exit code (`0` valid, `1` usage/runtime error, `2` validation failed). On exit `2`, outputs are published **before** the step is marked failed, so downstream steps can read them.
2. A pass with your chosen `format`, echoed to the action log.
3. When `sarif-file` is set, a silent `--sarif` pass whose output is written to that path.

The Markdown step summary is rendered by the action from the parsed JSON report: overall status, error/warning counts, and a violations table per offending commit.

## Roadmap

- Sticky PR comment with the violations table
- Inline `::error` annotations on the offending commits
- PR title validation preset

## Development

```bash
npm ci             # install
npm run lint       # oxlint
npm run typecheck  # tsc --noEmit
npm test           # node --test via tsx
npm run build      # esbuild bundle -> dist/index.js
npm run package    # build + verify dist/ is committed
```

`dist/index.js` **must be committed** — GitHub Actions execute it directly from the ref. CI fails if it is stale.

## License

[MIT](LICENSE)

[cli]: https://github.com/silverwalls-labs/commit-sentinel
[cli-config]: https://github.com/silverwalls-labs/commit-sentinel/blob/main/docs/configuration.md
[conventional]: https://www.conventionalcommits.org
