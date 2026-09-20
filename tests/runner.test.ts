import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/runner.ts';
import type { ExecFn, ExecOptions } from '../src/runner.ts';

interface RecordedCall {
  command: string;
  args: string[];
  options: ExecOptions;
}

function makeExec(
  behavior: (options: ExecOptions) => number,
): { exec: ExecFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args, options });
    return behavior(options);
  };
  return { exec, calls };
}

describe('runCli', () => {
  it('invokes npx --yes with the versioned package and args', async () => {
    const { exec, calls } = makeExec(() => 0);

    await runCli(
      { version: '1.2.3', args: ['--commit', 'HEAD'], cwd: '/work', silent: true },
      exec,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'npx');
    assert.deepEqual(calls[0]!.args, [
      '--yes',
      '@silverwalls-labs/commit-sentinel@1.2.3',
      '--commit',
      'HEAD',
    ]);
    assert.equal(calls[0]!.options.cwd, '/work');
    assert.equal(calls[0]!.options.ignoreReturnCode, true);
    assert.equal(calls[0]!.options.silent, true);
  });

  it('defaults silent to false', async () => {
    const { exec, calls } = makeExec(() => 0);

    await runCli({ version: 'latest', args: [], cwd: '.' }, exec);

    assert.equal(calls[0]!.options.silent, false);
  });

  it('accumulates multi-chunk stdout and stderr in order', async () => {
    const { exec } = makeExec((options) => {
      options.listeners.stdout(Buffer.from('{"val'));
      options.listeners.stdout(Buffer.from('id":true}'));
      options.listeners.stderr(Buffer.from('warn'));
      options.listeners.stderr(Buffer.from('ing'));
      return 0;
    });

    const result = await runCli({ version: 'latest', args: [], cwd: '.' }, exec);

    assert.equal(result.stdout, '{"valid":true}');
    assert.equal(result.stderr, 'warning');
  });

  it('passes through a non-zero exit code without throwing', async () => {
    const { exec } = makeExec(() => 2);

    const result = await runCli({ version: 'latest', args: [], cwd: '.' }, exec);

    assert.equal(result.exitCode, 2);
  });

  it('returns empty strings when the CLI produces no output', async () => {
    const { exec } = makeExec(() => 0);

    const result = await runCli({ version: 'latest', args: [], cwd: '.' }, exec);

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});
