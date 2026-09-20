import { resolve } from 'node:path';
import { readInputs as readInputsImpl } from './inputs.ts';
import type { Config } from './inputs.ts';
import { buildArgs } from './args.ts';
import { runCli } from './runner.ts';
import type { ExecFn } from './runner.ts';
import {
  aggregate,
  classifyExit,
  parseReport,
  renderSummary,
  selectReportText,
  setOutputs,
  writeStepSummary,
} from './report.ts';
import type { ReportFileWriter, SetOutputFn, SummaryWriter } from './report.ts';

// Writes the SARIF report, creating parent directories as needed.
export type SarifFileWriter = (path: string, contents: string) => void;

export interface OrchestrateDeps {
  readInputs: () => Config;
  exec: ExecFn;
  setOutput: SetOutputFn;
  setFailed: (msg: string) => void;
  error: (msg: string) => void;
  warning: (msg: string) => void;
  writeReportFile: ReportFileWriter;
  writeSarifFile: SarifFileWriter;
  writeSummary: SummaryWriter;
}

export async function orchestrate(deps: OrchestrateDeps): Promise<void> {
  const config = deps.readInputs();

  // First pass: silent JSON, for outputs and exit classification.
  const jsonRun = await runCli(
    {
      version: config.version,
      args: buildArgs(config, { formatOverride: 'json' }),
      cwd: config.workingDirectory,
      silent: true,
    },
    deps.exec,
  );

  const classification = classifyExit(jsonRun.exitCode);

  if (classification === 'error') {
    if (jsonRun.stderr.trim() !== '') deps.error(jsonRun.stderr.trim());
    deps.setFailed(
      `commit-sentinel exited with code ${jsonRun.exitCode}. See logs above.`,
    );
    return;
  }

  const parsed = parseReport(selectReportText(jsonRun));
  const agg = aggregate(parsed.reports);

  const warningTripped = config.failOnWarning && agg.warningCount > 0;
  const policyPassed = classification === 'success' && !warningTripped;

  // Publish outputs before any setFailed so downstream steps can read them.
  setOutputs(
    { reports: parsed.reports, agg, policyPassed },
    {
      setOutput: deps.setOutput,
      writeReportFile: deps.writeReportFile,
      warning: deps.warning,
    },
  );

  // Second pass: the user's format, echoed to the log. Re-running the CLI keeps
  // the output consistent with its own renderer instead of re-rendering JSON here.
  await runCli(
    {
      version: config.version,
      args: buildArgs(config),
      cwd: config.workingDirectory,
      silent: false,
    },
    deps.exec,
  );

  if (config.summary) {
    await writeStepSummary(renderSummary(parsed, agg), deps.writeSummary);
  }

  if (config.sarifFile !== null) {
    if (parsed.emptyRange) {
      // An empty range makes the CLI print plain text, not SARIF.
      deps.warning('No commits found in range; sarif-file was not written.');
    } else {
      const sarifRun = await runCli(
        {
          version: config.version,
          args: buildArgs(config, { formatOverride: 'sarif' }),
          cwd: config.workingDirectory,
          silent: true,
        },
        deps.exec,
      );
      if (classifyExit(sarifRun.exitCode) === 'error') {
        deps.warning(
          `SARIF pass exited with code ${sarifRun.exitCode}; sarif-file was not written.`,
        );
      } else {
        const sarifPath = resolve(config.workingDirectory, config.sarifFile);
        deps.writeSarifFile(sarifPath, selectReportText(sarifRun));
        deps.setOutput('sarif-path', sarifPath);
      }
    }
  }

  if (classification === 'policy-violation') {
    deps.setFailed(
      `Commit validation failed: ${agg.errorCount} error(s) across ${agg.commitsCount} commit(s).`,
    );
  } else if (warningTripped) {
    deps.warning(
      `fail-on-warning is enabled and ${agg.warningCount} warning(s) were reported.`,
    );
    deps.setFailed('Commit validation reported warnings and fail-on-warning is enabled.');
  }
}

// Re-export for the entry-point wiring in index.ts.
export { readInputsImpl as readInputs };
