export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if either stream was truncated because it exceeded the buffer limit. */
  truncated: boolean;
}

export interface RunOptions {
  version: string;
  args: string[];
  cwd: string;
  silent?: boolean;
  /** Execution deadline in milliseconds. Defaults to 5 minutes (300 000 ms). */
  timeoutMs?: number;
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

// Per-stream byte budget. When a stream exceeds this, remaining chunks are
// silently dropped and the `truncated` flag is set on RunResult (R09).
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// Default execution deadline. The action fails cleanly when the CLI hangs
// rather than waiting for an external job timeout (R10).
export const DEFAULT_TIMEOUT_MS = 300_000;

export async function runCli(opts: RunOptions, exec: ExecFn): Promise<RunResult> {
  // Buffer the chunks and decode once per stream: decoding each chunk in
  // isolation corrupts a multi-byte UTF-8 sequence split across chunks.
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const execPromise = exec(
    'npx',
    ['--yes', `@silverwalls-labs/commit-sentinel@${opts.version}`, ...opts.args],
    {
      cwd: opts.cwd,
      ignoreReturnCode: true,
      silent: opts.silent ?? false,
      // Suppress npm warn/notice chatter: on exit 2 the report is read from
      // stdout and must parse, and a cold-cache npx can print install noise
      // on stderr. process.env must be spread along or the child loses PATH
      // and npx can no longer resolve.
      env: { ...process.env, npm_config_loglevel: 'error' },
      listeners: {
        stdout: (data: Buffer) => {
          if (stdoutBytes < MAX_BUFFER_BYTES) {
            stdoutChunks.push(data);
            stdoutBytes += data.length;
          } else {
            truncated = true;
          }
        },
        stderr: (data: Buffer) => {
          if (stderrBytes < MAX_BUFFER_BYTES) {
            stderrChunks.push(data);
            stderrBytes += data.length;
          } else {
            truncated = true;
          }
        },
      },
    },
  );

  // Race the exec against a deadline so a hung CLI fails cleanly (R10).
  const exitCode = await Promise.race([
    execPromise,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`commit-sentinel timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ).unref();
    }),
  ]);

  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    truncated,
  };
}
