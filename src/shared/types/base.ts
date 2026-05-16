export interface FailureDiagnosticFields {
  technicalCode?: string;
  details?: Record<string, unknown>;
  sensitiveDetails?: Record<string, unknown>;
}

export interface BasicActionResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage: string;
}
