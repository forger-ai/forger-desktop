import { useEffect, useMemo, useState } from 'react';
import type { AppDictionary } from '@renderer/i18n';
import type { View } from '@renderer/components/Sidebar';
import type { SelectedTool as SelectedToolsTool } from '@renderer/views/ToolsView';
import { GMAIL_TOOL_ID } from '@renderer/views/tools/constants';
import type { ClaudeAuthStatus, CodexAuthStatus, OfficialToolSummary } from '@shared/types';
import {
  getUsageAnalyticsEnabled,
  recordLegalWelcomeDecision,
  submitForgerInstalledEvent,
  submitUsageEvent,
} from '@renderer/usage-analytics';

const GLOBAL_TOUR_STORAGE_KEY = 'forger.onboarding.global.dismissed';
const ADVANCED_TOUR_STORAGE_PREFIX = 'forger.onboarding.advanced.';
const TOOLS_TOUR_MODULE_STORAGE_KEY = 'forger.onboarding.tools.module';
const TOOLS_TOUR_STORAGE_KEYS = {
  forger: 'forger.onboarding.tools.forger',
  gmail: 'forger.onboarding.tools.gmail',
} as const;
const ADVANCED_VIEWS = ['tools', 'files', 'backups', 'devices', 'datos', 'secrets', 'automations'] as const;

type AdvancedView = (typeof ADVANCED_VIEWS)[number];

export const FORGER_TOUR_RESET_EVENT = 'forger-tour-reset';

export type TourStep = {
  id: string;
  title: string;
  body: string;
  target?: string;
  view?: View;
  selectedTool?: SelectedToolsTool;
  completedTool?: keyof typeof TOOLS_TOUR_STORAGE_KEYS;
};

const readStoredBoolean = (key: string, fallback = false) => {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  return value === null ? fallback : value === 'true';
};

interface UseForgerTourInput {
  currentView: View;
  setCurrentView: (view: View) => void;
  t: AppDictionary;
  socialChatWindowRoute: unknown;
  selectedToolsTool: SelectedToolsTool;
  setSelectedToolsTool: (tool: SelectedToolsTool) => void;
  officialTools: OfficialToolSummary[];
  codexAuthStatus: CodexAuthStatus;
  claudeAuthStatus: ClaudeAuthStatus;
  blocked: boolean;
}

