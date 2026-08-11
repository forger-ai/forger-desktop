import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@renderer/i18n/en';
import { es } from '@renderer/i18n/es';

import { FORGER_TOUR_RESET_EVENT, useForgerTour } from '@renderer/tour/useForgerTour';

type TourInput = Parameters<typeof useForgerTour>[0];

const unauthenticatedCodex: TourInput['codexAuthStatus'] = {
  installed: true,
  authenticated: false,
  authFilePath: '',
  codexHome: '',
};

const unauthenticatedClaude: TourInput['claudeAuthStatus'] = {
  installed: true,
  authenticated: false,
  source: 'managed',
};

const unauthenticatedAntigravity: TourInput['antigravityAuthStatus'] = {
  installed: true,
  authenticated: false,
  source: 'managed',
};

const createInput = (overrides: Partial<TourInput> = {}): TourInput => ({
  currentView: 'apps',
  setCurrentView: vi.fn(),
  t: en,
  socialChatWindowRoute: null,
  selectedToolsTool: null,
  setSelectedToolsTool: vi.fn(),
  codexAuthStatus: unauthenticatedCodex,
  claudeAuthStatus: unauthenticatedClaude,
  antigravityAuthStatus: unauthenticatedAntigravity,
  blocked: false,
  ...overrides,
});

const renderTour = (overrides: Partial<TourInput> = {}) => {
  let input = createInput(overrides);
  const hook = renderHook(({ value }: { value: TourInput }) => useForgerTour(value), {
    initialProps: { value: input },
  });
  const rerender = (next: Partial<TourInput>) => {
    input = { ...input, ...next };
    hook.rerender({ value: input });
  };
  return { ...hook, rerenderInput: rerender, input: () => input };
};

const dismissGlobalTour = () => {
  window.localStorage.setItem('forger.onboarding.global.dismissed', 'true');
};

const advance = (continueTour: () => void, count: number) => {
  for (let index = 0; index < count; index += 1) {
    act(() => continueTour());
  }
};

