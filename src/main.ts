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
  validateSarifEnvelope,
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
  info: (msg: string) => void;
  // Writes a raw line to stdout, bypassing core.info's annotation wrapper.
  // Used for the workflow-command suspension protocol (R01).
  writeLine: (text: string) => void;
  writeReportFile: ReportFileWriter;
  writeSarifFile: SarifFileWriter;
  writeSummary: SummaryWriter;
}

export async function orchestrate(deps: OrchestrateDeps): Promise<void> {
  const config = deps.readInputs();

  // Pass 1: silent JSON, for outputs and exit classification.
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

  if (jsonRun.truncated) {
    deps.setFailed(
      'commit-sentinel output exceeded the 10 MiB buffer limit and was truncated. ' +
        'Reduce the number of commits validated per run.',
    );
    return;
  }

  const parsed = parseReport(selectReportText(jsonRun));
  const agg = aggregate(parsed.reports);

  const warningTripped = config.failOnWarning && agg.warningCount > 0;
  const policyPassed = classification === 'success' && !warningTripped;

  const skippedGitRules = Array.from(new Set(parsed.reports.flatMap((r) => r.skippedGitRules)));

  // Publish outputs before any setFailed so downstream steps can read them.
  setOutputs(
    { reports: parsed.reports, agg, policyPassed },
    {
      setOutput: deps.setOutput,
      writeReportFile: deps.writeReportFile,
      warning: deps.warning,
    },
  );

  // Pass 2: the user's format, echoed to the log (R01 suspension, R03 single authority).
  let formatPassOutput: string | null = null;
  if (config.format === 'json') {
    deps.info(selectReportText(jsonRun));
  } else {
    const formatRun = await runCli(
      {
        version: config.version,
        args: buildArgs(config),
        cwd: config.workingDirectory,
        silent: true,
      },
      deps.exec,
    );

    // The format pass is informational — policy is determined solely by
    // pass 1. If it disagrees, warn but do not alter the policy (R03).
    if (classifyExit(formatRun.exitCode) === 'error') {
      deps.warning(
        `Format pass exited with code ${formatRun.exitCode}; output may be incomplete.`,
      );
    }

    // Emit captured output inside a workflow-command suspension block (R01).
    const output = formatRun.stdout + formatRun.stderr;
    if (output !== '') {
      const token = crypto.randomUUID();
      deps.writeLine(`::stop-commands::${token}`);
      deps.writeLine(output);
      deps.writeLine(`::${token}::`);
    }

    // If the user chose sarif format and the pass succeeded, capture for
    // potential reuse as the SARIF file to avoid a redundant third pass (R03).
    // When the format pass errored, fall through to a dedicated SARIF pass.
    if (config.format === 'sarif' && classifyExit(formatRun.exitCode) !== 'error') {
      formatPassOutput = selectReportText(formatRun);
    }
  }

  // Step summary — best-effort; a failure here must not block the SARIF
  // artifact or the final policy message (R16).
  if (config.summary) {
    try {
      await writeStepSummary(
        renderSummary(parsed, agg, { policyPassed, skippedGitRules }),
        deps.writeSummary,
      );
    } catch (err: unknown) {
      deps.warning(
        `Failed to write step summary: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // SARIF file — best-effort (R16).
  if (config.sarifFile !== null) {
    try {
      if (parsed.emptyRange) {
        deps.warning('No commits found in range; sarif-file was not written.');
      } else if (config.format === 'sarif' && formatPassOutput !== null) {
        // Reuse the format pass output instead of a redundant third pass (R03).
        writeSarif(config, formatPassOutput, deps);
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
          writeSarif(config, selectReportText(sarifRun), deps);
        }
      }
    } catch (err: unknown) {
      deps.warning(
        `Failed to write SARIF file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Policy failure — always runs regardless of presentation errors (R16).
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

function writeSarif(
  config: Config,
  sarifText: string,
  deps: Pick<OrchestrateDeps, 'setOutput' | 'writeSarifFile' | 'warning'>,
): void {
  // Validate the SARIF envelope before writing (R07).
  const error = validateSarifEnvelope(sarifText);
  if (error !== null) {
    deps.warning(`SARIF output is invalid (${error}); sarif-file was not written.`);
    return;
  }
  const sarifPath = resolve(config.workingDirectory, config.sarifFile!);
  deps.writeSarifFile(sarifPath, sarifText);
  deps.setOutput('sarif-path', sarifPath);
}

// Re-export for the entry-point wiring in index.ts.
export { readInputsImpl as readInputs };
