import type {
  ConversationDiagnosticFileSummary,
  ConversationDiagnosticReportPreview,
  DesktopErrorReportFileSummary,
  DesktopErrorReportPreview,
  SubmitConversationDiagnosticReportResult,
} from '../../shared/types';
import { normalizeErrorReportDiagnostic } from '../../shared/error-diagnostics';
import { sanitizeReportPayload, type ReportSanitizerRoot } from '../../shared/report-sanitizer';
import { buildBackendHeaders, responseRequestId } from './client-helpers';

type AppendReportingLog = (event: string, details: Record<string, unknown>) => Promise<void>;

interface ReportSubmissionOptions {
  backendBaseUrl: string;
  token?: string;
  roots: ReportSanitizerRoot[];
  appendReportingLog: AppendReportingLog;
}

export interface ConversationDiagnosticAttachmentUpload extends ConversationDiagnosticFileSummary {
  text: string;
}

export interface DesktopErrorReportAttachmentUpload extends DesktopErrorReportFileSummary {
  text: string;
}

export const submitDesktopErrorReport = async (
  options: ReportSubmissionOptions,
  input: DesktopErrorReportPreview,
  attachments: DesktopErrorReportAttachmentUpload[] = [],
): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> => {
  const report = sanitizeReportPayload(normalizeErrorReportDiagnostic(input), { roots: options.roots });
  const logBase = {
    operation: 'desktop_error_report.submit',
    source: report.source,
    reportOperation: report.operation,
    technicalCode: report.technicalCode,
    appId: report.appId,
    appVersion: report.appVersion,
    desktopVersion: report.desktopVersion,
    platform: report.platform,
    arch: report.arch,
    diagnosticFileCount: attachments.length || report.diagnosticFiles?.length || 0,
  };
  try {
    const body = buildDesktopErrorReportBody(report, attachments, options.roots);
    const response = await fetch(`${options.backendBaseUrl}/api/v1/desktop_error_reports`, {
      method: 'POST',
      headers: body.headers,
      body: body.body,
    });
    const requestId = responseRequestId(response);

    if (!response.ok) {
      const technicalCode = `desktop_error_report_failed_${response.status}`;
      await options.appendReportingLog('desktop_error_report:submit_failed', {
        ...logBase,
        success: false,
        httpStatus: response.status,
        requestId,
        technicalCode,
      });
      return { success: false, userMessage: 'No pudimos enviar el reporte.', technicalCode };
    }

    await options.appendReportingLog('desktop_error_report:submit_success', {
      ...logBase,
      success: true,
      httpStatus: response.status,
      requestId,
    });
    return { success: true, userMessage: 'Reporte enviado. Gracias por ayudarnos a corregir Forger.' };
  } catch (error) {
    const technicalCode = 'desktop_error_report_network_failed';
    await options.appendReportingLog('desktop_error_report:submit_failed', {
      ...logBase,
      success: false,
      technicalCode,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { success: false, userMessage: 'No pudimos enviar el reporte.', technicalCode };
  }
};

const buildDesktopErrorReportBody = (
  report: DesktopErrorReportPreview,
  attachments: DesktopErrorReportAttachmentUpload[],
  roots: ReportSanitizerRoot[],
): { headers: HeadersInit; body: BodyInit } => {
  const diagnosticFiles = attachments.length > 0
    ? attachments.map(({ text: _text, ...summary }) => summary)
    : report.diagnosticFiles;
  const payload = {
    source: report.source,
    operation: report.operation,
    message: report.message,
    technical_code: report.technicalCode,
    desktop_version: report.desktopVersion,
    platform: report.platform,
    arch: report.arch,
    app_id: report.appId,
    app_version: report.appVersion,
    details: {
      ...(report.details ?? {}),
      ...(diagnosticFiles && diagnosticFiles.length > 0 ? { diagnosticFiles } : {}),
    },
    sensitive_details: report.sensitiveDetails ?? {},
  };
  if (attachments.length === 0) {
    return {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    };
  }

  const formData = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) {
      continue;
    }
    formData.append(key, key === 'details' || key === 'sensitive_details' ? JSON.stringify(value) : String(value));
  }
  for (const attachment of attachments) {
    const text = sanitizeReportPayload(attachment.text, {
      roots,
      maxStringLength: Number.MAX_SAFE_INTEGER,
    });
    formData.append(
      'diagnostic_files[]',
      new Blob([text], { type: attachment.contentType }),
      attachment.filename,
    );
  }
  return {
    headers: { Accept: 'application/json' },
    body: formData,
  };
};

