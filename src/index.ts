import { lstatSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { orchestrate, readInputs } from './main.ts';

orchestrate({
  readInputs,
  exec: (cmd, args, opts) => exec.exec(cmd, args, opts),
  setOutput: (name, value) => core.setOutput(name, value),
  setFailed: (m) => core.setFailed(m),
  error: (m) => core.error(m),
  warning: (m) => core.warning(m),
  info: (m) => core.info(m),
  writeLine: (text) => process.stdout.write(text + '\n'),
  writeReportFile: (json) => {
    // Allocate a unique private directory per invocation so that two steps in
    // one job do not overwrite each other, and symlinks are not followed (R05).
    const base = process.env.RUNNER_TEMP ?? tmpdir();
    const dir = mkdtempSync(join(base, 'commit-sentinel-'));
    const path = join(dir, 'report.json');
    writeFileSync(path, json, { encoding: 'utf8', flag: 'wx' });
    return path;
  },
  writeSarifFile: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    // Refuse to follow symlinks: remove the link so writeFileSync creates a
    // regular file at the path instead of writing through the link (R05).
    // Existing regular files are overwritten — the SARIF path is user-specified
    // and overwriting is the expected behavior.
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) unlinkSync(path);
    writeFileSync(path, contents, 'utf8');
  },
  writeSummary: async (md) => {
    await core.summary.addRaw(md).addEOL().write();
  },
}).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
  // On timeout, force exit: @actions/exec holds stdio pipes open and the
  // child process keeps the event loop alive indefinitely (R10).
  if (message.includes('timed out')) process.exit(1);
});
