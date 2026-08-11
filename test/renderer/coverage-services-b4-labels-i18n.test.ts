import { describe, expect, it } from 'vitest';
import type { AppDictionary } from '@renderer/i18n';

import { appExecutionTooltip } from '@renderer/app-execution-labels';
import { enAgentGroups, esAgentGroups } from '@renderer/i18n/locales/agentGroups';
import { enBackgroundTasks } from '@renderer/i18n/locales/enBackgroundTasks';
import { esBackgroundTasks } from '@renderer/i18n/locales/esBackgroundTasks';

const dictionary = {
  actions: { error: 'Execution error' },
  appExecution: {
    startingForger: 'Starting in Forger',
    startingLocalNetwork: 'Starting on local network',
    startingRemoteTunnel: 'Starting remote tunnel',
    runningForger: 'Running in Forger',
    runningLocalNetwork: 'Running on local network',
    runningRemoteTunnel: 'Running remotely',
  },
} as AppDictionary;

const stoppedApp = {
  status: 'ready' as const,
  localNetworkShare: undefined,
  remoteNetworkShare: undefined,
};

describe('renderer execution and localized service labels', () => {
  it('describes every execution state that an app can expose', () => {
    expect(appExecutionTooltip(stoppedApp, dictionary)).toBeUndefined();
    expect(appExecutionTooltip({ ...stoppedApp, status: 'error' }, dictionary)).toBe('Execution error');
    expect(appExecutionTooltip({ ...stoppedApp, status: 'conflict' }, dictionary)).toBe('Execution error');
    expect(appExecutionTooltip({ ...stoppedApp, status: 'installing' }, dictionary)).toBe('Starting in Forger');
    expect(appExecutionTooltip(stoppedApp, dictionary, { startingInForger: true })).toBe('Starting in Forger');
    expect(appExecutionTooltip({ ...stoppedApp, status: 'running' }, dictionary)).toBe('Running in Forger');
    expect(appExecutionTooltip({
      ...stoppedApp,
      localNetworkShare: { active: true },
    }, dictionary)).toBe('Running on local network');
    expect(appExecutionTooltip({
      ...stoppedApp,
      remoteNetworkShare: { active: false, state: 'preparing' },
    }, dictionary)).toBe('Starting remote tunnel');
    expect(appExecutionTooltip({
      ...stoppedApp,
      remoteNetworkShare: { active: true, state: 'waiting_for_session' },
    }, dictionary)).toBe('Running remotely');
    expect(appExecutionTooltip({
      ...stoppedApp,
      remoteNetworkShare: { active: true, state: 'connected' },
    }, dictionary)).toBe('Running remotely');
    expect(appExecutionTooltip({
      ...stoppedApp,
      remoteNetworkShare: { active: false, state: 'error' },
    }, dictionary)).toBe('Execution error');
  });

  it('formats agent-group labels in English and Spanish at singular and plural boundaries', () => {
    expect(enAgentGroups.deleteGroupConfirm('Research')).toContain('Research');
    expect(enAgentGroups.createdBy('Ada')).toBe('Created by Ada');
    expect(enAgentGroups.agentsCount(1)).toBe('1 agent');
    expect(enAgentGroups.agentsCount(2)).toBe('2 agents');

    expect(esAgentGroups.deleteGroupConfirm('Investigación')).toContain('Investigación');
    expect(esAgentGroups.createdBy('Ada')).toBe('Creado por Ada');
    expect(esAgentGroups.agentsCount(1)).toBe('1 agente');
    expect(esAgentGroups.agentsCount(2)).toBe('2 agentes');
  });

  it('formats background-task summaries and navigation labels in both locales', () => {
    expect(enBackgroundTasks.activeSummary(1)).toBe('1 active process');
    expect(enBackgroundTasks.activeSummary(3)).toBe('3 active processes');
    expect(enBackgroundTasks.backTo('Apps')).toBe('Back to Apps');

    expect(esBackgroundTasks.activeSummary(1)).toBe('1 proceso activo');
    expect(esBackgroundTasks.activeSummary(3)).toBe('3 procesos activos');
    expect(esBackgroundTasks.backTo('Aplicaciones')).toBe('Volver a Aplicaciones');
  });
});
