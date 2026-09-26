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
  env: Record<string, string>;
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
  // Buffer the chunks and decode once per stream: decoding each chunk in
  // isolation corrupts a multi-byte UTF-8 sequence split across chunks.
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const exitCode = await exec(
    'npx',
    ['--yes', `@silverwalls-labs/commit-sentinel@${opts.version}`, ...opts.args],
    {
      cwd: opts.cwd,
      ignoreReturnCode: true,
      silent: opts.silent ?? false,
      // Suppress npm warn/notice chatter: on exit 2 the report is read from
      // stderr and must parse, and a cold-cache npx can print install noise
      // there. process.env must be spread along or the child loses PATH and
      // npx can no longer resolve.
      env: { ...process.env, npm_config_loglevel: 'error' },
      listeners: {
        stdout: (data: Buffer) => {
          stdoutChunks.push(data);
        },
        stderr: (data: Buffer) => {
          stderrChunks.push(data);
        },
      },
    },
  );

  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
  };
}