export const submitConversationDiagnosticReport = async (
  options: ReportSubmissionOptions,
  input: ConversationDiagnosticReportPreview,
  attachments: ConversationDiagnosticAttachmentUpload[] = [],
): Promise<SubmitConversationDiagnosticReportResult> => {
  const report = sanitizeReportPayload(input, { roots: options.roots });
  const logBase = {
    operation: 'conversation_diagnostic_report.submit',
    source: report.source,
    appId: report.appId,
    conversationId: report.conversationId,
    runId: report.runId,
    provider: report.provider,
    technicalCode: report.technicalCode,
    hasDescription: Boolean(report.description),
    desktopVersion: report.desktopVersion,
    platform: report.platform,
  };
  try {
    const body = buildConversationDiagnosticBody(report, attachments, options.token);
    const response = await fetch(`${options.backendBaseUrl}/api/v1/conversation_diagnostic_reports`, {
      method: 'POST',
      headers: body.headers,
      body: body.body,
    });
    const requestId = responseRequestId(response);
    if (!response.ok) {
      const authFailed = response.status === 401 || response.status === 403;
      const technicalCode = authFailed
        ? 'forger_cloud_auth_expired'
        : `conversation_diagnostic_report_failed_${response.status}`;
      await options.appendReportingLog('conversation_diagnostic_report:submit_failed', {
        ...logBase,
        success: false,
        httpStatus: response.status,
        requestId,
        technicalCode,
      });
      return {
        success: false,
        userMessage: authFailed
          ? 'Inicia sesión en Forger Cloud para enviar el reporte de conversación.'
          : 'No pudimos enviar el reporte de conversación.',
        technicalCode,
      };
    }
    await options.appendReportingLog('conversation_diagnostic_report:submit_success', {
      ...logBase,
      success: true,
      httpStatus: response.status,
      requestId,
    });
    return { success: true, userMessage: 'Conversación enviada a Forger. Gracias por ayudarnos a mejorar.' };
  } catch (error) {
    const technicalCode = 'conversation_diagnostic_report_network_failed';
    await options.appendReportingLog('conversation_diagnostic_report:submit_failed', {
      ...logBase,
      success: false,
      technicalCode,
      errorName: error instanceof Error ? error.name : undefined,
    });
    return { success: false, userMessage: 'No pudimos enviar el reporte de conversación.', technicalCode };
  }
};

const buildConversationDiagnosticBody = (
  report: ConversationDiagnosticReportPreview,
  attachments: ConversationDiagnosticAttachmentUpload[],
  token?: string,
): { headers: HeadersInit; body: BodyInit } => {
  const payload = {
    source: report.source,
    app_id: report.appId,
    conversation_id: report.conversationId,
    run_id: report.runId,
    title: report.title,
    description: report.description,
    provider: report.provider,
    technical_code: report.technicalCode,
    desktop_version: report.desktopVersion,
    platform: report.platform,
    occurred_at: report.occurredAt,
    payload: report.payload,
  };
  const headers = buildBackendHeaders(token);
  if (attachments.length === 0) {
    return {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    };
  }

  const formData = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) {
      continue;
    }
    formData.append(key, key === 'payload' ? JSON.stringify(value) : String(value));
  }
  for (const attachment of attachments) {
    formData.append(
      'diagnostic_files[]',
      new Blob([attachment.text], { type: attachment.contentType }),
      attachment.filename,
    );
  }
  return {
    headers,
    body: formData,
  };
};
