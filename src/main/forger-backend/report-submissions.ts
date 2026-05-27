import type {
  ConversationDiagnosticReportPreview,
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

export const submitDesktopErrorReport = async (
  options: ReportSubmissionOptions,
  input: DesktopErrorReportPreview,
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
  };
  try {
    const response = await fetch(`${options.backendBaseUrl}/api/v1/desktop_error_reports`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: report.source,
        operation: report.operation,
        message: report.message,
        technical_code: report.technicalCode,
        desktop_version: report.desktopVersion,
        platform: report.platform,
        arch: report.arch,
        app_id: report.appId,
        app_version: report.appVersion,
        details: report.details ?? {},
        sensitive_details: report.sensitiveDetails ?? {},
      }),
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

export const submitConversationDiagnosticReport = async (
  options: ReportSubmissionOptions,
  input: ConversationDiagnosticReportPreview,
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
    const response = await fetch(`${options.backendBaseUrl}/api/v1/conversation_diagnostic_reports`, {
      method: 'POST',
      headers: {
        ...buildBackendHeaders(options.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
      }),
    });
    const requestId = responseRequestId(response);
    if (!response.ok) {
      const technicalCode = `conversation_diagnostic_report_failed_${response.status}`;
      await options.appendReportingLog('conversation_diagnostic_report:submit_failed', {
        ...logBase,
        success: false,
        httpStatus: response.status,
        requestId,
        technicalCode,
      });
      return { success: false, userMessage: 'No pudimos enviar el reporte de conversación.', technicalCode };
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
