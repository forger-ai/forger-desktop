import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  controllerChatPersistence,
  controllerSettingsFixture,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

describe('resuming conversations saved before mode selection', () => {
  it.each([
    { title: 'Conversacion nueva', hasHistory: false, profile: 'work' },
    { title: 'New conversation', hasHistory: false, profile: undefined },
    { title: 'New conversation', hasHistory: true, profile: 'work' },
    { title: 'My project', hasHistory: false, profile: undefined },
  ])('preserves history and assigns a runtime for $title (history: $hasHistory)', async ({ title, hasHistory, profile }) => {
    const previousMessages = hasHistory
      ? [{ id: 'previous', role: 'user', content: 'Previous question' }]
      : [];
    controllerChatPersistence.state = {
      conversations: [{
        id: 'saved', appId: 'forger', mode: 'free_chat', targetAppId: null,
        title, threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10',
        messages: previousMessages,
      }],
      activeConversationByApp: { forger: 'saved' },
      lastActiveConversationId: 'saved', activeRuns: [], draftInputByConversationId: {},
    };
    const settings = controllerSettingsFixture();
    settings.activeProviderProfiles = profile ? { codex: profile } : {};
    const bridge = installControllerBridge({
      getSettings: settings,
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      filesList: [], chatStartRun: { runId: 'resumed-run', status: 'queued' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    expect(result.current.activeConversation?.id).toBe('saved');

    await act(async () => result.current.handleSendMessage('Continue my project'));

    const shouldSummarize = !hasHistory && title !== 'My project';
    expect(result.current.activeConversation).toEqual(expect.objectContaining({
      id: 'saved', title: shouldSummarize ? 'Continue my project' : title,
      runtime: {
        provider: 'codex', model: 'gpt-5.2-codex', effort: 'medium',
        ...(profile ? { authProfileId: profile } : {}),
      },
    }));
    expect(result.current.chatMessages).toEqual([
      ...previousMessages,
      expect.objectContaining({ role: 'user', content: 'Continue my project' }),
    ]);
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'saved', chatMode: 'free_chat', provider: 'codex',
      ...(profile ? { authProfileId: profile } : {}),
    }));
  });
});
