import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { orchestrate } from '../src/main.ts';
import type { OrchestrateDeps } from '../src/main.ts';
import type { Config } from '../src/inputs.ts';
import type { ExecFn } from '../src/runner.ts';
import type { ParsedCommit, ValidationReport } from '../src/types.ts';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 'latest',
    workingDirectory: '.',
    target: { kind: 'commit', value: 'HEAD' },
    configPath: null,
    format: 'human',
    failOnWarning: false,
    summary: true,
    sarifFile: null,
    ...overrides,
  };
}

function makeCommit(header: string): ParsedCommit {
  return {
    raw: header,
    header,
    type: 'feat',
    scope: null,
    breaking: false,
    hasBreakingChange: false,
    subject: null,
    body: null,
    footers: [],
  };
}

function validReport(): ValidationReport {
  return {
    valid: true,
    commit: makeCommit('feat: add login'),
    results: [],
    errorCount: 0,
    warningCount: 0,
    skippedGitRules: [],
  };
}

function invalidReport(): ValidationReport {
  return {
    valid: false,
    commit: makeCommit('bad message'),
    results: [
      {
        ruleName: 'format',
        severity: 'error',
        problems: [{ message: 'Commit message must match "type: subject".' }],
      },
    ],
    errorCount: 2,
    warningCount: 0,
    skippedGitRules: [],
  };
}

function warnReport(): ValidationReport {
  return {
    valid: true,
    commit: makeCommit('feat: long header'),
    results: [
      {
        ruleName: 'header-max-length',
        severity: 'warn',
        problems: [{ message: 'Header exceeds 100 characters.' }],
      },
    ],
    errorCount: 0,
    warningCount: 1,
    skippedGitRules: [],
  };
}

