import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS, LEGACY_AGENT_IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');

test('IPC channels stay unique', () => {
  const channels = Object.values(IPC_CHANNELS);
  assert.equal(new Set(channels).size, channels.length);
});

test('core chat and app-agent IPC channels keep their public names', () => {
  assert.deepEqual(
    {
      chatStartRun: IPC_CHANNELS.chatStartRun,
      chatGetRun: IPC_CHANNELS.chatGetRun,
      chatCancelRun: IPC_CHANNELS.chatCancelRun,
      chatApplyRun: IPC_CHANNELS.chatApplyRun,
      chatRunUpdated: IPC_CHANNELS.chatRunUpdated,
      prepareDesktopErrorReport: IPC_CHANNELS.prepareDesktopErrorReport,
      prepareConversationDiagnosticReport: IPC_CHANNELS.prepareConversationDiagnosticReport,
      submitConversationDiagnosticReport: IPC_CHANNELS.submitConversationDiagnosticReport,
      getCloudStorageUsage: IPC_CHANNELS.getCloudStorageUsage,
      llmRunsSnapshotGet: IPC_CHANNELS.llmRunsSnapshotGet,
      llmRunsSnapshotChanged: IPC_CHANNELS.llmRunsSnapshotChanged,
      appAgentTaskStart: IPC_CHANNELS.appAgentTaskStart,
      appAgentTaskGet: IPC_CHANNELS.appAgentTaskGet,
      appAgentTaskCancel: IPC_CHANNELS.appAgentTaskCancel,
      appAgentTaskApprovePermission: IPC_CHANNELS.appAgentTaskApprovePermission,
      appAgentTaskUpdated: IPC_CHANNELS.appAgentTaskUpdated,
      appAgentConversationCreate: IPC_CHANNELS.appAgentConversationCreate,
      appAgentConversationSendMessage: IPC_CHANNELS.appAgentConversationSendMessage,
      appAgentConversationGet: IPC_CHANNELS.appAgentConversationGet,
      appAgentConversationList: IPC_CHANNELS.appAgentConversationList,
      appAgentConversationDelete: IPC_CHANNELS.appAgentConversationDelete,
      appAgentConversationCancelRun: IPC_CHANNELS.appAgentConversationCancelRun,
      appAgentConversationApprovePermission: IPC_CHANNELS.appAgentConversationApprovePermission,
      appAgentConversationEvent: IPC_CHANNELS.appAgentConversationEvent,
      appManifestAgentStart: IPC_CHANNELS.appManifestAgentStart,
      appManifestAgentResume: IPC_CHANNELS.appManifestAgentResume,
      appManifestAgentSteer: IPC_CHANNELS.appManifestAgentSteer,
      appManifestAgentStop: IPC_CHANNELS.appManifestAgentStop,
      deepLink: IPC_CHANNELS.deepLink,
    },
    {
      chatStartRun: 'forger:chat:start-run',
      chatGetRun: 'forger:chat:get-run',
      chatCancelRun: 'forger:chat:cancel-run',
      chatApplyRun: 'forger:chat:apply-run',
      chatRunUpdated: 'forger:chat:run-updated',
      prepareDesktopErrorReport: 'forger:error-report:prepare',
      prepareConversationDiagnosticReport: 'forger:conversation-diagnostic:prepare',
      submitConversationDiagnosticReport: 'forger:conversation-diagnostic:submit',
      getCloudStorageUsage: 'forger:cloud-storage:get',
      llmRunsSnapshotGet: 'forger:llm-runs:snapshot:get',
      llmRunsSnapshotChanged: 'forger:llm-runs:snapshot:changed',
      appAgentTaskStart: 'forger:app:agent-task:start',
      appAgentTaskGet: 'forger:app:agent-task:get',
      appAgentTaskCancel: 'forger:app:agent-task:cancel',
      appAgentTaskApprovePermission: 'forger:app:agent-task:approve-permission',
      appAgentTaskUpdated: 'forger:app:agent-task:updated',
      appAgentConversationCreate: 'forger:app:agent-conversation:create',
      appAgentConversationSendMessage: 'forger:app:agent-conversation:send-message',
      appAgentConversationGet: 'forger:app:agent-conversation:get',
      appAgentConversationList: 'forger:app:agent-conversation:list',
      appAgentConversationDelete: 'forger:app:agent-conversation:delete',
      appAgentConversationCancelRun: 'forger:app:agent-conversation:cancel-run',
      appAgentConversationApprovePermission: 'forger:app:agent-conversation:approve-permission',
      appAgentConversationEvent: 'forger:app:agent-conversation:event',
      appManifestAgentStart: 'forger:app:agents:start',
      appManifestAgentResume: 'forger:app:agents:resume',
      appManifestAgentSteer: 'forger:app:agents:steer',
      appManifestAgentStop: 'forger:app:agents:stop',
      deepLink: 'forger:deep-link',
    },
  );
});

test('legacy Codex IPC channels continue to alias the app-agent channels', () => {
  assert.deepEqual(LEGACY_AGENT_IPC_CHANNELS, {
    [IPC_CHANNELS.appCodexTaskStart]: IPC_CHANNELS.appAgentTaskStart,
    [IPC_CHANNELS.appCodexTaskGet]: IPC_CHANNELS.appAgentTaskGet,
    [IPC_CHANNELS.appCodexTaskCancel]: IPC_CHANNELS.appAgentTaskCancel,
    [IPC_CHANNELS.appCodexTaskApprovePermission]: IPC_CHANNELS.appAgentTaskApprovePermission,
    [IPC_CHANNELS.appCodexConversationCreate]: IPC_CHANNELS.appAgentConversationCreate,
    [IPC_CHANNELS.appCodexConversationSendMessage]: IPC_CHANNELS.appAgentConversationSendMessage,
    [IPC_CHANNELS.appCodexConversationGet]: IPC_CHANNELS.appAgentConversationGet,
    [IPC_CHANNELS.appCodexConversationList]: IPC_CHANNELS.appAgentConversationList,
    [IPC_CHANNELS.appCodexConversationDelete]: IPC_CHANNELS.appAgentConversationDelete,
    [IPC_CHANNELS.appCodexConversationCancelRun]: IPC_CHANNELS.appAgentConversationCancelRun,
    [IPC_CHANNELS.appCodexConversationApprovePermission]: IPC_CHANNELS.appAgentConversationApprovePermission,
  });

  for (const [legacyChannel, currentChannel] of Object.entries(LEGACY_AGENT_IPC_CHANNELS)) {
    assert.match(legacyChannel, /^forger:app:codex-/);
    assert.match(currentChannel, /^forger:app:agent-/);
  }
});
