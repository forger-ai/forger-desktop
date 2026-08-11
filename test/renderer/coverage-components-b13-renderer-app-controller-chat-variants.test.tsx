import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  controllerChatPersistence,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

const run = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run-1', appId: 'planner', prompt: 'Prompt', status: 'running',
  createdAt: '2026-08-10', updatedAt: '2026-08-10', dangerMode: false, permissionMode: 'safe',
  ...overrides,
});

describe('RendererAppController chat state and event variants', () => {
  it('creates missing conversations from live runs and maps activity, commits, created apps, questions, and empty terminal replies', async () => {
    const bridge = installControllerBridge({
      listInstalledApps: [{ id: 'planner', name: 'Planner', category: 'productivity', status: 'installed', version: '1.0.0' }],
    });
    const { result } = await renderControllerHarness(bridge);
    act(() => bridge.emit('onChatRunUpdated', { run: run({ conversationId: 'created-by-event', threadId: '  ', progressLog: undefined, activity: { summary: 'Working' } }) }));
    expect(result.current.activeConversation?.id).toBe('created-by-event');
    expect(result.current.activeConversation?.mode).toBe('edit_app');
    act(() => bridge.emit('onChatRunUpdated', { run: run({ conversationId: 'created-by-event', progressLog: ['Step'], threadId: 'thread-1' }) }));
    expect(result.current.activeConversationProgressLines).toEqual(['Step']);

    act(() => bridge.emit('onChatRunUpdated', { run: run({
      conversationId: 'created-by-event', status: 'applied', userMessage: 'Applied', commitSha: 'abc', threadId: 'thread-1',
      activity: { summary: 'Finished' }, createdApp: { appId: 'new-app', name: 'New app' },
    }) }));
    expect(result.current.chatMessages.at(-1)).toEqual(expect.objectContaining({ content: 'Applied', activity: { summary: 'Finished' } }));
    act(() => bridge.emit('onChatRunUpdated', { run: run({ conversationId: 'created-by-event', status: 'applied', userMessage: 'Applied', commitSha: 'abc' }) }));

    const question = { requestId: 'question', chatId: 'created-by-event', createdAt: '2026-08-10', questions: [] };
    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'question-run', conversationId: 'created-by-event', status: 'applied', questionRequest: question }) }));
    expect(result.current.chatMessages.at(-1)?.action?.type).toBe('question');
    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'empty-terminal', conversationId: 'created-by-event', status: 'failed', userMessage: '  ' }) }));
    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'orphan-terminal', conversationId: undefined, status: 'failed', userMessage: 'No target' }) }));
  });

  it('sends mode overrides and maps incomplete shared-file metadata through visible messages', async () => {
    controllerChatPersistence.state = {
      conversations: [{ id: 'free', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Free', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [{ id: 'old', role: 'user', content: 'Old' }] }],
      activeConversationByApp: { forger: 'free' }, lastActiveConversationId: 'free', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      filesPickForChat: [{ grantId: 'grant', name: 'picked.bin', sizeBytes: 0, modifiedAt: '2026-08-10', type: 'application/octet-stream' }],
      filesImport: [{ relativePath: 'folder/data.bin' }], filesList: [], chatStartRun: { runId: 'override-run', status: 'queued' },
    });
    const { result } = await renderControllerHarness(bridge);
    await waitFor(() => expect(result.current.codexAuthStatus.authenticated).toBe(true));
    await act(async () => result.current.handlePickChatFiles());
    await act(async () => result.current.handleSendMessage(undefined, { mode: 'edit_app', targetAppId: 'planner' }));
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'planner', chatMode: 'edit_app', targetAppId: 'planner', prompt: 'Review the shared files in this message.',
    }));
    expect(result.current.chatMessages.at(-1)?.files?.[0]).toEqual(expect.objectContaining({
      id: 'folder/data.bin', name: 'data.bin', relativePath: 'folder/data.bin', sizeBytes: 0, source: 'attached',
    }));

    act(() => result.current.handleStartNewConversation());
    await act(async () => result.current.handleSendMessage('Create it', { mode: 'create_app' }));
    expect(bridge.call('chatStartRun')).toHaveBeenLastCalledWith(expect.objectContaining({ chatMode: 'create_app', appId: undefined, targetAppId: null }));
    await act(async () => result.current.handleSendMessage('Blocked while active'));
  });

  it('updates only matching permission and question actions across multiple conversations', async () => {
    controllerChatPersistence.state = {
      conversations: [
        { id: 'target', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Target', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
        { id: 'other', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Other', threadId: null, createdAt: '2026-08-09', updatedAt: '2026-08-09', messages: [{ id: 'plain', role: 'assistant', content: 'Plain' }] },
      ],
      activeConversationByApp: { forger: 'target' }, lastActiveConversationId: 'target', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      getCodexAuthStatus: { installed: true, authenticated: true, authFilePath: '/tmp/auth', codexHome: '/tmp/codex' },
      chatApprovePermission: { success: true }, chatStartRun: { runId: 'answer-run', status: 'queued' },
    });
    const { result } = await renderControllerHarness(bridge);
    const permission = { requestId: 'permission', pluginId: 'gmail', permission: 'send', reason: 'Send', risk: 'high', resource: 'mail' };
    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'permission-run', appId: 'forger', conversationId: 'target', status: 'needs_permission', permissionRequest: permission }) }));
    await act(async () => result.current.handleRespondPermission('permission-run', 'permission', 'allow'));
    expect(result.current.chatMessages.at(-1)?.action?.status).toBe('approved');

    const request = { requestId: 'question', chatId: 'target', createdAt: '2026-08-10', questions: [] };
    act(() => bridge.emit('onChatRunUpdated', { run: run({ runId: 'question-run', appId: 'forger', conversationId: 'target', status: 'applied', questionRequest: request }) }));
    await act(async () => result.current.handleRespondQuestion('question-run', request, {
      answers: [{ questionId: 'q1', question: 'Choose', optionId: 'o1', label: 'One', description: 'First option' }], freeText: '  Extra context  ',
    }));
    expect(bridge.call('chatStartRun')).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('First option'),
    }));
    expect(result.current.chatMessages.at(-1)?.content).toContain('Extra context');
  });

  it('opens edit and free conversations, removes active and inactive histories, and releases staged grants on reset', async () => {
    controllerChatPersistence.state = {
      conversations: [
        { id: 'edit', appId: 'planner', mode: 'edit_app', targetAppId: null, title: 'Edit', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [] },
        { id: 'free', appId: 'forger', mode: 'free_chat', targetAppId: null, title: 'Free', threadId: null, createdAt: '2026-08-09', updatedAt: '2026-08-09', messages: [] },
      ],
      activeConversationByApp: { planner: 'edit', forger: 'free' }, lastActiveConversationId: 'edit', activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({ filesStageForChat: { grantId: 'staged', name: 'paste.txt', sizeBytes: 1, modifiedAt: '2026-08-10', type: 'text/plain', staged: true }, filesReleaseSelections: undefined });
    const { result } = await renderControllerHarness(bridge);
    act(() => result.current.handleOpenConversation('missing'));
    act(() => result.current.handleOpenConversation('free'));
    expect(result.current.selectedAppId).toBeNull();
    act(() => result.current.handleOpenConversation('edit'));
    expect(result.current.selectedAppId).toBe('planner');
    await act(async () => result.current.handleStagePastedChatFile({ name: 'paste.txt', type: 'text/plain', bytes: new Uint8Array([1]) }));
    act(() => result.current.handleDeleteConversation('free'));
    act(() => result.current.handleStartNewConversation());
    expect(bridge.call('filesReleaseSelections')).toHaveBeenCalledWith({ grantIds: ['staged'] });
    const active = result.current.activeConversationId!;
    act(() => result.current.handleDeleteConversation(active));
    expect(result.current.chatHistoryItems.some((item) => item.id === active)).toBe(false);
  });
});
