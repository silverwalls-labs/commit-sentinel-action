export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  version: string;
  args: string[];
  cwd: string;
  silent?: boolean;
}

export interface ExecOptions {
  cwd: string;
  ignoreReturnCode: boolean;
  silent: boolean;
  listeners: {
    stdout: (data: Buffer) => void;
    stderr: (data: Buffer) => void;
  };
}

export type ExecFn = (
  command: string,
  args: string[],
  options: ExecOptions,
) => Promise<number>;

export async function runCli(opts: RunOptions, exec: ExecFn): Promise<RunResult> {
  let stdout = '';
  let stderr = '';

  const exitCode = await exec(
    'npx',
    ['--yes', `@silverwalls-labs/commit-sentinel@${opts.version}`, ...opts.args],
    {
      cwd: opts.cwd,
      ignoreReturnCode: true,
      silent: opts.silent ?? false,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
        stderr: (data: Buffer) => {
          stderr += data.toString();
        },
      },
    },
  );

  return { exitCode, stdout, stderr };
}
