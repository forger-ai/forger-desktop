import { useEffect, useMemo, useState } from 'react';
import type { AppDictionary } from '@renderer/i18n';
import type { View } from '@renderer/components/Sidebar';
import type { SelectedTool as SelectedToolsTool } from '@renderer/views/ToolsView';
import type { AntigravityAuthStatus, ClaudeAuthStatus, CodexAuthStatus } from '@shared/types';
import {
  getUsageAnalyticsEnabled,
  recordLegalWelcomeDecision,
  submitForgerInstalledEvent,
  submitUsageEvent,
} from '@renderer/usage-analytics';

const GLOBAL_TOUR_STORAGE_KEY = 'forger.onboarding.global.dismissed';
const ADVANCED_TOUR_STORAGE_PREFIX = 'forger.onboarding.advanced.';
const TOOLS_TOUR_MODULE_STORAGE_KEY = 'forger.onboarding.tools.module';
const CONNECTIONS_TOUR_MODULE_STORAGE_KEY = 'forger.onboarding.connections.module';
const WORKFLOWS_TOUR_MODULE_STORAGE_KEY = 'forger.onboarding.workflows.module';
const TOOLS_TOUR_STORAGE_KEYS = {
  forger: 'forger.onboarding.tools.forger',
} as const;
const ADVANCED_VIEWS = ['tools', 'files', 'backups', 'devices', 'datos', 'secrets', 'automations', 'connections', 'workflows'] as const;
const GENERIC_ADVANCED_VIEWS = ['files', 'backups', 'devices', 'datos', 'secrets', 'automations'] as const;

type AdvancedView = (typeof GENERIC_ADVANCED_VIEWS)[number];
type AdvancedRouteView = (typeof ADVANCED_VIEWS)[number];
type ModuleTour = 'connections' | 'workflows';

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
  codexAuthStatus: CodexAuthStatus;
  claudeAuthStatus: ClaudeAuthStatus;
  antigravityAuthStatus: AntigravityAuthStatus;
  blocked: boolean;
}

