import type { Config, Format, TargetKind } from './inputs.ts';

const TARGET_FLAGS: Record<TargetKind, string> = {
  message: '--message',
  file: '--file',
  commit: '--commit',
  range: '--range',
  base: '--base',
};

export interface BuildArgsOptions {
  formatOverride?: Format;
}

export function buildArgs(config: Config, options: BuildArgsOptions = {}): string[] {
  const args: string[] = [];

  args.push(TARGET_FLAGS[config.target.kind], config.target.value);

  // When unset, the CLI resolves its own config against the runner cwd.
  if (config.configPath !== null) {
    args.push('--config', config.configPath);
  }

  // The CLI has no --format flag: human is the flagless default.
  const format = options.formatOverride ?? config.format;
  if (format === 'json') args.push('--json');
  if (format === 'sarif') args.push('--sarif');

  return args;
}
