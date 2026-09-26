import type { ValidationReport } from './types.ts';
import type { RunResult } from './runner.ts';

export type ExitClassification = 'success' | 'policy-violation' | 'error';

export function classifyExit(exitCode: number): ExitClassification {
  if (exitCode === 0) return 'success';
  if (exitCode === 2) return 'policy-violation';
  return 'error';
}

// The CLI writes the report to stdout on exit 0 but to stderr on exit 2,
// regardless of --json/--sarif.
export function selectReportText(result: RunResult): string {
  return result.exitCode === 0 ? result.stdout : result.stderr;
}

export interface ParsedReports {
  reports: ValidationReport[];
  emptyRange: boolean;
}

export function parseReport(text: string): ParsedReports {
  const trimmed = text.trim();

  // A healthy CLI always prints a report; fail loudly rather than report a silent green.
  if (trimmed === '') {
    throw new Error('commit-sentinel produced no output');
  }

  // An empty range short-circuits with exit 0 and plain text, even under --json.
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

  // Single-target modes emit one report object; --range/--base emit an array
  // (one report per commit, oldest first).
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

// Persists the full JSON report and returns its path.
export type ReportFileWriter = (json: string) => string;

export interface OutputDeps {
  setOutput: SetOutputFn;
  writeReportFile: ReportFileWriter;
  warning: (msg: string) => void;
}

// GitHub caps a single output value at ~1 MB, approximated in UTF-16 code
// units; we budget conservatively at 1,000,000 UTF-16 bytes (2 bytes per
// code unit). Above the cap, `report-json` is skipped in favor of
// `report-path` rather than emitting a truncated value.
export const MAX_INLINE_REPORT_UTF16_BYTES = 1_000_000;

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

  const reportPath = writeReportFile(json);
  setOutput('report-path', reportPath);

  // GitHub measures the output value in UTF-16 code units, not UTF-8 bytes.
  const utf16Length = Buffer.byteLength(json, 'utf16le');
  if (utf16Length <= MAX_INLINE_REPORT_UTF16_BYTES) {
    setOutput('report-json', json);
  } else {
    setOutput('report-json', '');
    warning(
      `report-json omitted: report is ${utf16Length} UTF-16 bytes, over the ` +
        `${MAX_INLINE_REPORT_UTF16_BYTES}-byte output limit. Read the full report from the ` +
        `"report-path" output (${reportPath}) instead.`,
    );
  }
}

// Backslashes must be escaped first, or a literal "\|" in the cell would be
// seen as an escaped pipe rather than the two characters it is.
function escapeCell(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
}

// Renders a commit header as a Markdown code span. The fence must be longer
// than the longest backtick run it contains; newlines are not allowed inside
// a code span. Pipes need no escaping: a heading is not a table row.
function formatCommitHeading(header: string): string {
  let longestRun = 0;
  for (const match of header.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${header.replaceAll('\n', ' ')}${fence}`;
}

// The CLI has no markdown formatter, so the summary is rendered here from the parsed report.
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

  // The JSON report carries no SHA, so the commit header identifies each commit.
  for (const report of parsed.reports) {
    if (report.results.length === 0) continue;
    lines.push('', `### ${formatCommitHeading(report.commit.header)}`, '');
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
