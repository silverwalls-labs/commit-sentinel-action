// Mirrors @silverwalls-labs/commit-sentinel's ValidationReport JSON shape.
// Must track upstream: silverwalls-labs/commit-sentinel/src (search for ValidationReport).

export type Severity = 'off' | 'warn' | 'error';

export type ActiveSeverity = Exclude<Severity, 'off'>;

export interface RuleProblem {
  message: string;
  suggestion?: string;
}

export interface RuleResult {
  ruleName: string;
  severity: ActiveSeverity;
  problems: RuleProblem[];
}

export interface Footer {
  token: string;
  value: string;
}

export interface ParsedCommit {
  raw: string;
  header: string;
  type: string | null;
  scope: string | null;
  breaking: boolean;
  hasBreakingChange: boolean;
  subject: string | null;
  body: string | null;
  footers: Footer[];
}

export interface ValidationReport {
  /** `true` when `errorCount` is zero — warnings do not invalidate a commit. */
  valid: boolean;
  commit: ParsedCommit;
  /** Only rules that found problems appear here. */
  results: RuleResult[];
  errorCount: number;
  warningCount: number;
  skippedGitRules: string[];
}