export function useForgerTour({
  currentView,
  setCurrentView,
  t,
  socialChatWindowRoute,
  selectedToolsTool,
  setSelectedToolsTool,
  officialTools,
  codexAuthStatus,
  claudeAuthStatus,
  blocked,
}: UseForgerTourInput) {
  const [globalDismissed, setGlobalDismissed] = useState(() => readStoredBoolean(GLOBAL_TOUR_STORAGE_KEY));
  const [globalStepIndex, setGlobalStepIndex] = useState(0);
  const [activeAdvancedTour, setActiveAdvancedTour] = useState<AdvancedView | null>(null);
  const [activeToolsStepIndex, setActiveToolsStepIndex] = useState<number | null>(null);
  const [highlightRect, setHighlightRect] = useState<DOMRect | null>(null);
  const [welcomeUsageAnalyticsEnabled, setWelcomeUsageAnalyticsEnabled] = useState(getUsageAnalyticsEnabled);

  const globalSteps = useMemo<TourStep[]>(
    () => [
      { id: 'welcome', title: t.onboarding.steps.welcome.title, body: t.onboarding.steps.welcome.body },
      { id: 'apps', title: t.onboarding.steps.apps.title, body: t.onboarding.steps.apps.body, target: 'nav-catalog', view: 'catalog' },
      { id: 'chat', title: t.onboarding.steps.chat.title, body: t.onboarding.steps.chat.body, target: 'nav-chat', view: 'chat' },
      { id: 'agent', title: t.onboarding.steps.agent.title, body: t.onboarding.steps.agent.body, view: 'chat' },
      { id: 'feedback', title: t.onboarding.steps.feedback.title, body: t.onboarding.steps.feedback.body, target: 'nav-feedback', view: 'feedback' },
      { id: 'cloud', title: t.onboarding.steps.cloud.title, body: t.onboarding.steps.cloud.body, target: 'account-actions' },
      { id: 'finance', title: t.onboarding.steps.finance.title, body: t.onboarding.steps.finance.body, target: 'finance-os-card', view: 'catalog' },
    ],
    [t],
  );

  const gmailConnected = useMemo(
    () => Boolean(officialTools.find((tool) => tool.id === GMAIL_TOOL_ID)?.configured),
    [officialTools],
  );

  const toolsSteps = useMemo<TourStep[]>(() => {
    const steps: TourStep[] = [
      {
        id: 'tools-intro',
        title: t.onboarding.tools.intro.title,
        body: t.onboarding.tools.intro.body,
        target: 'tools-list',
        view: 'tools',
        selectedTool: null,
      },
      {
        id: 'tools-list',
        title: t.onboarding.tools.list.title,
        body: t.onboarding.tools.list.body,
        target: 'tools-search',
        view: 'tools',
        selectedTool: null,
      },
    ];

    if (!readStoredBoolean(TOOLS_TOUR_STORAGE_KEYS.forger)) {
      steps.push(
        {
          id: 'tools-forger-row',
          title: t.onboarding.tools.forgerRow.title,
          body: t.onboarding.tools.forgerRow.body,
          target: 'tool-row-forger',
          view: 'tools',
          selectedTool: null,
        },
        {
          id: 'tools-forger-permissions',
          title: t.onboarding.tools.forgerPermissions.title,
          body: t.onboarding.tools.forgerPermissions.body,
          target: 'forger-tool-permissions',
          view: 'tools',
          selectedTool: 'forger',
          completedTool: 'forger',
        },
      );
    }

    if (!readStoredBoolean(TOOLS_TOUR_STORAGE_KEYS.gmail)) {
      steps.push(
        {
          id: 'tools-gmail-row',
          title: t.onboarding.tools.gmailRow.title,
          body: t.onboarding.tools.gmailRow.body,
          target: 'tool-row-gmail',
          view: 'tools',
          selectedTool: null,
        },
        {
          id: gmailConnected ? 'tools-gmail-permissions' : 'tools-gmail-connect',
          title: gmailConnected ? t.onboarding.tools.gmailPermissions.title : t.onboarding.tools.gmailConnect.title,
          body: gmailConnected ? t.onboarding.tools.gmailPermissions.body : t.onboarding.tools.gmailConnect.body,
          target: gmailConnected ? 'gmail-tool-permissions' : 'gmail-connect-button',
          view: 'tools',
          selectedTool: 'gmail',
          completedTool: 'gmail',
        },
      );
    }

    return steps;
  }, [gmailConnected, t]);

  useEffect(() => {
    const reset = () => {
      setGlobalDismissed(false);
      setGlobalStepIndex(0);
      setActiveAdvancedTour(null);
      setActiveToolsStepIndex(null);
      setSelectedToolsTool(null);
    };
    window.addEventListener(FORGER_TOUR_RESET_EVENT, reset);
    return () => window.removeEventListener(FORGER_TOUR_RESET_EVENT, reset);
  }, [setSelectedToolsTool]);

  useEffect(() => {
    if (globalDismissed || socialChatWindowRoute) {
      return;
    }
    const step = globalSteps[globalStepIndex];
    if (step?.view && currentView !== step.view) {
      setCurrentView(step.view);
    }
  }, [currentView, globalDismissed, globalStepIndex, globalSteps, setCurrentView, socialChatWindowRoute]);

  useEffect(() => {
    if (!globalDismissed || socialChatWindowRoute || activeAdvancedTour || activeToolsStepIndex !== null) {
      return;
    }
    if (!ADVANCED_VIEWS.includes(currentView as AdvancedView)) {
      return;
    }
    const advancedView = currentView as AdvancedView;
    if (advancedView === 'tools') {
      if (window.localStorage.getItem(TOOLS_TOUR_MODULE_STORAGE_KEY) !== 'true') {
        setActiveToolsStepIndex(0);
        setSelectedToolsTool(null);
      }
      return;
    }
    if (window.localStorage.getItem(`${ADVANCED_TOUR_STORAGE_PREFIX}${advancedView}`) !== 'true') {
      setActiveAdvancedTour(advancedView);
    }
  }, [
    activeAdvancedTour,
    activeToolsStepIndex,
    currentView,
    globalDismissed,
    setSelectedToolsTool,
    socialChatWindowRoute,
  ]);

  useEffect(() => {
    if (activeToolsStepIndex === null) {
      return;
    }
    const step = toolsSteps[activeToolsStepIndex];
    if (!step) {
      window.localStorage.setItem(TOOLS_TOUR_MODULE_STORAGE_KEY, 'true');
      setActiveToolsStepIndex(null);
      setSelectedToolsTool(null);
      return;
    }
    if (currentView !== 'tools') {
      setCurrentView('tools');
    }
    if (selectedToolsTool !== step.selectedTool) {
      setSelectedToolsTool(step.selectedTool ?? null);
    }
  }, [activeToolsStepIndex, currentView, selectedToolsTool, setCurrentView, setSelectedToolsTool, toolsSteps]);

  const activeStep = useMemo<TourStep | null>(() => {
    if (blocked) {
      return null;
    }
    if (activeToolsStepIndex !== null) {
      return toolsSteps[activeToolsStepIndex] ?? null;
    }
    if (activeAdvancedTour) {
      const step = t.onboarding.advanced.views[activeAdvancedTour];
      return {
        id: `advanced-${activeAdvancedTour}`,
        title: step.title,
        body: step.body,
        target: `advanced-${activeAdvancedTour}`,
      };
    }
    return !globalDismissed && !socialChatWindowRoute ? globalSteps[globalStepIndex] ?? null : null;
  }, [
    activeAdvancedTour,
    activeToolsStepIndex,
    blocked,
    globalDismissed,
    globalStepIndex,
    globalSteps,
    socialChatWindowRoute,
    t,
    toolsSteps,
  ]);

  useEffect(() => {
    if (!activeStep?.target) {
      setHighlightRect(null);
      return undefined;
    }
    const updateRect = () => {
      const target = document.querySelector<HTMLElement>(`[data-onboarding-target="${activeStep.target}"]`);
      setHighlightRect(target?.getBoundingClientRect() ?? null);
    };
    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    const timeout = window.setTimeout(updateRect, 120);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
      window.clearTimeout(timeout);
    };
  }, [activeStep]);

  const finishToolsTour = () => {
    window.localStorage.setItem(TOOLS_TOUR_MODULE_STORAGE_KEY, 'true');
    Object.values(TOOLS_TOUR_STORAGE_KEYS).forEach((key) => window.localStorage.setItem(key, 'true'));
    setActiveToolsStepIndex(null);
    setSelectedToolsTool(null);
  };

  const skipTour = () => {
    if (activeToolsStepIndex !== null) {
      finishToolsTour();
      return;
    }
    if (activeAdvancedTour) {
      window.localStorage.setItem(`${ADVANCED_TOUR_STORAGE_PREFIX}${activeAdvancedTour}`, 'true');
      setActiveAdvancedTour(null);
      return;
    }
    if (activeStep?.id === 'welcome') {
      recordLegalWelcomeDecision(welcomeUsageAnalyticsEnabled);
      submitForgerInstalledEvent({ surface: 'onboarding', locale: t.locale });
      submitUsageEvent({
        eventName: welcomeUsageAnalyticsEnabled ? 'usage_analytics_accepted' : 'usage_analytics_declined',
        surface: 'onboarding',
        locale: t.locale,
        stringParameters: { decision_source: 'onboarding_skip' },
      });
    }
    submitUsageEvent({
      eventName: 'onboarding_skipped',
      surface: 'onboarding',
      locale: t.locale,
    });
    window.localStorage.setItem(GLOBAL_TOUR_STORAGE_KEY, 'true');
    setGlobalDismissed(true);
  };

  const continueTour = () => {
    if (activeToolsStepIndex !== null) {
      const step = toolsSteps[activeToolsStepIndex];
      if (step?.completedTool) {
        window.localStorage.setItem(TOOLS_TOUR_STORAGE_KEYS[step.completedTool], 'true');
      }
      if (activeToolsStepIndex >= toolsSteps.length - 1) {
        window.localStorage.setItem(TOOLS_TOUR_MODULE_STORAGE_KEY, 'true');
        setActiveToolsStepIndex(null);
        setSelectedToolsTool(null);
        return;
      }
      setActiveToolsStepIndex((current) => current === null ? null : current + 1);
      return;
    }
    if (activeAdvancedTour) {
      window.localStorage.setItem(`${ADVANCED_TOUR_STORAGE_PREFIX}${activeAdvancedTour}`, 'true');
      setActiveAdvancedTour(null);
      return;
    }
    if (activeStep?.id === 'welcome') {
      recordLegalWelcomeDecision(welcomeUsageAnalyticsEnabled);
      submitForgerInstalledEvent({ surface: 'onboarding', locale: t.locale });
      submitUsageEvent({
        eventName: welcomeUsageAnalyticsEnabled ? 'usage_analytics_accepted' : 'usage_analytics_declined',
        surface: 'onboarding',
        locale: t.locale,
        stringParameters: { decision_source: 'onboarding_continue' },
      });
      submitUsageEvent({
        eventName: 'onboarding_started',
        surface: 'onboarding',
        locale: t.locale,
      });
    }
    if (globalStepIndex >= globalSteps.length - 1) {
      submitUsageEvent({
        eventName: 'onboarding_completed',
        surface: 'onboarding',
        locale: t.locale,
      });
      window.localStorage.setItem(GLOBAL_TOUR_STORAGE_KEY, 'true');
      setGlobalDismissed(true);
      return;
    }
    setGlobalStepIndex((current) => current + 1);
  };

  const isAgentStep = activeStep?.id === 'agent';
  const isWelcomeStep = activeStep?.id === 'welcome';
  const hasConnectedAgentProvider = codexAuthStatus.authenticated || claudeAuthStatus.authenticated;
  const primaryLabel = isWelcomeStep
    ? t.onboarding.startTour
    : isAgentStep && !hasConnectedAgentProvider
    ? t.onboarding.later
    : !activeAdvancedTour && activeToolsStepIndex === null && globalStepIndex >= globalSteps.length - 1
      ? t.onboarding.finish
      : t.onboarding.continue;

  return {
    activeStep,
    highlightRect,
    isAgentStep,
    hasConnectedAgentProvider,
    modalWidth: isAgentStep ? 720 : 360,
    isWelcomeStep,
    welcomeUsageAnalyticsEnabled,
    setWelcomeUsageAnalyticsEnabled,
    primaryLabel,
    primaryVariant: isAgentStep && !hasConnectedAgentProvider ? 'outlined' as const : 'contained' as const,
    primaryColor: isAgentStep && !hasConnectedAgentProvider ? 'inherit' as const : 'primary' as const,
    skipTour,
    continueTour,
  };
}
