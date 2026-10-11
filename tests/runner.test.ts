import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BUFFER_BYTES, runCli } from '../src/runner.ts';
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
    assert.equal(calls[0]!.options.env.npm_config_loglevel, 'error');
    assert.equal(calls[0]!.options.env.PATH, process.env.PATH);
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

  it('reassembles a multi-byte UTF-8 sequence split across chunks', async () => {
    const whole = Buffer.from('subject 🔥 body', 'utf8');
    // Split inside the 4-byte fire emoji so each chunk ends mid-code-point.
    const fire = Buffer.from('🔥', 'utf8');
    const fireStart = whole.indexOf(fire);
    const split = fireStart + 2;
    const { exec } = makeExec((options) => {
      options.listeners.stdout(whole.subarray(0, split));
      options.listeners.stdout(whole.subarray(split));
      return 0;
    });

    const result = await runCli({ version: 'latest', args: [], cwd: '.' }, exec);

    assert.equal(result.stdout, 'subject 🔥 body');
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
    assert.equal(result.truncated, false);
  });

  it('sets truncated when stdout exceeds the buffer limit (R09)', async () => {
    const bigChunk = Buffer.alloc(MAX_BUFFER_BYTES + 1, 'x');
    const { exec } = makeExec((options) => {
      options.listeners.stdout(bigChunk);
      options.listeners.stdout(Buffer.from('overflow'));
      return 0;
    });

    const result = await runCli({ version: 'latest', args: [], cwd: '.' }, exec);

    assert.equal(result.truncated, true);
    // The first chunk is accepted (even though it's 1 byte over, it's a single push).
    assert.ok(result.stdout.length > 0);
  });

  it('sets truncated when stderr exceeds the buffer limit (R09)', async () => {
    const bigChunk = Buffer.alloc(MAX_BUFFER_BYTES + 1, 'e');
    const { exec } = makeExec((options) => {
      options.listeners.stderr(bigChunk);
      options.listeners.stderr(Buffer.from('overflow'));
      return 0;
    });

    const result = await runCli({ version: 'latest', args: [], cwd: '.' }, exec);

    assert.equal(result.truncated, true);
  });

  it('rejects with a timeout error when the deadline expires (R10)', async () => {
    const exec: ExecFn = async () => {
      // Simulate a hung process that never resolves.
      return new Promise<number>(() => {});
    };

    await assert.rejects(
      runCli({ version: 'latest', args: [], cwd: '.', timeoutMs: 50 }, exec),
      /timed out after 50ms/,
    );
  });
});
