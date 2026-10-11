import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs } from '../src/args.ts';
import type { Config } from '../src/inputs.ts';

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

describe('buildArgs', () => {
  it('emits only the commit target for the default config (human = no flag)', () => {
    assert.deepEqual(buildArgs(baseConfig()), ['--commit=HEAD']);
  });

  it('maps the message target', () => {
    const config = baseConfig({ target: { kind: 'message', value: 'feat: add login' } });
    assert.deepEqual(buildArgs(config), ['--message=feat: add login']);
  });

  it('maps the file target', () => {
    const config = baseConfig({ target: { kind: 'file', value: '.git/COMMIT_EDITMSG' } });
    assert.deepEqual(buildArgs(config), ['--file=.git/COMMIT_EDITMSG']);
  });

  it('maps the range target', () => {
    const config = baseConfig({ target: { kind: 'range', value: 'main..HEAD' } });
    assert.deepEqual(buildArgs(config), ['--range=main..HEAD']);
  });

  it('maps the base target', () => {
    const config = baseConfig({ target: { kind: 'base', value: 'origin/main' } });
    assert.deepEqual(buildArgs(config), ['--base=origin/main']);
  });

  it('appends --config after the target when set', () => {
    const config = baseConfig({ configPath: 'commit-sentinel.config.ts' });
    assert.deepEqual(buildArgs(config), ['--commit=HEAD', '--config=commit-sentinel.config.ts']);
  });

  it('appends --json for the json format', () => {
    assert.deepEqual(buildArgs(baseConfig({ format: 'json' })), ['--commit=HEAD', '--json']);
  });

  it('appends --sarif for the sarif format', () => {
    assert.deepEqual(buildArgs(baseConfig({ format: 'sarif' })), ['--commit=HEAD', '--sarif']);
  });

  it('honors a json formatOverride over the configured format', () => {
    const args = buildArgs(baseConfig({ format: 'human' }), { formatOverride: 'json' });
    assert.deepEqual(args, ['--commit=HEAD', '--json']);
  });

  it('honors a sarif formatOverride over the configured format', () => {
    const args = buildArgs(baseConfig({ format: 'json' }), { formatOverride: 'sarif' });
    assert.deepEqual(args, ['--commit=HEAD', '--sarif']);
  });

  it('honors a human formatOverride by emitting no format flag', () => {
    const args = buildArgs(baseConfig({ format: 'json' }), { formatOverride: 'human' });
    assert.deepEqual(args, ['--commit=HEAD']);
  });

  it('orders target, config, and format flags deterministically', () => {
    const config = baseConfig({
      target: { kind: 'base', value: 'origin/main' },
      configPath: 'cfg.ts',
      format: 'human',
    });
    assert.deepEqual(buildArgs(config, { formatOverride: 'json' }), [
      '--base=origin/main',
      '--config=cfg.ts',
      '--json',
    ]);
  });

  it('handles leading-dash values with the = join format (R14)', () => {
    const config = baseConfig({ target: { kind: 'message', value: '--help' } });
    assert.deepEqual(buildArgs(config), ['--message=--help']);
  });
});
