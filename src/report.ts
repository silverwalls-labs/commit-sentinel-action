import type { ValidationReport } from './types.ts';
import type { RunResult } from './runner.ts';

export type ExitClassification = 'success' | 'policy-violation' | 'error';

export function classifyExit(exitCode: number): ExitClassification {
  if (exitCode === 0) return 'success';
  if (exitCode === 2) return 'policy-violation';
  return 'error';
}

// CLI ≥ 0.4.0 (F12) routes JSON/SARIF output to stdout regardless of exit
// code; only human format uses stderr on failure.  Prefer stdout, but fall
// back to stderr for backward compatibility with CLI < 0.4.0 (which writes
// the report to stderr on exit 2).
export function selectReportText(result: RunResult): string {
  return result.stdout.trim() !== '' ? result.stdout : result.stderr;
}

export interface ParsedReports {
  reports: ValidationReport[];
  emptyRange: boolean;
}

// ── Runtime report validation (R02) ─────────────────────────────────────────

function assertType(label: string, value: unknown, expected: string): void {
  const actual = typeof value;
  if (actual !== expected) {
    throw new Error(`Report field "${label}" must be ${expected}, got ${actual}`);
  }
}

function assertFiniteNonNegInt(label: string, value: unknown): void {
  assertType(label, value, 'number');
  const n = value as number;
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(
      `Report field "${label}" must be a finite non-negative integer, got ${n}`,
    );
  }
}

function validateReport(data: unknown): ValidationReport {
  if (data === null || typeof data !== 'object') {
    throw new Error(`Report must be an object, got ${data === null ? 'null' : typeof data}`);
  }
  const obj = data as Record<string, unknown>;

  assertType('valid', obj.valid, 'boolean');
  assertFiniteNonNegInt('errorCount', obj.errorCount);
  assertFiniteNonNegInt('warningCount', obj.warningCount);

  // Consistency: valid should equal (errorCount === 0).
  if (obj.valid !== (obj.errorCount === 0)) {
    throw new Error(
      `Report inconsistency: valid=${String(obj.valid)} but errorCount=${String(obj.errorCount)}`,
    );
  }

  if (obj.commit === null || typeof obj.commit !== 'object') {
    throw new Error('Report field "commit" must be an object');
  }
  assertType('commit.header', (obj.commit as Record<string, unknown>).header, 'string');

  if (!Array.isArray(obj.results)) {
    throw new Error('Report field "results" must be an array');
  }

  if (!Array.isArray(obj.skippedGitRules)) {
    throw new Error('Report field "skippedGitRules" must be an array');
  }

  return data as ValidationReport;
}

