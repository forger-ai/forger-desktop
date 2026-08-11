import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  controllerChatPersistence,
  installControllerBridge,
  renderControllerHarness,
  resetControllerHarness,
} from './helpers/renderer-app-controller-harness';

beforeEach(resetControllerHarness);

describe('RendererAppController social review and forum edge flows', () => {
  const reviewConversation = {
    id: 'review-conversation', appId: 'quarantine-1', mode: 'social_app_review', targetAppId: 'quarantine-1',
    title: 'Review app', threadId: null, createdAt: '2026-08-10', updatedAt: '2026-08-10', messages: [],
  };

  it('finishes and deletes a quarantined Social app for both success and failure outcomes', async () => {
    controllerChatPersistence.state = {
      conversations: [reviewConversation], activeConversationByApp: { 'quarantine-1': reviewConversation.id },
      lastActiveConversationId: reviewConversation.id, activeRuns: [], draftInputByConversationId: {},
    };
    const bridge = installControllerBridge({
      finishSocialAppInstall: { success: true, appId: 'installed-social', userMessage: 'Installed' },
      deleteQuarantinedSocialApp: { success: true, userMessage: 'Deleted' },
    });
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleFinishSocialReviewInstall());
    expect(result.current.currentView).toBe('app');
    await act(async () => result.current.handleDeleteSocialReview());
    expect(result.current.chatMessages.at(-1)?.role).toBe('assistant');

    bridge.set('finishSocialAppInstall', { success: false, userMessage: 'Install failed', technicalCode: 'social_finish_failed' });
    await act(async () => result.current.handleFinishSocialReviewInstall());
    bridge.set('deleteQuarantinedSocialApp', { success: false, userMessage: 'Delete failed', technicalCode: 'social_delete_failed' });
    await act(async () => result.current.handleDeleteSocialReview());
    expect(result.current.bannerSeverity).toBe('error');
  });

  it('guards Social review actions when the active conversation is not a quarantine', async () => {
    const bridge = installControllerBridge();
    const { result } = await renderControllerHarness(bridge);
    await act(async () => result.current.handleFinishSocialReviewInstall());
    await act(async () => result.current.handleDeleteSocialReview());
    expect(bridge.call('finishSocialAppInstall')).not.toHaveBeenCalled();
    expect(bridge.call('deleteQuarantinedSocialApp')).not.toHaveBeenCalled();
  });

  it('requires an account for the forum, prevents concurrent updates, and surfaces update errors', async () => {
    const unauthenticated = await renderControllerHarness();
    await act(async () => unauthenticated.result.current.handleEnterForum());
    expect(unauthenticated.result.current.cloudModalOpen).toBe(true);
    unauthenticated.unmount();

    const pending = Promise.withResolvers<{ status: 'opted_in'; isModerator: boolean }>();
    const bridge = installControllerBridge({
      getForgerAccount: { authenticated: true, user: { id: 1, email: 'user@example.com', confirmed: true } },
      updateForumParticipation: () => pending.promise,
    });
    const { result } = await renderControllerHarness(bridge);
    let entering!: Promise<void>;
    act(() => { entering = result.current.handleEnterForum(); });
    await waitFor(() => expect(result.current.forumParticipationBusy).toBe(true));
    await act(async () => result.current.handleDismissForumPrompt());
    expect(bridge.call('updateForumParticipation')).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 'opted_in', isModerator: false });
    await act(async () => entering);
    expect(result.current.currentView).toBe('friends');

    bridge.set('updateForumParticipation', () => Promise.reject(new Error('Forum offline')));
    await act(async () => result.current.handleDismissForumPrompt());
    expect(result.current.bannerMessage).toBe('Forum offline');
  });
});
