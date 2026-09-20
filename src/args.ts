import type { Config, Format, TargetKind } from './inputs.ts';

const TARGET_FLAGS: Record<TargetKind, string> = {
  message: '--message',
  file: '--file',
  commit: '--commit',
  range: '--range',
  base: '--base',
};

export interface BuildArgsOptions {
  // Override the output format, regardless of config.format.
  // Used when we need JSON or SARIF internally for parsing/outputs.
  formatOverride?: Format;
}

export function buildArgs(config: Config, options: BuildArgsOptions = {}): string[] {
  const args: string[] = [];

  args.push(TARGET_FLAGS[config.target.kind], config.target.value);

  // Only forward --config when the user explicitly set it. Otherwise let the
  // CLI resolve its own config file against the cwd we pass via runner options.
  if (config.configPath !== null) {
    args.push('--config', config.configPath);
  }

  // The CLI has no --format flag: human output is the flagless default, and
  // --json / --sarif are mutually exclusive booleans.
  const format = options.formatOverride ?? config.format;
  if (format === 'json') args.push('--json');
  if (format === 'sarif') args.push('--sarif');

  return args;
}