// ── Report parsing ──────────────────────────────────────────────────────────

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
  const items = Array.isArray(parsed) ? parsed : [parsed];

  // CLI ≥ 0.4.0 (F11) returns [] for empty ranges via JSON.
  if (items.length === 0) {
    return { reports: [], emptyRange: true };
  }

  const reports = items.map((item, i) => {
    try {
      return validateReport(item);
    } catch (err) {
      throw new Error(
        `Invalid report at index ${i}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  });
  return { reports, emptyRange: false };
}

// ── SARIF envelope validation (R07) ─────────────────────────────────────────

// Returns null if valid, or an error description string if not.
export function validateSarifEnvelope(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty output';

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return 'not valid JSON';
  }

  if (parsed === null || typeof parsed !== 'object') return 'not a JSON object';
  const obj = parsed as Record<string, unknown>;

  if (obj.version !== '2.1.0') {
    return `unexpected version "${String(obj.version)}"`;
  }
  if (!Array.isArray(obj.runs)) return '"runs" is not an array';

  return null;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

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

// ── Output publishing ───────────────────────────────────────────────────────

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

// ── Markdown rendering ──────────────────────────────────────────────────────

// Backslashes must be escaped first, or a literal "\|" in the cell would be
// seen as an escaped pipe rather than the two characters it is.
// Also escapes HTML entities to prevent injection (R13), and normalises
// CR/CRLF line endings.
function escapeCell(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
}

// Renders a commit header as a Markdown code span. The fence must be longer
// than the longest backtick run it contains; newlines are not allowed inside
// a code span. Pipes need no escaping: a heading is not a table row.
function formatCommitHeading(header: string): string {
  const content = header.replaceAll('\r\n', ' ').replaceAll('\r', ' ').replaceAll('\n', ' ');
  let longestRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = '`'.repeat(Math.max(longestRun + 1, 1));
  // Per CommonMark, if content starts or ends with a backtick, pad with a
  // space so the backtick is not merged with the fence delimiter (R13).
  const needsPadding = content.startsWith('`') || content.endsWith('`');
  const padded = needsPadding ? ` ${content} ` : content;
  return `${fence}${padded}${fence}`;
}

// GitHub limits step summaries to 1 MiB. We budget conservatively below that
// and truncate on a complete section boundary if exceeded (R08).
export const MAX_SUMMARY_BYTES = 1_000_000;

const TRUNCATION_NOTICE =
  '\n\n> **Note:** Summary truncated. Full report available via the `report-path` output.\n';

export interface SummaryOptions {
  policyPassed: boolean;
  skippedGitRules: string[];
}

// The CLI has no markdown formatter, so the summary is rendered here from the parsed report.
export function renderSummary(
  parsed: ParsedReports,
  agg: Aggregate,
  options: SummaryOptions = { policyPassed: true, skippedGitRules: [] },
): string {
  const lines: string[] = ['## Commit Sentinel', ''];

  if (parsed.emptyRange) {
    lines.push('No commits found in range — nothing to validate.');
    return lines.join('\n') + '\n';
  }

  const invalidCount = parsed.reports.filter((r) => !r.valid).length;

  // Reflect the actual policy result, including fail-on-warning (R15).
  let status: string;
  if (options.policyPassed && agg.valid) {
    status = '✅ All commits valid';
  } else if (!options.policyPassed && agg.valid) {
    status = '⚠️ All commits valid, but policy failed (fail-on-warning)';
  } else {
    status = `❌ ${invalidCount} of ${agg.commitsCount} commit(s) invalid`;
  }
  lines.push(`**Status:** ${status}`);
  lines.push(
    `**Commits:** ${agg.commitsCount} · **Errors:** ${agg.errorCount} · **Warnings:** ${agg.warningCount}`,
  );

  // Show skipped rules if any (R15).
  if (options.skippedGitRules.length > 0) {
    lines.push(
      `**Skipped rules** (not applicable for this input mode): ${options.skippedGitRules.join(', ')}`,
    );
  }

  // Track size to stay within the summary budget (R08).
  const headerSize = Buffer.byteLength(lines.join('\n') + '\n', 'utf8');
  const truncationSize = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
  let currentSize = headerSize;

  // The JSON report carries no SHA, so the commit header identifies each commit.
  for (const report of parsed.reports) {
    if (report.results.length === 0) continue;

    const sectionLines: string[] = [];
    sectionLines.push('', `### ${formatCommitHeading(report.commit.header)}`, '');
    sectionLines.push('| Severity | Rule | Message | Suggestion |');
    sectionLines.push('| --- | --- | --- | --- |');
    for (const result of report.results) {
      for (const problem of result.problems) {
        const suggestion = problem.suggestion === undefined ? '' : escapeCell(problem.suggestion);
        sectionLines.push(
          `| ${result.severity} | ${escapeCell(result.ruleName)} | ${escapeCell(problem.message)} | ${suggestion} |`,
        );
      }
    }

    const sectionText = sectionLines.join('\n');
    const sectionSize = Buffer.byteLength(sectionText, 'utf8');

    if (currentSize + sectionSize + truncationSize > MAX_SUMMARY_BYTES) {
      lines.push(TRUNCATION_NOTICE);
      return lines.join('\n') + '\n';
    }

    lines.push(...sectionLines);
    currentSize += sectionSize;
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