interface ScriptedRun {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

interface ExecCall {
  args: string[];
  cwd: string;
  silent: boolean;
}

interface Ctx {
  deps: OrchestrateDeps;
  calls: ExecCall[];
  outputs: Map<string, string>;
  failed: string[];
  errors: string[];
  warnings: string[];
  infos: string[];
  reportWrites: string[];
  sarifWrites: { path: string; contents: string }[];
  summaryWrites: string[];
  log: string[];
}

function makeDeps(config: Config, runs: ScriptedRun[]): Ctx {
  let execCallIndex = 0;
  const calls: ExecCall[] = [];
  const outputs = new Map<string, string>();
  const failed: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const reportWrites: string[] = [];
  const sarifWrites: { path: string; contents: string }[] = [];
  const summaryWrites: string[] = [];
  const log: string[] = [];

  const exec: ExecFn = async (_cmd, args, options) => {
    const run = runs[execCallIndex++];
    if (run === undefined) {
      throw new Error(`unexpected exec call (only ${runs.length} scripted)`);
    }
    calls.push({ args, cwd: options.cwd, silent: options.silent });
    if (run.stdout !== undefined) options.listeners.stdout(Buffer.from(run.stdout));
    if (run.stderr !== undefined) options.listeners.stderr(Buffer.from(run.stderr));
    return run.exitCode;
  };

  const deps: OrchestrateDeps = {
    readInputs: () => config,
    exec,
    setOutput: (name, value) => {
      outputs.set(name, value);
      log.push(`setOutput:${name}`);
    },
    setFailed: (msg) => {
      failed.push(msg);
      log.push('setFailed');
    },
    error: (msg) => {
      errors.push(msg);
    },
    warning: (msg) => {
      warnings.push(msg);
    },
    info: (msg) => {
      infos.push(msg);
    },
    writeReportFile: (json) => {
      reportWrites.push(json);
      return '/tmp/commit-sentinel-report.json';
    },
    writeSarifFile: (path, contents) => {
      sarifWrites.push({ path, contents });
    },
    writeSummary: async (md) => {
      summaryWrites.push(md);
    },
  };

  return { deps, calls, outputs, failed, errors, warnings, infos, reportWrites, sarifWrites, summaryWrites, log };
}

describe('orchestrate', () => {
  it('happy path: json pass then loud format pass, outputs, summary, no setFailed', async () => {
    const ctx = makeDeps(baseConfig(), [
      { stdout: JSON.stringify(validReport()), exitCode: 0 },
      { stdout: '✔ Valid commit message\n', exitCode: 0 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.calls.length, 2);
    assert.deepEqual(ctx.calls[0], { args: ['--yes', '@silverwalls-labs/commit-sentinel@latest', '--commit', 'HEAD', '--json'], cwd: '.', silent: true });
    assert.deepEqual(ctx.calls[1], { args: ['--yes', '@silverwalls-labs/commit-sentinel@latest', '--commit', 'HEAD'], cwd: '.', silent: false });
    assert.equal(ctx.outputs.get('valid'), 'true');
    assert.equal(ctx.outputs.get('commits-count'), '1');
    assert.equal(ctx.outputs.get('error-count'), '0');
    assert.equal(ctx.outputs.get('warning-count'), '0');
    assert.equal(ctx.outputs.get('policy-passed'), 'true');
    assert.equal(ctx.outputs.get('report-path'), '/tmp/commit-sentinel-report.json');
    assert.equal(ctx.summaryWrites.length, 1);
    assert.match(ctx.summaryWrites[0]!, /## Commit Sentinel/);
    assert.equal(ctx.failed.length, 0);
    assert.equal(ctx.errors.length, 0);
  });

  it('skips the step summary when summary is disabled', async () => {
    const ctx = makeDeps(baseConfig({ summary: false }), [
      { stdout: JSON.stringify(validReport()), exitCode: 0 },
      { exitCode: 0 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.calls.length, 2);
    assert.equal(ctx.summaryWrites.length, 0);
  });

  it('policy violation: reads the report from stderr, publishes outputs before setFailed', async () => {
    const ctx = makeDeps(baseConfig(), [
      { stderr: JSON.stringify(invalidReport()), exitCode: 2 },
      { stderr: '✖ Invalid commit message\n', exitCode: 2 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.calls.length, 2);
    assert.equal(ctx.outputs.get('valid'), 'false');
    assert.equal(ctx.outputs.get('policy-passed'), 'false');
    assert.equal(ctx.outputs.get('error-count'), '2');
    assert.deepEqual(ctx.failed, ['Commit validation failed: 2 error(s) across 1 commit(s).']);
    const failedIndex = ctx.log.indexOf('setFailed');
    for (const entry of ctx.log.filter((e) => e.startsWith('setOutput:'))) {
      assert.ok(ctx.log.indexOf(entry) < failedIndex, `${entry} should come before setFailed`);
    }
    assert.equal(ctx.summaryWrites.length, 1);
  });

  it('runtime error: surfaces stderr, fails immediately, sets no outputs', async () => {
    const ctx = makeDeps(baseConfig(), [{ stderr: 'fatal: bad ref\n', exitCode: 1 }]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.calls.length, 1);
    assert.deepEqual(ctx.errors, ['fatal: bad ref']);
    assert.deepEqual(ctx.failed, ['commit-sentinel exited with code 1. See logs above.']);
    assert.equal(ctx.outputs.size, 0);
    assert.equal(ctx.summaryWrites.length, 0);
  });

  it('runtime error with empty stderr: still fails, no error annotation', async () => {
    const ctx = makeDeps(baseConfig(), [{ stderr: '  \n', exitCode: 3 }]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.errors.length, 0);
    assert.deepEqual(ctx.failed, ['commit-sentinel exited with code 3. See logs above.']);
  });

  it('fail-on-warning trips on warnings: outputs first, then warning and setFailed', async () => {
    const ctx = makeDeps(baseConfig({ failOnWarning: true }), [
      { stdout: JSON.stringify(warnReport()), exitCode: 0 },
      { exitCode: 0 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.outputs.get('policy-passed'), 'false');
    assert.equal(ctx.outputs.get('warning-count'), '1');
    assert.deepEqual(ctx.warnings, ['fail-on-warning is enabled and 1 warning(s) were reported.']);
    assert.deepEqual(ctx.failed, ['Commit validation reported warnings and fail-on-warning is enabled.']);
    const failedIndex = ctx.log.indexOf('setFailed');
    assert.ok(ctx.log.indexOf('setOutput:policy-passed') < failedIndex);
  });

  it('warnings without fail-on-warning pass the policy', async () => {
    const ctx = makeDeps(baseConfig(), [
      { stdout: JSON.stringify(warnReport()), exitCode: 0 },
      { exitCode: 0 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.outputs.get('policy-passed'), 'true');
    assert.equal(ctx.failed.length, 0);
    assert.equal(ctx.warnings.length, 0);
  });

  it('fail-on-warning with zero warnings does not trip', async () => {
    const ctx = makeDeps(baseConfig({ failOnWarning: true }), [
      { stdout: JSON.stringify(validReport()), exitCode: 0 },
      { exitCode: 0 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.outputs.get('policy-passed'), 'true');
    assert.equal(ctx.failed.length, 0);
  });

  it('exit 2 wins over fail-on-warning: exactly one setFailed', async () => {
    const report = invalidReport();
    report.warningCount = 1;
    const ctx = makeDeps(baseConfig({ failOnWarning: true }), [
      { stderr: JSON.stringify(report), exitCode: 2 },
      { stderr: '', exitCode: 2 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.failed.length, 1);
    assert.match(ctx.failed[0]!, /Commit validation failed/);
    assert.equal(ctx.warnings.length, 0);
  });

  it('sarif pass on success: writes the file from stdout and sets sarif-path', async () => {
    const ctx = makeDeps(baseConfig({ sarifFile: 'out/results.sarif', workingDirectory: '/work' }), [
      { stdout: JSON.stringify(validReport()), exitCode: 0 },
      { exitCode: 0 },
      { stdout: '{"version":"2.1.0"}', exitCode: 0 },
    ]);

    await orchestrate(ctx.deps);

    const expectedPath = resolve('/work', 'out/results.sarif');
    assert.equal(ctx.calls.length, 3);
    assert.deepEqual(ctx.calls[2], { args: ['--yes', '@silverwalls-labs/commit-sentinel@latest', '--commit', 'HEAD', '--sarif'], cwd: '/work', silent: true });
    assert.deepEqual(ctx.sarifWrites, [{ path: expectedPath, contents: '{"version":"2.1.0"}' }]);
    assert.equal(ctx.outputs.get('sarif-path'), expectedPath);
  });

  it('sarif pass on policy violation: takes the SARIF from stderr', async () => {
    const ctx = makeDeps(baseConfig({ sarifFile: 'results.sarif' }), [
      { stderr: JSON.stringify(invalidReport()), exitCode: 2 },
      { stderr: '', exitCode: 2 },
      { stderr: '{"version":"2.1.0"}', exitCode: 2 },
    ]);

    await orchestrate(ctx.deps);

    assert.deepEqual(ctx.sarifWrites, [
      { path: resolve('.', 'results.sarif'), contents: '{"version":"2.1.0"}' },
    ]);
    assert.equal(ctx.outputs.get('sarif-path'), resolve('.', 'results.sarif'));
  });

  it('sarif pass runtime error: warns and skips the file', async () => {
    const ctx = makeDeps(baseConfig({ sarifFile: 'results.sarif' }), [
      { stdout: JSON.stringify(validReport()), exitCode: 0 },
      { exitCode: 0 },
      { stderr: 'boom', exitCode: 1 },
    ]);

    await orchestrate(ctx.deps);

    assert.deepEqual(ctx.warnings, ['SARIF pass exited with code 1; sarif-file was not written.']);
    assert.equal(ctx.sarifWrites.length, 0);
    assert.equal(ctx.outputs.has('sarif-path'), false);
    assert.equal(ctx.failed.length, 0);
  });

  it('sarif with an empty range: warns and skips the extra pass entirely', async () => {
    const emptyText = 'No commits found in range "main..HEAD".\n';
    const ctx = makeDeps(
      baseConfig({ target: { kind: 'range', value: 'main..HEAD' }, sarifFile: 'results.sarif' }),
      [
        { stdout: emptyText, exitCode: 0 },
        { stdout: emptyText, exitCode: 0 },
      ],
    );

    await orchestrate(ctx.deps);

    assert.equal(ctx.calls.length, 2);
    assert.deepEqual(ctx.warnings, ['No commits found in range; sarif-file was not written.']);
    assert.equal(ctx.sarifWrites.length, 0);
    assert.equal(ctx.outputs.has('sarif-path'), false);
  });

  it('empty range: zero commits, valid, summary notes it', async () => {
    const emptyText = 'No commits found in range "main..HEAD".\n';
    const ctx = makeDeps(baseConfig({ target: { kind: 'range', value: 'main..HEAD' } }), [
      { stdout: emptyText, exitCode: 0 },
      { stdout: emptyText, exitCode: 0 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.outputs.get('commits-count'), '0');
    assert.equal(ctx.outputs.get('valid'), 'true');
    assert.equal(ctx.outputs.get('policy-passed'), 'true');
    assert.equal(ctx.failed.length, 0);
    assert.match(ctx.summaryWrites[0]!, /No commits found in range/);
  });

  it('range mode: aggregates a multi-report array', async () => {
    const reports = [validReport(), invalidReport()];
    const ctx = makeDeps(baseConfig({ target: { kind: 'base', value: 'origin/main' } }), [
      { stderr: JSON.stringify(reports), exitCode: 2 },
      { stderr: '', exitCode: 2 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.outputs.get('commits-count'), '2');
    assert.equal(ctx.outputs.get('error-count'), '2');
    assert.equal(ctx.outputs.get('valid'), 'false');
    assert.match(ctx.failed[0]!, /2 error\(s\) across 2 commit\(s\)/);
  });

  it('rejects when the CLI emits malformed JSON', async () => {
    const ctx = makeDeps(baseConfig(), [{ stdout: 'garbage{', exitCode: 0 }]);

    await assert.rejects(orchestrate(ctx.deps), /Failed to parse commit-sentinel JSON report/);
    assert.equal(ctx.outputs.size, 0);
  });

  it('echoes the pass-1 JSON instead of re-running when format is json', async () => {
    const json = JSON.stringify(validReport());
    const ctx = makeDeps(baseConfig({ format: 'json' }), [
      { stdout: json, exitCode: 0 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.calls.length, 1);
    assert.deepEqual(ctx.infos, [json]);
  });

  it('format json with an empty range: single call, info echoes the plain-text notice', async () => {
    const emptyText = 'No commits found in range "main..HEAD".\n';
    const ctx = makeDeps(
      baseConfig({ format: 'json', target: { kind: 'range', value: 'main..HEAD' } }),
      [{ stdout: emptyText, exitCode: 0 }],
    );

    await orchestrate(ctx.deps);

    assert.equal(ctx.calls.length, 1);
    assert.deepEqual(ctx.infos, [emptyText]);
  });

  it('loud human pass runtime error: surfaces stderr, fails after outputs, skips summary', async () => {
    const ctx = makeDeps(baseConfig(), [
      { stdout: JSON.stringify(validReport()), exitCode: 0 },
      { stderr: 'fatal: bad object\n', exitCode: 1 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.calls.length, 2);
    assert.deepEqual(ctx.errors, ['fatal: bad object']);
    assert.deepEqual(ctx.failed, ['commit-sentinel exited with code 1. See logs above.']);
    assert.equal(ctx.outputs.get('policy-passed'), 'true');
    assert.equal(ctx.outputs.get('report-path'), '/tmp/commit-sentinel-report.json');
    assert.equal(ctx.summaryWrites.length, 0);
  });

  it('loud human pass runtime error with empty stderr: fails without an error annotation', async () => {
    const ctx = makeDeps(baseConfig(), [
      { stdout: JSON.stringify(validReport()), exitCode: 0 },
      { stderr: '  \n', exitCode: 3 },
    ]);

    await orchestrate(ctx.deps);

    assert.equal(ctx.errors.length, 0);
    assert.deepEqual(ctx.failed, ['commit-sentinel exited with code 3. See logs above.']);
    assert.equal(ctx.summaryWrites.length, 0);
  });

  it('passes --sarif to the loud pass when format is sarif', async () => {
    const ctx = makeDeps(baseConfig({ format: 'sarif' }), [
      { stdout: JSON.stringify(validReport()), exitCode: 0 },
      { exitCode: 0 },
    ]);

    await orchestrate(ctx.deps);

    assert.deepEqual(ctx.calls[1]!.args, ['--yes', '@silverwalls-labs/commit-sentinel@latest', '--commit', 'HEAD', '--sarif']);
  });

  it('propagates a readInputs failure before any CLI call', async () => {
    const ctx = makeDeps(baseConfig(), []);
    ctx.deps.readInputs = () => {
      throw new Error('Invalid value "xml" for input "format".');
    };

    await assert.rejects(orchestrate(ctx.deps), /Invalid value "xml"/);
    assert.equal(ctx.calls.length, 0);
  });
});
