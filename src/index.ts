import { mkdirSync, writeFileSync } from 'node:fs';
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
  writeReportFile: (json) => {
    const dir = process.env.RUNNER_TEMP ?? tmpdir();
    const path = join(dir, 'commit-sentinel-report.json');
    writeFileSync(path, json, 'utf8');
    return path;
  },
  writeSarifFile: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  },
  writeSummary: async (md) => {
    await core.summary.addRaw(md).addEOL().write();
  },
}).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
