import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INLINE_REPORT_UTF16_BYTES,
  MAX_SUMMARY_BYTES,
  aggregate,
  classifyExit,
  parseReport,
  renderSummary,
  selectReportText,
  setOutputs,
  validateSarifEnvelope,
  writeStepSummary,
} from '../src/report.ts';
import type { OutputDeps } from '../src/report.ts';
import type { ParsedCommit, ValidationReport } from '../src/types.ts';

function makeCommit(header: string): ParsedCommit {
  return {
    raw: header,
    header,
    type: 'feat',
    scope: null,
    breaking: false,
    hasBreakingChange: false,
    subject: header.replace(/^\w+: /, ''),
    body: null,
    footers: [],
  };
}

function validReport(header = 'feat: add login'): ValidationReport {
  return {
    valid: true,
    commit: makeCommit(header),
    results: [],
    errorCount: 0,
    warningCount: 0,
    skippedGitRules: [],
  };
}

function invalidReport(header = 'bad message'): ValidationReport {
  return {
    valid: false,
    commit: makeCommit(header),
    results: [
      {
        ruleName: 'format',
        severity: 'error',
        problems: [
          {
            message: 'Commit message must match "type: subject".',
            suggestion: 'Example: feat: add login.',
          },
          { message: 'Second problem without a suggestion.' },
        ],
      },
    ],
    errorCount: 2,
    warningCount: 0,
    skippedGitRules: [],
  };
}

function warnReport(header = 'feat: quite a long header'): ValidationReport {
  return {
    valid: true,
    commit: makeCommit(header),
    results: [
      {
        ruleName: 'header-max-length',
        severity: 'warn',
        problems: [{ message: 'Header exceeds 100 characters.' }],
      },
    ],
    errorCount: 0,
    warningCount: 1,
    skippedGitRules: [],
  };
}

const PASSING_OPTIONS = { policyPassed: true, skippedGitRules: [] as string[] };

describe('classifyExit', () => {
  it('classifies exit codes', () => {
    assert.equal(classifyExit(0), 'success');
    assert.equal(classifyExit(2), 'policy-violation');
    assert.equal(classifyExit(1), 'error');
    assert.equal(classifyExit(127), 'error');
  });
});

describe('selectReportText', () => {
  it('selects stdout on exit 0', () => {
    assert.equal(selectReportText({ exitCode: 0, stdout: 'out', stderr: 'err', truncated: false }), 'out');
  });

  it('selects stdout on exit 2 (CLI ≥ 0.4.0 routes JSON/SARIF to stdout)', () => {
    assert.equal(selectReportText({ exitCode: 2, stdout: 'out', stderr: 'err', truncated: false }), 'out');
  });

  it('selects stdout on any non-zero exit', () => {
    assert.equal(selectReportText({ exitCode: 1, stdout: 'out', stderr: 'err', truncated: false }), 'out');
  });

  it('falls back to stderr when stdout is empty (backward compat with CLI < 0.4.0)', () => {
    assert.equal(selectReportText({ exitCode: 2, stdout: '', stderr: 'report', truncated: false }), 'report');
  });

  it('falls back to stderr when stdout is whitespace-only', () => {
    assert.equal(selectReportText({ exitCode: 2, stdout: '  \n', stderr: 'report', truncated: false }), 'report');
  });
});

