import * as core from '@actions/core';

export type Format = 'human' | 'json' | 'sarif';

export type TargetKind = 'message' | 'file' | 'commit' | 'range' | 'base';

export interface Target {
  kind: TargetKind;
  value: string;
}

export interface Config {
  version: string;
  workingDirectory: string;
  target: Target;
  configPath: string | null;
  format: Format;
  failOnWarning: boolean;
  summary: boolean;
  sarifFile: string | null;
}

const FORMATS: readonly Format[] = ['human', 'json', 'sarif'];

const TARGET_KINDS: readonly TargetKind[] = ['message', 'file', 'commit', 'range', 'base'];

function readEnum<T extends string>(name: string, allowed: readonly T[]): T | null {
  const raw = core.getInput(name).trim();
  if (raw === '') return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid value "${raw}" for input "${name}". Allowed: ${allowed.join(', ')}.`,
    );
  }
  return raw as T;
}

function readBool(name: string, fallback = false): boolean {
  const raw = core.getInput(name).trim();
  if (raw === '') return fallback;
  return core.getBooleanInput(name);
}

function readString(name: string): string | null {
  const raw = core.getInput(name).trim();
  return raw === '' ? null : raw;
}

// `commit` deliberately has no action.yml default: a YAML default would make it
// always look user-set and break the mutual-exclusion check.
function resolveTarget(): Target {
  const set: Target[] = [];
  for (const kind of TARGET_KINDS) {
    const value = readString(kind);
    if (value !== null) {
      set.push({ kind, value });
    }
  }
  if (set.length > 1) {
    const names = set.map((t) => t.kind).join(', ');
    throw new Error(
      `Inputs ${names} are mutually exclusive; set at most one of: ${TARGET_KINDS.join(', ')}.`,
    );
  }
  return set[0] ?? { kind: 'commit', value: 'HEAD' };
}

export function readInputs(): Config {
  return {
    version: core.getInput('version').trim() || 'latest',
    workingDirectory: core.getInput('working-directory').trim() || '.',
    target: resolveTarget(),
    configPath: readString('config'),
    format: readEnum('format', FORMATS) ?? 'human',
    failOnWarning: readBool('fail-on-warning'),
    summary: readBool('summary', true),
    sarifFile: readString('sarif-file'),
  };
}
