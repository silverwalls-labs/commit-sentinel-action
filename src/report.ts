import type { ValidationReport } from './types.ts';
import type { RunResult } from './runner.ts';

export type ExitClassification = 'success' | 'policy-violation' | 'error';

export function classifyExit(exitCode: number): ExitClassification {
  if (exitCode === 0) return 'success';
  if (exitCode === 2) return 'policy-violation';
  return 'error';
}

// commit-sentinel writes the report to stdout on success (exit 0) and to
// stderr on validation failure (exit 2) — regardless of --json/--sarif.
export function selectReportText(result: RunResult): string {
  return result.exitCode === 0 ? result.stdout : result.stderr;
}

export interface ParsedReports {
  reports: ValidationReport[];
  emptyRange: boolean;
}

export function parseReport(text: string): ParsedReports {
  const trimmed = text.trim();

  // A healthy CLI always prints a report; silence means something went wrong
  // (e.g. a broken install), so fail loudly rather than report a green run.
  if (trimmed === '') {
    throw new Error('commit-sentinel produced no output');
  }

  // An empty range short-circuits with exit 0 and plain text on stdout,
  // even when --json was requested. Treat it as zero commits validated.
  if (trimmed.startsWith('No commits found in range')) {
    return { reports: [], emptyRange: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `Failed to parse commit-sentinel JSON report (output started with "${trimmed.slice(0, 80)}")`,
      { cause: err },
    );
  }

  // Single-target modes emit one ValidationReport object; --range/--base emit
  // an array (one report per commit, oldest first). Normalize to an array.
  const reports = Array.isArray(parsed)
    ? (parsed as ValidationReport[])
    : [parsed as ValidationReport];
  return { reports, emptyRange: false };
}

export interface Aggregate {
  valid: boolean;
  commitsCount: number;
  errorCount: number;
  warningCount: number;
}

export function aggregate(reports: ValidationReport[]): Aggregate {
  return {
    valid: reports.every((r) => r.valid),
    commitsCount: reports.length,
    errorCount: reports.reduce((sum, r) => sum + r.errorCount, 0),
    warningCount: reports.reduce((sum, r) => sum + r.warningCount, 0),
  };
}

export interface PublishOptions {
  reports: ValidationReport[];
  agg: Aggregate;
  policyPassed: boolean;
}

export type SetOutputFn = (name: string, value: string) => void;

export type SummaryWriter = (markdown: string) => Promise<void>;

// Writes the full JSON report somewhere durable and returns the path to it.
export type ReportFileWriter = (json: string) => string;

export interface OutputDeps {
  setOutput: SetOutputFn;
  writeReportFile: ReportFileWriter;
  warning: (msg: string) => void;
}

// GitHub caps a single output value at ~1 MB (and job-level outputs enforce it
// strictly). Above this we skip the inline `report-json` and point users at the
// `report-path` file instead, rather than emit a silently truncated value.
export const MAX_INLINE_REPORT_BYTES = 1_000_000;

export function setOutputs(opts: PublishOptions, deps: OutputDeps): void {
  const { reports, agg, policyPassed } = opts;
  const { setOutput, writeReportFile, warning } = deps;

  setOutput('valid', String(agg.valid));
  setOutput('commits-count', String(agg.commitsCount));
  setOutput('error-count', String(agg.errorCount));
  setOutput('warning-count', String(agg.warningCount));
  setOutput('policy-passed', String(policyPassed));

  // Always the normalized array, even for single-target runs.
  const json = JSON.stringify(reports);

  // Always persist the full report to a file so large reports remain available
  // regardless of the inline-output size cap.
  const reportPath = writeReportFile(json);
  setOutput('report-path', reportPath);

  // Only expose the inline JSON when it comfortably fits GitHub's output limit.
  // Byte length (not string length) is what counts against the cap.
  const byteLength = Buffer.byteLength(json, 'utf8');
  if (byteLength <= MAX_INLINE_REPORT_BYTES) {
    setOutput('report-json', json);
  } else {
    setOutput('report-json', '');
    warning(
      `report-json omitted: report is ${byteLength} bytes, over the ${MAX_INLINE_REPORT_BYTES}-byte ` +
        `output limit. Read the full report from the "report-path" output (${reportPath}) instead.`,
    );
  }
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

// The CLI has no markdown formatter, so unlike the dependency-guard-action
// template we render the step summary ourselves from the parsed JSON report.
export function renderSummary(parsed: ParsedReports, agg: Aggregate): string {
  const lines: string[] = ['## Commit Sentinel', ''];

  if (parsed.emptyRange) {
    lines.push('No commits found in range — nothing to validate.');
    return lines.join('\n') + '\n';
  }

  const invalidCount = parsed.reports.filter((r) => !r.valid).length;
  const status = agg.valid
    ? '✅ All commits valid'
    : `❌ ${invalidCount} of ${agg.commitsCount} commit(s) invalid`;
  lines.push(`**Status:** ${status}`);
  lines.push(
    `**Commits:** ${agg.commitsCount} · **Errors:** ${agg.errorCount} · **Warnings:** ${agg.warningCount}`,
  );

  // One section per commit that has problems, in CLI order (oldest first).
  // The JSON report carries no SHA, so the commit header is the identifier.
  for (const report of parsed.reports) {
    if (report.results.length === 0) continue;
    lines.push('', `### \`${escapeCell(report.commit.header)}\``, '');
    lines.push('| Severity | Rule | Message | Suggestion |');
    lines.push('| --- | --- | --- | --- |');
    for (const result of report.results) {
      for (const problem of result.problems) {
        const suggestion = problem.suggestion === undefined ? '' : escapeCell(problem.suggestion);
        lines.push(
          `| ${result.severity} | ${escapeCell(result.ruleName)} | ${escapeCell(problem.message)} | ${suggestion} |`,
        );
      }
    }
  }

  return lines.join('\n') + '\n';
}

export async function writeStepSummary(
  markdown: string,
  writer: SummaryWriter,
): Promise<void> {
  if (markdown.trim() === '') return;
  await writer(markdown);
}
