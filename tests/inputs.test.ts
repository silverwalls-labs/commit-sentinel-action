import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../src/inputs.ts';

const ORIGINAL_ENV = { ...process.env };

function setInput(name: string, value: string): void {
  process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('readInputs', () => {
  it('returns defaults when no inputs are set, targeting commit HEAD', () => {
    const config = readInputs();
    assert.deepEqual(config, {
      version: 'latest',
      workingDirectory: '.',
      target: { kind: 'commit', value: 'HEAD' },
      configPath: null,
      format: 'human',
      failOnWarning: false,
      summary: true,
      sarifFile: null,
    });
  });

  it('resolves the message target', () => {
    setInput('message', 'feat: add login');
    assert.deepEqual(readInputs().target, { kind: 'message', value: 'feat: add login' });
  });

  it('resolves the file target', () => {
    setInput('file', '.git/COMMIT_EDITMSG');
    assert.deepEqual(readInputs().target, { kind: 'file', value: '.git/COMMIT_EDITMSG' });
  });

  it('resolves the commit target', () => {
    setInput('commit', 'HEAD~1');
    assert.deepEqual(readInputs().target, { kind: 'commit', value: 'HEAD~1' });
  });

  it('resolves the range target', () => {
    setInput('range', 'main..HEAD');
    assert.deepEqual(readInputs().target, { kind: 'range', value: 'main..HEAD' });
  });

  it('resolves the base target', () => {
    setInput('base', 'origin/main');
    assert.deepEqual(readInputs().target, { kind: 'base', value: 'origin/main' });
  });

  it('rejects two source inputs, naming both', () => {
    setInput('message', 'feat: x');
    setInput('commit', 'HEAD');
    assert.throws(
      () => readInputs(),
      /Inputs message, commit are mutually exclusive; set at most one of: message, file, commit, range, base\./,
    );
  });

  it('rejects three source inputs, naming all offenders', () => {
    setInput('message', 'feat: x');
    setInput('range', 'a..b');
    setInput('base', 'main');
    assert.throws(() => readInputs(), /Inputs message, range, base are mutually exclusive/);
  });

  it('accepts each valid format', () => {
    for (const format of ['human', 'json', 'sarif'] as const) {
      setInput('format', format);
      assert.equal(readInputs().format, format);
    }
  });

  it('rejects an unknown format, naming the allowed values', () => {
    setInput('format', 'xml');
    assert.throws(
      () => readInputs(),
      /Invalid value "xml" for input "format"\. Allowed: human, json, sarif\./,
    );
  });

  it('parses booleans, including uppercase, via the actions convention', () => {
    setInput('fail-on-warning', 'TRUE');
    setInput('summary', 'false');
    const config = readInputs();
    assert.equal(config.failOnWarning, true);
    assert.equal(config.summary, false);
  });

  it('rejects a non-boolean value for a boolean input', () => {
    setInput('fail-on-warning', 'yes');
    assert.throws(() => readInputs(), TypeError);
  });

  it('reads version, working-directory, config, and sarif-file overrides', () => {
    setInput('version', '0.2.0');
    setInput('working-directory', 'packages/app');
    setInput('config', 'lint/commit-sentinel.config.ts');
    setInput('sarif-file', 'out/results.sarif');
    const config = readInputs();
    assert.equal(config.version, '0.2.0');
    assert.equal(config.workingDirectory, 'packages/app');
    assert.equal(config.configPath, 'lint/commit-sentinel.config.ts');
    assert.equal(config.sarifFile, 'out/results.sarif');
  });

  it('treats whitespace-only optional inputs as unset', () => {
    setInput('config', '   ');
    setInput('sarif-file', '');
    const config = readInputs();
    assert.equal(config.configPath, null);
    assert.equal(config.sarifFile, null);
  });
});
