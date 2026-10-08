/** The base class for every error the core raises deliberately. */
export class ForgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The store root is missing, unreachable, or malformed on disk. */
export class StoreError extends ForgeError {}

/** One reason an artifact or store failed validation. */
export interface ValidationIssue {
  /** The offending artifact, relative to the store root (or a label for a loose value). */
  artifact: string;
  /** A JSON-pointer-ish location within the artifact; `''` means the whole artifact. */
  path: string;
  /** A human-readable explanation. */
  message: string;
}

/**
 * Raised when validation fails. Validation is a **hard error**, never a
 * warning-and-continue: the operation aborts and the caller surfaces `issues`.
 */
export class ValidationError extends ForgeError {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const plural = issues.length === 1 ? 'issue' : 'issues';
    super(
      `Store validation failed (${issues.length} ${plural}):\n` +
        issues.map((issue) => `  - ${issue.artifact}${issue.path}: ${issue.message}`).join('\n'),
    );
    this.issues = issues;
  }
}