export function useForgerTour({
  currentView,
  setCurrentView,
  t,
  socialChatWindowRoute,
  selectedToolsTool,
  setSelectedToolsTool,
  codexAuthStatus,
  claudeAuthStatus,
  antigravityAuthStatus,
  blocked,
}: UseForgerTourInput) {
  const [globalDismissed, setGlobalDismissed] = useState(() => readStoredBoolean(GLOBAL_TOUR_STORAGE_KEY));
  const [globalStepIndex, setGlobalStepIndex] = useState(0);
  const [activeAdvancedTour, setActiveAdvancedTour] = useState<AdvancedView | null>(null);
  const [activeToolsStepIndex, setActiveToolsStepIndex] = useState<number | null>(null);
  const [activeModuleTour, setActiveModuleTour] = useState<ModuleTour | null>(null);
  const [activeModuleStepIndex, setActiveModuleStepIndex] = useState<number | null>(null);
  const [highlightRect, setHighlightRect] = useState<DOMRect | null>(null);
  const [welcomeUsageAnalyticsEnabled, setWelcomeUsageAnalyticsEnabled] = useState(getUsageAnalyticsEnabled);

  const globalSteps = useMemo<TourStep[]>(
    () => [
      { id: 'welcome', title: t.onboarding.steps.welcome.title, body: t.onboarding.steps.welcome.body },
      { id: 'chat', title: t.onboarding.steps.chat.title, body: t.onboarding.steps.chat.body, target: 'nav-chat', view: 'chat' },
      { id: 'agent', title: t.onboarding.steps.agent.title, body: t.onboarding.steps.agent.body, view: 'chat' },
      { id: 'apps', title: t.onboarding.steps.apps.title, body: t.onboarding.steps.apps.body, target: 'nav-apps', view: 'apps' },
      { id: 'agents', title: t.onboarding.steps.agents.title, body: t.onboarding.steps.agents.body, target: 'nav-agents', view: 'agents' },
      { id: 'connections', title: t.onboarding.steps.connections.title, body: t.onboarding.steps.connections.body, target: 'nav-connections', view: 'connections' },
      { id: 'workflows', title: t.onboarding.steps.workflows.title, body: t.onboarding.steps.workflows.body, target: 'nav-workflows', view: 'workflows' },
      { id: 'catalog', title: t.onboarding.steps.catalog.title, body: t.onboarding.steps.catalog.body, target: 'nav-catalog', view: 'catalog' },
      { id: 'feedback', title: t.onboarding.steps.feedback.title, body: t.onboarding.steps.feedback.body, target: 'nav-feedback', view: 'feedback' },
      { id: 'cloud', title: t.onboarding.steps.cloud.title, body: t.onboarding.steps.cloud.body, target: 'account-actions' },
      { id: 'finance', title: t.onboarding.steps.finance.title, body: t.onboarding.steps.finance.body, target: 'finance-os-card', view: 'catalog' },
    ],
    [t],
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

    return steps;
  }, [t]);

  const connectionsSteps = useMemo<TourStep[]>(() => [
    {
      id: 'connections-list',
      title: t.onboarding.connections.list.title,
      body: t.onboarding.connections.list.body,
      target: 'connections-list',
      view: 'connections',
    },
    {
      id: 'connections-add',
      title: t.onboarding.connections.add.title,
      body: t.onboarding.connections.add.body,
      target: 'connections-add',
      view: 'connections',
    },
    {
      id: 'connections-row-status',
      title: t.onboarding.connections.row.title,
      body: t.onboarding.connections.row.body,
      target: 'connection-row-gmail',
      view: 'connections',
    },
    {
      id: 'connections-detail',
      title: t.onboarding.connections.detail.title,
      body: t.onboarding.connections.detail.body,
      target: 'connection-detail',
      view: 'connections',
    },
    {
      id: 'connections-used-by',
      title: t.onboarding.connections.usedBy.title,
      body: t.onboarding.connections.usedBy.body,
      target: 'connection-used-by',
      view: 'connections',
    },
    {
      id: 'connections-approval',
      title: t.onboarding.connections.approvals.title,
      body: t.onboarding.connections.approvals.body,
      target: 'connection-approvals',
      view: 'connections',
    },
  ], [t]);

  const workflowsSteps = useMemo<TourStep[]>(() => [
    {
      id: 'workflows-list',
      title: t.onboarding.workflows.list.title,
      body: t.onboarding.workflows.list.body,
      target: 'workflows-list',
      view: 'workflows',
    },
    {
      id: 'workflows-add-step',
      title: t.onboarding.workflows.addStep.title,
      body: t.onboarding.workflows.addStep.body,
      target: 'workflow-add-step',
      view: 'workflows',
    },
    {
      id: 'workflows-forger-tool',
      title: t.onboarding.workflows.forgerTool.title,
      body: t.onboarding.workflows.forgerTool.body,
      target: 'workflow-step-forger-tool',
      view: 'workflows',
    },
    {
      id: 'workflows-connection',
      title: t.onboarding.workflows.connection.title,
      body: t.onboarding.workflows.connection.body,
      target: 'workflow-step-connection',
      view: 'workflows',
    },
    {
      id: 'workflows-mapping',
      title: t.onboarding.workflows.mapping.title,
      body: t.onboarding.workflows.mapping.body,
      target: 'workflow-input-mapping',
      view: 'workflows',
    },
    {
      id: 'workflows-approval',
      title: t.onboarding.workflows.approval.title,
      body: t.onboarding.workflows.approval.body,
      target: 'workflow-approval',
      view: 'workflows',
    },
    {
      id: 'workflows-run-history',
      title: t.onboarding.workflows.history.title,
      body: t.onboarding.workflows.history.body,
      target: 'workflow-run-history',
      view: 'workflows',
    },
  ], [t]);

  const activeModuleSteps = activeModuleTour === 'connections'
    ? connectionsSteps
    : activeModuleTour === 'workflows'
      ? workflowsSteps
      : [];

  useEffect(() => {
    const reset = () => {
      setGlobalDismissed(false);
      setGlobalStepIndex(0);
      setActiveAdvancedTour(null);
      setActiveToolsStepIndex(null);
      setActiveModuleTour(null);
      setActiveModuleStepIndex(null);
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
    if (!globalDismissed || socialChatWindowRoute || activeAdvancedTour || activeToolsStepIndex !== null || activeModuleStepIndex !== null) {
      return;
    }
    if (!ADVANCED_VIEWS.includes(currentView as AdvancedRouteView)) {
      return;
    }
    const advancedView = currentView as AdvancedRouteView;
    if (advancedView === 'connections') {
      if (window.localStorage.getItem(CONNECTIONS_TOUR_MODULE_STORAGE_KEY) !== 'true') {
        setActiveModuleTour('connections');
        setActiveModuleStepIndex(0);
      }
      return;
    }
    if (advancedView === 'workflows') {
      if (window.localStorage.getItem(WORKFLOWS_TOUR_MODULE_STORAGE_KEY) !== 'true') {
        setActiveModuleTour('workflows');
        setActiveModuleStepIndex(0);
      }
      return;
    }
    if (advancedView === 'tools') {
      if (window.localStorage.getItem(TOOLS_TOUR_MODULE_STORAGE_KEY) !== 'true') {
        setActiveToolsStepIndex(0);
        setSelectedToolsTool(null);
      }
      return;
    }
    if (GENERIC_ADVANCED_VIEWS.includes(advancedView as AdvancedView) && window.localStorage.getItem(`${ADVANCED_TOUR_STORAGE_PREFIX}${advancedView}`) !== 'true') {
      setActiveAdvancedTour(advancedView as AdvancedView);
    }
  }, [
    activeAdvancedTour,
    activeModuleStepIndex,
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

  useEffect(() => {
    if (!activeModuleTour || activeModuleStepIndex === null) {
      return;
    }
    const storageKey = activeModuleTour === 'connections'
      ? CONNECTIONS_TOUR_MODULE_STORAGE_KEY
      : WORKFLOWS_TOUR_MODULE_STORAGE_KEY;
    const step = activeModuleSteps[activeModuleStepIndex];
    if (!step) {
      window.localStorage.setItem(storageKey, 'true');
      setActiveModuleTour(null);
      setActiveModuleStepIndex(null);
      return;
    }
    if (step.view && currentView !== step.view) {
      setCurrentView(step.view);
    }
  }, [activeModuleStepIndex, activeModuleSteps, activeModuleTour, currentView, setCurrentView]);

  const activeStep = useMemo<TourStep | null>(() => {
    if (blocked) {
      return null;
    }
    if (activeToolsStepIndex !== null) {
      return toolsSteps[activeToolsStepIndex] ?? null;
    }
    if (activeModuleTour && activeModuleStepIndex !== null) {
      return activeModuleSteps[activeModuleStepIndex] ?? null;
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
    activeModuleStepIndex,
    activeModuleSteps,
    activeModuleTour,
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

  const finishModuleTour = (outcome: 'completed' | 'skipped') => {
    if (!activeModuleTour) {
      return;
    }
    window.localStorage.setItem(
      activeModuleTour === 'connections' ? CONNECTIONS_TOUR_MODULE_STORAGE_KEY : WORKFLOWS_TOUR_MODULE_STORAGE_KEY,
      'true',
    );
    submitUsageEvent({
      eventName: outcome === 'completed' ? 'onboarding_module_completed' : 'onboarding_module_skipped',
      surface: 'onboarding',
      locale: t.locale,
      stringParameters: { module: activeModuleTour },
    });
    setActiveModuleTour(null);
    setActiveModuleStepIndex(null);
  };

  const skipTour = () => {
    if (activeToolsStepIndex !== null) {
      finishToolsTour();
      return;
    }
    if (activeModuleTour) {
      finishModuleTour('skipped');
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
    if (activeModuleTour && activeModuleStepIndex !== null) {
      if (activeModuleStepIndex >= activeModuleSteps.length - 1) {
        finishModuleTour('completed');
        return;
      }
      setActiveModuleStepIndex((current) => current === null ? null : current + 1);
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
  const hasConnectedAgentProvider = codexAuthStatus.authenticated || claudeAuthStatus.authenticated || antigravityAuthStatus.authenticated;
  const primaryLabel = isWelcomeStep
    ? t.onboarding.startTour
    : isAgentStep && !hasConnectedAgentProvider
    ? t.onboarding.later
    : !activeAdvancedTour && activeToolsStepIndex === null && activeModuleStepIndex === null && globalStepIndex >= globalSteps.length - 1
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
