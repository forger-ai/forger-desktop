import type { FailureDiagnosticFields } from './base';

export type UsageEventName =
  | 'forger_installed'
  | 'forger_opened'
  | 'usage_analytics_accepted'
  | 'usage_analytics_declined'
  | 'usage_analytics_revoked'
  | 'usage_analytics_enabled'
  | 'settings_usage_analytics_changed'
  | 'onboarding_started'
  | 'onboarding_completed'
  | 'onboarding_skipped'
  | 'onboarding_module_completed'
  | 'onboarding_module_skipped'
  | 'catalog_viewed'
  | 'app_install_started'
  | 'app_install_succeeded'
  | 'app_install_failed'
  | 'app_opened'
  | 'own_app_opened'
  | 'downloaded_app_opened'
  | 'own_app_modified'
  | 'downloaded_app_modified'
  | 'catalog_app_downloaded'
  | 'local_app_created'
  | 'chat_started'
  | 'chatgpt_connected'
  | 'llm_provider_connected'
  | 'official_tool_connected'
  | 'personal_agent_created'
  | 'personal_agent_message_sent'
  | 'automation_created'
  | 'feedback_opened'
  | 'feedback_submitted';

export interface SubmitUsageEventInput {
  eventName: UsageEventName;
  installationIdentifier: string;
  surface?: string;
  desktopVersion?: string;
  platform?: string;
  locale?: string;
  occurredAt?: string;
  stringParameters?: Record<string, string>;
  intParameters?: Record<string, number>;
}

export type SubmitUsageEventResult = {
  success: boolean;
  userMessage?: string;
  technicalCode?: string;
} & FailureDiagnosticFields;
