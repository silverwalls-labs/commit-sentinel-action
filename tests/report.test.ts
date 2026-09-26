import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INLINE_REPORT_UTF16_BYTES,
  aggregate,
  classifyExit,
  parseReport,
  renderSummary,
  selectReportText,
  setOutputs,
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
    assert.equal(selectReportText({ exitCode: 0, stdout: 'out', stderr: 'err' }), 'out');
  });

  it('selects stderr on exit 2', () => {
    assert.equal(selectReportText({ exitCode: 2, stdout: '', stderr: 'err' }), 'err');
  });

  it('selects stderr on any other non-zero exit', () => {
    assert.equal(selectReportText({ exitCode: 1, stdout: 'out', stderr: 'err' }), 'err');
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

  it('throws on empty output instead of reporting a silent green', () => {
    assert.throws(() => parseReport('  \n'), /commit-sentinel produced no output/);
  });

  it('throws a descriptive error on malformed JSON', () => {
    assert.throws(() => parseReport('garbage{'), /Failed to parse commit-sentinel JSON report/);
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
    const md = renderSummary({ reports, emptyRange: false }, aggregate(reports));
    assert.match(md, /## Commit Sentinel/);
    assert.match(md, /\*\*Status:\*\* ✅ All commits valid/);
    assert.match(md, /\*\*Commits:\*\* 1 · \*\*Errors:\*\* 0 · \*\*Warnings:\*\* 0/);
    assert.doesNotMatch(md, /###/);
  });

  it('renders one section per problematic commit, with empty suggestion cells', () => {
    const reports = [validReport(), invalidReport()];
    const md = renderSummary({ reports, emptyRange: false }, aggregate(reports));
    assert.match(md, /\*\*Status:\*\* ❌ 1 of 2 commit\(s\) invalid/);
    assert.match(md, /### `bad message`/);
    assert.match(md, /\| Severity \| Rule \| Message \| Suggestion \|/);
    assert.match(md, /\| error \| format \| Commit message must match "type: subject"\. \| Example: feat: add login\. \|/);
    assert.match(md, /\| error \| format \| Second problem without a suggestion\. \|  \|/);
    assert.doesNotMatch(md, /### `feat: add login`/);
  });

  it('renders warning rows for a valid run with warnings', () => {
    const reports = [warnReport()];
    const md = renderSummary({ reports, emptyRange: false }, aggregate(reports));
    assert.match(md, /\*\*Status:\*\* ✅ All commits valid/);
    assert.match(md, /\| warn \| header-max-length \| Header exceeds 100 characters\. \|  \|/);
  });

  it('escapes pipes and newlines in cells, not in the heading', () => {
    const report = invalidReport('bad | header');
    report.results[0]!.problems = [{ message: 'line one\nline two | pipe' }];
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]));
    // A heading is not a table row, so its pipe renders literally.
    assert.match(md, /### `bad \| header`/);
    assert.match(md, /line one<br>line two \\\| pipe/);
  });

  it('escapes a backslash before the pipe it escapes', () => {
    const report = invalidReport();
    report.results[0]!.problems = [{ message: 'a\\|b' }];
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]));
    // "\\" renders as one backslash and "\|" as a literal pipe: a\|b.
    assert.match(md, /\| a\\\\\\\|b \|/);
  });

  it('widens the heading fence around embedded backticks', () => {
    const report = invalidReport('fix: use `backtick`');
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]));
    // A two-backtick fence keeps the inner single backticks inside one span.
    assert.match(md, /### ``fix: use `backtick```/);
  });

  it('flattens a newline in the commit header', () => {
    const report = invalidReport('bad\nmessage');
    const md = renderSummary({ reports: [report], emptyRange: false }, aggregate([report]));
    assert.match(md, /### `bad message`/);
  });

  it('renders the empty-range notice', () => {
    const md = renderSummary({ reports: [], emptyRange: true }, aggregate([]));
    assert.match(md, /No commits found in range — nothing to validate\./);
    assert.doesNotMatch(md, /\*\*Status:\*\*/);
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