describe('parseReport', () => {
  it('normalizes a single report object into a one-element array', () => {
    const report = validReport();
    const parsed = parseReport(JSON.stringify(report) + '\n');
    assert.equal(parsed.emptyRange, false);
    assert.deepEqual(parsed.reports, [report]);
  });

  it('passes a report array through', () => {
    const reports = [validReport(), invalidReport()];
    const parsed = parseReport(JSON.stringify(reports));
    assert.equal(parsed.emptyRange, false);
    assert.deepEqual(parsed.reports, reports);
  });

  it('treats the empty-range plain-text output as zero commits', () => {
    const parsed = parseReport('No commits found in range "main..HEAD".\n');
    assert.deepEqual(parsed, { reports: [], emptyRange: true });
  });

  it('treats an empty JSON array as an empty range (CLI ≥ 0.4.0 F11)', () => {
    const parsed = parseReport('[]');
    assert.deepEqual(parsed, { reports: [], emptyRange: true });
  });

  it('throws on empty output instead of reporting a silent green', () => {
    assert.throws(() => parseReport('  \n'), /commit-sentinel produced no output/);
  });

  it('throws a descriptive error on malformed JSON', () => {
    assert.throws(() => parseReport('garbage{'), /Failed to parse commit-sentinel JSON report/);
  });

  it('neutralizes workflow-command syntax in the parse-error preview (R01)', () => {
    assert.throws(
      () => parseReport('garbage\n::error::FORGED ##[error]LEGACY'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // No newline-started :: command and no mid-line ##[ sequence can
        // survive into the annotation text.
        assert.ok(!err.message.includes('\n::'));
        assert.ok(!err.message.includes('##['));
        assert.match(err.message, /::error::FORGED ## \[error\]LEGACY/);
        return true;
      },
    );
  });
});

describe('parseReport validation (R02)', () => {
  it('rejects null', () => {
    assert.throws(() => parseReport('null'), /Report must be an object, got null/);
  });

  it('rejects a number', () => {
    assert.throws(() => parseReport('42'), /Report must be an object, got number/);
  });

  it('rejects valid as a string', () => {
    const report = { ...validReport(), valid: 'false' };
    assert.throws(() => parseReport(JSON.stringify(report)), /Report field "valid" must be boolean/);
  });

  it('rejects NaN errorCount', () => {
    const report = { ...validReport(), errorCount: NaN };
    // NaN serialises as null in JSON, causing a type error.
    assert.throws(() => parseReport(JSON.stringify(report)), /must be a finite non-negative integer|must be number/);
  });

  it('rejects negative warningCount', () => {
    const report = { ...validReport(), warningCount: -5 };
    assert.throws(() => parseReport(JSON.stringify(report)), /must be a finite non-negative integer/);
  });

  it('rejects inconsistent valid/errorCount', () => {
    const report = { ...invalidReport(), valid: true };
    assert.throws(() => parseReport(JSON.stringify(report)), /Report inconsistency/);
  });

  it('rejects missing commit', () => {
    const { commit: _, ...rest } = validReport();
    assert.throws(() => parseReport(JSON.stringify(rest)), /Report field "commit" must be an object/);
  });

  it('rejects commit without header', () => {
    const report = { ...validReport(), commit: {} };
    assert.throws(() => parseReport(JSON.stringify(report)), /Report field "commit.header" must be string/);
  });

  it('rejects results that is not an array', () => {
    const report = { ...validReport(), results: 'bad' };
    assert.throws(() => parseReport(JSON.stringify(report)), /Report field "results" must be an array/);
  });

  it('rejects skippedGitRules that is not an array', () => {
    const report = { ...validReport(), skippedGitRules: 'bad' };
    assert.throws(() => parseReport(JSON.stringify(report)), /Report field "skippedGitRules" must be an array/);
  });

  it('accepts a fully populated nested report', () => {
    const report = invalidReport();
    const parsed = parseReport(JSON.stringify(report));
    assert.deepEqual(parsed.reports, [report]);
  });

  it('rejects a results item that is not an object', () => {
    const report = { ...validReport(), results: ['bad'] };
    assert.throws(() => parseReport(JSON.stringify(report)), /Report field "results\[0\]" must be an object/);
  });

  it('rejects a result with a non-string ruleName', () => {
    const report = { ...validReport(), results: [{ severity: 'warn', problems: [] }] };
    assert.throws(() => parseReport(JSON.stringify(report)), /results\[0\].ruleName" must be string/);
  });

  it('rejects a result with a non-string severity', () => {
    const report = { ...validReport(), results: [{ ruleName: 'format', severity: 3, problems: [] }] };
    assert.throws(() => parseReport(JSON.stringify(report)), /results\[0\].severity" must be string/);
  });

  it('rejects a result with problems that is not an array', () => {
    const report = { ...validReport(), results: [{ ruleName: 'format', severity: 'warn', problems: 'bad' }] };
    assert.throws(() => parseReport(JSON.stringify(report)), /results\[0\].problems" must be an array/);
  });

  it('rejects a problem that is not an object', () => {
    const report = { ...validReport(), results: [{ ruleName: 'format', severity: 'warn', problems: ['bad'] }] };
    assert.throws(() => parseReport(JSON.stringify(report)), /problems\[0\]" must be an object/);
  });

  it('rejects a problem without a message', () => {
    const report = { ...validReport(), results: [{ ruleName: 'format', severity: 'warn', problems: [{ suggestion: 'x' }] }] };
    assert.throws(() => parseReport(JSON.stringify(report)), /problems\[0\].message" must be string/);
  });

  it('rejects a problem with a non-string suggestion', () => {
    const report = { ...validReport(), results: [{ ruleName: 'format', severity: 'warn', problems: [{ message: 'm', suggestion: 7 }] }] };
    assert.throws(() => parseReport(JSON.stringify(report)), /problems\[0\].suggestion" must be string/);
  });

  it('rejects a non-string skippedGitRules element', () => {
    const report = { ...validReport(), skippedGitRules: ['signed', 7] };
    assert.throws(() => parseReport(JSON.stringify(report)), /skippedGitRules\[1\]" must be string/);
  });

  it('wraps per-item validation errors with the index', () => {
    const reports = [validReport(), { bad: true }];
    assert.throws(() => parseReport(JSON.stringify(reports)), /Invalid report at index 1/);
  });
});

describe('validateSarifEnvelope (R07)', () => {
  it('accepts a valid SARIF envelope', () => {
    assert.equal(validateSarifEnvelope('{"version":"2.1.0","runs":[]}'), null);
  });

  it('rejects empty output', () => {
    assert.equal(validateSarifEnvelope(''), 'empty output');
  });

  it('rejects non-JSON', () => {
    assert.equal(validateSarifEnvelope('not json'), 'not valid JSON');
  });

  it('rejects a non-object', () => {
    assert.equal(validateSarifEnvelope('"hello"'), 'not a JSON object');
  });

  it('rejects wrong version', () => {
    assert.equal(validateSarifEnvelope('{"version":"1.0.0","runs":[]}'), 'unexpected version "1.0.0"');
  });

  it('neutralizes workflow-command syntax in the version message (R01)', () => {
    const error = validateSarifEnvelope('{"version":"##[error]FORGED","runs":[]}');
    assert.ok(error !== null);
    assert.ok(!error.includes('##['));
    assert.match(error, /## \[error\]FORGED/);
  });

  it('rejects missing runs', () => {
    assert.equal(validateSarifEnvelope('{"version":"2.1.0"}'), '"runs" is not an array');
  });
});

describe('aggregate', () => {
  it('is vacuously valid for zero reports', () => {
    assert.deepEqual(aggregate([]), {
      valid: true,
      commitsCount: 0,
      errorCount: 0,
      warningCount: 0,
    });
  });

  it('sums counts and ANDs validity', () => {
    assert.deepEqual(aggregate([validReport(), invalidReport(), warnReport()]), {
      valid: false,
      commitsCount: 3,
      errorCount: 2,
      warningCount: 1,
    });
  });

  it('stays valid when every report is valid', () => {
    assert.equal(aggregate([validReport(), warnReport()]).valid, true);
  });
});

interface CollectedOutputs {
  deps: OutputDeps;
  outputs: Map<string, string>;
  warnings: string[];
  reportWrites: string[];
}

function collect(): CollectedOutputs {
  const outputs = new Map<string, string>();
  const warnings: string[] = [];
  const reportWrites: string[] = [];
  return {
    deps: {
      setOutput: (name, value) => {
        outputs.set(name, value);
      },
      warning: (msg) => {
        warnings.push(msg);
      },
      writeReportFile: (json) => {
        reportWrites.push(json);
        return '/tmp/commit-sentinel-report.json';
      },
    },
    outputs,
    warnings,
    reportWrites,
  };
}

describe('setOutputs', () => {
  it('publishes every output as a string', () => {
    const reports = [invalidReport()];
    const ctx = collect();

    setOutputs({ reports, agg: aggregate(reports), policyPassed: false }, ctx.deps);

    assert.equal(ctx.outputs.get('valid'), 'false');
    assert.equal(ctx.outputs.get('commits-count'), '1');
    assert.equal(ctx.outputs.get('error-count'), '2');
    assert.equal(ctx.outputs.get('warning-count'), '0');
    assert.equal(ctx.outputs.get('policy-passed'), 'false');
    assert.equal(ctx.outputs.get('report-json'), JSON.stringify(reports));
    assert.equal(ctx.outputs.get('report-path'), '/tmp/commit-sentinel-report.json');
    assert.deepEqual(ctx.reportWrites, [JSON.stringify(reports)]);
    assert.equal(ctx.warnings.length, 0);
  });

  it('inlines the report at exactly the UTF-16 byte cap', () => {
    // 500,000 ASCII chars = 1,000,000 UTF-16 bytes: right at the cap.
    const base = validReport();
    base.commit.raw = '';
    const bareLength = JSON.stringify([base]).length;
    base.commit.raw = 'x'.repeat(MAX_INLINE_REPORT_UTF16_BYTES / 2 - bareLength);
    const reports = [base];
    const ctx = collect();

    setOutputs({ reports, agg: aggregate(reports), policyPassed: true }, ctx.deps);

    assert.equal(ctx.outputs.get('report-json'), JSON.stringify(reports));
    assert.equal(ctx.warnings.length, 0);
  });

  it('omits the inline report one UTF-16 unit over the cap but still writes the file', () => {
    // 500,001 ASCII chars = 1,000,002 UTF-16 bytes: over the cap even though
    // the UTF-8 byte count (500,001) sits well under 1 MB.
    const base = validReport();
    base.commit.raw = '';
    const bareLength = JSON.stringify([base]).length;
    base.commit.raw = 'x'.repeat(MAX_INLINE_REPORT_UTF16_BYTES / 2 - bareLength + 1);
    const reports = [base];
    const ctx = collect();

    setOutputs({ reports, agg: aggregate(reports), policyPassed: true }, ctx.deps);

    assert.equal(ctx.outputs.get('report-json'), '');
    assert.equal(ctx.outputs.get('report-path'), '/tmp/commit-sentinel-report.json');
    assert.deepEqual(ctx.reportWrites, [JSON.stringify(reports)]);
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0]!, /UTF-16 bytes, over the 1000000-byte output limit/);
  });

  it('omits a multibyte-heavy report over the cap', () => {
    // Each BMP char is one UTF-16 unit, so this measures at twice the cap's
    // character budget, not its UTF-8 byte count.
    const big = validReport();
    big.commit.raw = 'é'.repeat(MAX_INLINE_REPORT_UTF16_BYTES / 2 + 1);
    const reports = [big];
    const ctx = collect();

    setOutputs({ reports, agg: aggregate(reports), policyPassed: true }, ctx.deps);

    assert.equal(ctx.outputs.get('report-json'), '');
    assert.equal(ctx.warnings.length, 1);
  });
});

describe('renderSummary', () => {
  it('renders a fully valid run with no violation tables', () => {
    const reports = [validReport()];
    const md = renderSummary({ reports, emptyRange: false }, aggregate(reports), PASSING_OPTIONS);
    assert.match(md, /## Commit Sentinel/);
    assert.match(md, /\*\*Status:\*\* ✅ All commits valid/);
    assert.match(md, /\*\*Commits:\*\* 1 · \*\*Errors:\*\* 0 · \*\*Warnings:\*\* 0/);
    assert.doesNotMatch(md, /###/);
  });

  it('renders one section per problematic commit, with empty suggestion cells', () => {
    const reports = [validReport(), invalidReport()];
    const md = renderSummary({ reports, emptyRange: false }, aggregate(reports), PASSING_OPTIONS);
    assert.match(md, /\*\*Status:\*\* ❌ 1 of 2 commit\(s\) invalid/);
    assert.match(md, /### `bad message`/);
    assert.match(md, /\| Severity \| Rule \| Message \| Suggestion \|/);
    assert.match(md, /\| error \| format \| Commit message must match "type: subject"\. \| Example: feat: add login\. \|/);
    assert.match(md, /\| error \| format \| Second problem without a suggestion\. \|  \|/);
    assert.doesNotMatch(md, /### `feat: add login`/);
  });

  it('renders warning rows for a valid run with warnings', () => {
    const reports = [warnReport()];
    const md = renderSummary({ reports, emptyRange: false }, aggregate(reports), PASSING_OPTIONS);
    assert.match(md, /\*\*Status:\*\* ✅ All commits valid/);
    assert.match(md, /\| warn \| header-max-length \| Header exceeds 100 characters\. \|  \|/);
  });

  it('escapes pipes and newlines in cells, not in the heading', () => {
    const report = invalidReport('bad | header');
    report.results[0]!.problems = [{ message: 'line one\nline two | pipe' }];
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]), PASSING_OPTIONS);
    // A heading is not a table row, so its pipe renders literally.
    assert.match(md, /### `bad \| header`/);
    assert.match(md, /line one<br>line two \\\| pipe/);
  });

  it('escapes a backslash before the pipe it escapes', () => {
    const report = invalidReport();
    report.results[0]!.problems = [{ message: 'a\\|b' }];
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]), PASSING_OPTIONS);
    // "\\" renders as one backslash and "\|" as a literal pipe: a\|b.
    assert.match(md, /\| a\\\\\\\|b \|/);
  });

  it('widens the heading fence around embedded backticks with padding (R13)', () => {
    const report = invalidReport('fix: use `backtick`');
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]), PASSING_OPTIONS);
    // A two-backtick fence with space padding keeps the inner backticks safe.
    assert.match(md, /### `` fix: use `backtick` ``/);
  });

  it('flattens a newline in the commit header', () => {
    const report = invalidReport('bad\nmessage');
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]), PASSING_OPTIONS);
    assert.match(md, /### `bad message`/);
  });

  it('renders the empty-range notice', () => {
    const md = renderSummary({ reports: [], emptyRange: true }, aggregate([]), PASSING_OPTIONS);
    assert.match(md, /No commits found in range — nothing to validate\./);
    assert.doesNotMatch(md, /\*\*Status:\*\*/);
  });

  it('shows policy failure when fail-on-warning trips on a valid run (R15)', () => {
    const reports = [warnReport()];
    const md = renderSummary({ reports, emptyRange: false }, aggregate(reports), {
      policyPassed: false,
      skippedGitRules: [],
    });
    assert.match(md, /⚠️ All commits valid, but policy failed \(fail-on-warning\)/);
  });

  it('shows skipped rules when present (R15)', () => {
    const reports = [validReport()];
    const md = renderSummary({ reports, emptyRange: false }, aggregate(reports), {
      policyPassed: true,
      skippedGitRules: ['signed', 'author-email'],
    });
    assert.match(md, /\*\*Skipped rules\*\*.*signed, author-email/);
  });

  it('escapes skipped rule names (R13)', () => {
    const md = renderSummary({ reports: [], emptyRange: false }, aggregate([]), {
      policyPassed: true,
      skippedGitRules: ['<b>signed</b>'],
    });
    assert.match(md, /&lt;b&gt;signed&lt;\/b&gt;/);
    assert.doesNotMatch(md, /<b>/);
  });

  it('escapes HTML in cells (R13)', () => {
    const report = invalidReport();
    report.results[0]!.problems = [{ message: '<script>alert(1)</script>' }];
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]), PASSING_OPTIONS);
    assert.match(md, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(md, /<script>/);
  });

  it('normalizes CR/CRLF in cells (R13)', () => {
    const report = invalidReport();
    report.results[0]!.problems = [{ message: 'line1\r\nline2\rline3' }];
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]), PASSING_OPTIONS);
    assert.match(md, /line1<br>line2<br>line3/);
  });

  it('truncates oversized summaries with a notice (R08)', () => {
    // Create enough reports to exceed the budget.
    const reports = Array.from({ length: 5000 }, (_, i) => {
      const r = invalidReport(`bad message ${i} ${'x'.repeat(100)}`);
      return r;
    });
    const md = renderSummary({ reports, emptyRange: false }, aggregate(reports), PASSING_OPTIONS);
    // Without truncation, 5000 reports would produce several MB.
    // The truncated summary should be roughly within 2× the budget.
    assert.ok(
      Buffer.byteLength(md, 'utf8') < MAX_SUMMARY_BYTES * 2,
      `summary is ${Buffer.byteLength(md, 'utf8')} bytes, expected < ${MAX_SUMMARY_BYTES * 2}`,
    );
    assert.match(md, /Summary truncated/);
    // Verify we did include some commit sections (not just the header).
    assert.match(md, /###/);
  });
});

describe('writeStepSummary', () => {
  it('writes non-empty markdown', async () => {
    const writes: string[] = [];
    await writeStepSummary('# report\n', async (md) => {
      writes.push(md);
    });
    assert.deepEqual(writes, ['# report\n']);
  });

  it('skips whitespace-only markdown', async () => {
    const writes: string[] = [];
    await writeStepSummary('  \n ', async (md) => {
      writes.push(md);
    });
    assert.equal(writes.length, 0);
  });
});