describe('Forger onboarding service flow', () => {
  const submittedEvents: Array<{ eventName: string; stringParameters?: Record<string, string> }> = [];

  beforeEach(() => {
    window.localStorage.clear();
    submittedEvents.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => '11111111-2222-4333-8444-555555555555'),
    });
    Object.defineProperty(window, 'forger', {
      configurable: true,
      value: {
        submitUsageEvent: vi.fn(async (event) => {
          submittedEvents.push(event);
          return { success: true };
        }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.body.replaceChildren();
    Object.defineProperty(window, 'forger', { configurable: true, value: undefined });
  });

  it('runs the global tour, tracks the legal choice, highlights targets, and completes', () => {
    const target = document.createElement('button');
    target.dataset.onboardingTarget = 'nav-chat';
    const rect = {
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      top: 20,
      right: 110,
      bottom: 60,
      left: 10,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect);
    document.body.append(target);

    const tour = renderTour();
    expect(tour.result.current.activeStep?.id).toBe('welcome');
    expect(tour.result.current.isWelcomeStep).toBe(true);
    expect(tour.result.current.primaryLabel).toBe(en.onboarding.startTour);
    expect(tour.result.current.modalWidth).toBe(360);

    act(() => tour.result.current.setWelcomeUsageAnalyticsEnabled(false));
    act(() => tour.result.current.continueTour());

    expect(tour.result.current.activeStep?.id).toBe('chat');
    expect(tour.result.current.highlightRect).toBe(rect);
    expect(tour.input().setCurrentView).toHaveBeenCalledWith('chat');
    expect(window.localStorage.getItem('forger.usageAnalytics.enabled')).toBe('false');
    expect(submittedEvents.map((event) => event.eventName)).toEqual([
      'forger_installed',
      'usage_analytics_declined',
    ]);

    act(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(120);
    });
    tour.rerenderInput({ currentView: 'chat' });
    act(() => tour.result.current.continueTour());

    expect(tour.result.current.activeStep?.id).toBe('agent');
    expect(tour.result.current.highlightRect).toBeNull();
    expect(tour.result.current.isAgentStep).toBe(true);
    expect(tour.result.current.hasConnectedAgentProvider).toBe(false);
    expect(tour.result.current.primaryLabel).toBe(en.onboarding.later);
    expect(tour.result.current.primaryVariant).toBe('outlined');
    expect(tour.result.current.primaryColor).toBe('inherit');
    expect(tour.result.current.modalWidth).toBe(720);

    window.localStorage.setItem('forger.usageAnalytics.enabled', 'true');

    tour.rerenderInput({ codexAuthStatus: { ...unauthenticatedCodex, authenticated: true } });
    expect(tour.result.current.hasConnectedAgentProvider).toBe(true);
    expect(tour.result.current.primaryLabel).toBe(en.onboarding.continue);
    expect(tour.result.current.primaryVariant).toBe('contained');
    expect(tour.result.current.primaryColor).toBe('primary');

    tour.rerenderInput({
      codexAuthStatus: unauthenticatedCodex,
      claudeAuthStatus: { ...unauthenticatedClaude, authenticated: true },
    });
    expect(tour.result.current.hasConnectedAgentProvider).toBe(true);
    tour.rerenderInput({
      claudeAuthStatus: unauthenticatedClaude,
      antigravityAuthStatus: { ...unauthenticatedAntigravity, authenticated: true },
    });
    expect(tour.result.current.hasConnectedAgentProvider).toBe(true);

    advance(tour.result.current.continueTour, 7);
    expect(tour.result.current.activeStep?.id).toBe('cloud');
    expect(tour.result.current.primaryLabel).toBe(en.onboarding.finish);
    act(() => tour.result.current.continueTour());

    expect(tour.result.current.activeStep).toBeNull();
    expect(window.localStorage.getItem('forger.onboarding.global.dismissed')).toBe('true');
    expect(submittedEvents.at(-1)?.eventName).toBe('onboarding_completed');
  });

  it('skips welcome and later global steps while respecting analytics choice and route blocking', () => {
    const welcome = renderTour();
    act(() => welcome.result.current.skipTour());
    expect(submittedEvents.map((event) => event.eventName)).toContain('usage_analytics_accepted');
    expect(submittedEvents.map((event) => event.eventName)).toContain('onboarding_skipped');
    welcome.unmount();

    window.localStorage.clear();
    submittedEvents.length = 0;
    const declined = renderTour();
    act(() => declined.result.current.setWelcomeUsageAnalyticsEnabled(false));
    act(() => declined.result.current.skipTour());
    expect(submittedEvents.map((event) => event.eventName)).toContain('usage_analytics_declined');
    declined.unmount();

    window.localStorage.clear();
    submittedEvents.length = 0;
    const later = renderTour();
    act(() => later.result.current.continueTour());
    const acceptedBeforeSkip = submittedEvents.filter((event) => event.eventName === 'usage_analytics_accepted').length;
    act(() => later.result.current.skipTour());
    expect(submittedEvents.filter((event) => event.eventName === 'usage_analytics_accepted')).toHaveLength(acceptedBeforeSkip);
    expect(submittedEvents.at(-1)?.eventName).toBe('onboarding_skipped');

    act(() => window.dispatchEvent(new CustomEvent(FORGER_TOUR_RESET_EVENT)));
    expect(later.result.current.activeStep?.id).toBe('welcome');
    expect(later.input().setSelectedToolsTool).toHaveBeenCalledWith(null);
    later.rerenderInput({ socialChatWindowRoute: { friendId: 1 } });
    expect(later.result.current.activeStep).toBeNull();
    later.rerenderInput({ socialChatWindowRoute: null, blocked: true });
    expect(later.result.current.activeStep).toBeNull();
  });

  it('shows, completes, skips, and remembers generic advanced tours', () => {
    dismissGlobalTour();
    const tour = renderTour({ currentView: 'files' });

    expect(tour.result.current.activeStep?.id).toBe('advanced-files');
    act(() => tour.result.current.continueTour());
    expect(window.localStorage.getItem('forger.onboarding.advanced.files')).toBe('true');
    expect(tour.result.current.activeStep).toBeNull();

    tour.rerenderInput({ currentView: 'backups' });
    expect(tour.result.current.activeStep?.id).toBe('advanced-backups');
    act(() => tour.result.current.skipTour());
    expect(window.localStorage.getItem('forger.onboarding.advanced.backups')).toBe('true');

    tour.rerenderInput({ currentView: 'catalog' });
    expect(tour.result.current.activeStep).toBeNull();
    tour.rerenderInput({ currentView: 'files', socialChatWindowRoute: { friendId: 1 } });
    expect(tour.result.current.activeStep).toBeNull();
  });

  it('walks through and skips the dynamic tools tutorial', () => {
    dismissGlobalTour();
    const setSelectedToolsTool = vi.fn();
    const tour = renderTour({ currentView: 'tools', selectedToolsTool: 'forger', setSelectedToolsTool });

    expect(tour.result.current.activeStep?.id).toBe('tools-intro');
    expect(setSelectedToolsTool).toHaveBeenCalledWith(null);
    tour.rerenderInput({ currentView: 'apps', selectedToolsTool: null });
    expect(tour.input().setCurrentView).toHaveBeenCalledWith('tools');
    tour.rerenderInput({ currentView: 'tools' });
    act(() => tour.result.current.continueTour());
    expect(tour.result.current.activeStep?.id).toBe('tools-list');
    act(() => tour.result.current.continueTour());
    expect(tour.result.current.activeStep?.id).toBe('tools-forger-row');
    act(() => tour.result.current.continueTour());
    expect(tour.result.current.activeStep?.id).toBe('tools-forger-permissions');
    expect(setSelectedToolsTool).toHaveBeenCalledWith('forger');
    tour.rerenderInput({ selectedToolsTool: 'forger' });
    act(() => tour.result.current.continueTour());

    expect(window.localStorage.getItem('forger.onboarding.tools.forger')).toBe('true');
    expect(window.localStorage.getItem('forger.onboarding.tools.module')).toBe('true');
    expect(tour.result.current.activeStep).toBeNull();
    tour.unmount();

    window.localStorage.setItem('forger.onboarding.tools.module', 'false');
    const shortTour = renderTour({ currentView: 'tools' });
    expect(shortTour.result.current.activeStep?.id).toBe('tools-intro');
    act(() => shortTour.result.current.skipTour());
    expect(window.localStorage.getItem('forger.onboarding.tools.module')).toBe('true');
    expect(shortTour.result.current.activeStep).toBeNull();
    shortTour.unmount();

    window.localStorage.removeItem('forger.onboarding.tools.module');
    window.localStorage.removeItem('forger.onboarding.tools.forger');
    const localeSwitch = renderTour({ currentView: 'tools' });
    for (let step = 0; step < 3; step += 1) {
      act(() => localeSwitch.result.current.continueTour());
    }
    expect(localeSwitch.result.current.activeStep?.id).toBe('tools-forger-permissions');
    window.localStorage.setItem('forger.onboarding.tools.forger', 'true');
    localeSwitch.rerenderInput({ t: es });
    expect(window.localStorage.getItem('forger.onboarding.tools.module')).toBe('true');
    expect(localeSwitch.result.current.activeStep).toBeNull();
  });

  it('completes the connections module and skips the workflows module with analytics', () => {
    dismissGlobalTour();
    const setCurrentView = vi.fn();
    const tour = renderTour({ currentView: 'connections', setCurrentView });

    expect(tour.result.current.activeStep?.id).toBe('connections-list');
    tour.rerenderInput({ currentView: 'apps' });
    expect(setCurrentView).toHaveBeenCalledWith('connections');
    for (let step = 0; step < 5; step += 1) {
      act(() => tour.result.current.continueTour());
    }
    expect(tour.result.current.activeStep?.id).toBe('connections-approval');
    act(() => tour.result.current.continueTour());

    expect(window.localStorage.getItem('forger.onboarding.connections.module')).toBe('true');
    expect(submittedEvents.at(-1)).toMatchObject({
      eventName: 'onboarding_module_completed',
      stringParameters: { module: 'connections' },
    });

    tour.rerenderInput({ currentView: 'connections' });
    expect(tour.result.current.activeStep).toBeNull();
    tour.rerenderInput({ currentView: 'workflows' });
    expect(tour.result.current.activeStep?.id).toBe('workflows-list');
    act(() => tour.result.current.skipTour());
    expect(window.localStorage.getItem('forger.onboarding.workflows.module')).toBe('true');
    expect(submittedEvents.at(-1)).toMatchObject({
      eventName: 'onboarding_module_skipped',
      stringParameters: { module: 'workflows' },
    });
  });

  it('keeps reset and completion deterministic across batched advances', () => {
    dismissGlobalTour();
    const tools = renderTour({ currentView: 'tools' });
    const staleToolsContinue = tools.result.current.continueTour;
    act(() => {
      window.dispatchEvent(new CustomEvent(FORGER_TOUR_RESET_EVENT));
      staleToolsContinue();
    });
    expect(tools.result.current.activeStep?.id).toBe('welcome');
    tools.unmount();

    window.localStorage.clear();
    dismissGlobalTour();
    const resetModule = renderTour({ currentView: 'connections' });
    const staleModuleContinue = resetModule.result.current.continueTour;
    act(() => {
      window.dispatchEvent(new CustomEvent(FORGER_TOUR_RESET_EVENT));
      staleModuleContinue();
    });
    expect(resetModule.result.current.activeStep?.id).toBe('welcome');
    resetModule.unmount();

    window.localStorage.clear();
    dismissGlobalTour();
    const moduleOverflow = renderTour({ currentView: 'connections' });
    for (let step = 0; step < 4; step += 1) {
      act(() => moduleOverflow.result.current.continueTour());
    }
    expect(moduleOverflow.result.current.activeStep?.id).toBe('connections-used-by');
    const batchedModuleContinue = moduleOverflow.result.current.continueTour;
    act(() => {
      batchedModuleContinue();
      batchedModuleContinue();
    });
    expect(moduleOverflow.result.current.activeStep).toBeNull();
    expect(window.localStorage.getItem('forger.onboarding.connections.module')).toBe('true');
    moduleOverflow.unmount();

    window.localStorage.clear();
    const globalOverflow = renderTour();
    advance(globalOverflow.result.current.continueTour, 8);
    expect(globalOverflow.result.current.activeStep?.id).toBe('feedback');
    const batchedGlobalContinue = globalOverflow.result.current.continueTour;
    act(() => {
      batchedGlobalContinue();
      batchedGlobalContinue();
    });
    expect(globalOverflow.result.current.activeStep).toBeNull();
    act(() => globalOverflow.result.current.continueTour());
    expect(window.localStorage.getItem('forger.onboarding.global.dismissed')).toBe('true');
  });
});
