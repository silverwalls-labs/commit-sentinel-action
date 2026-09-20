// Mirrors @silverwalls-labs/commit-sentinel's ValidationReport JSON shape.
// Must track upstream: silverwalls-labs/commit-sentinel/src (search for ValidationReport).

/** Rule severity level. `'off'` disables the rule entirely. */
export type Severity = 'off' | 'warn' | 'error';

/** A severity that is actually active (not `'off'`). */
export type ActiveSeverity = Exclude<Severity, 'off'>;

/** A single problem reported by a rule. */
export interface RuleProblem {
  /** What is wrong with the commit. */
  message: string;
  /** Actionable hint on how to fix the problem. */
  suggestion?: string;
}

/** The outcome of a single rule evaluation against a commit. */
export interface RuleResult {
  /** The rule's unique name. */
  ruleName: string;
  /** The severity this rule was configured with. */
  severity: ActiveSeverity;
  /** Problems found by the rule (non-empty). */
  problems: RuleProblem[];
}

/** A commit message footer (e.g. `Reviewed-by`, `BREAKING CHANGE`). */
export interface Footer {
  /** The footer token (e.g. `"Reviewed-by"`, `"BREAKING CHANGE"`, `"Refs"`). */
  token: string;
  /** The footer value after the separator. May span multiple lines. */
  value: string;
}

/** The parsed commit message that was validated. */
export interface ParsedCommit {
  /** The original, unmodified commit message. */
  raw: string;
  /** The first line of the message, trimmed. */
  header: string;
  /** The commit type (e.g. `"feat"`, `"fix"`), or `null` if the header is malformed. */
  type: string | null;
  /** The optional scope (e.g. `"api"`), or `null` if absent. */
  scope: string | null;
  /** `true` when the `!` breaking-change marker appears before the colon. */
  breaking: boolean;
  /** `true` when either the `!` marker is present or a `BREAKING CHANGE` footer exists. */
  hasBreakingChange: boolean;
  /** The subject text after `": "`, or `null` if the header is malformed. */
  subject: string | null;
  /** The commit body (text between the header and footers), or `null` if absent. */
  body: string | null;
  /** Parsed footers, including `BREAKING CHANGE` / `BREAKING-CHANGE`. */
  footers: Footer[];
}

/**
 * Full validation report for a single commit message.
 *
 * `valid` is `true` when there are zero errors (warnings are allowed).
 */
export interface ValidationReport {
  /** `true` when `errorCount` is zero. */
  valid: boolean;
  /** The parsed commit that was validated. */
  commit: ParsedCommit;
  /** Per-rule results — only rules that found problems appear here. */
  results: RuleResult[];
  /** Total number of error-severity problems across all rules. */
  errorCount: number;
  /** Total number of warning-severity problems across all rules. */
  warningCount: number;
  /** Names of rules that were skipped because git metadata was unavailable. */
  skippedGitRules: string[];
}
