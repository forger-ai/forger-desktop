import assert from 'node:assert/strict';

import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');

test('personal agents IPC channels keep stable public names', () => {
  assert.deepEqual(
    {
      personalAgentsList: IPC_CHANNELS.personalAgentsList,
      personalAgentsCreate: IPC_CHANNELS.personalAgentsCreate,
      personalAgentGrantOptionsList: IPC_CHANNELS.personalAgentGrantOptionsList,
      personalAgentUpdatePermissions: IPC_CHANNELS.personalAgentUpdatePermissions,
      personalAgentsDelete: IPC_CHANNELS.personalAgentsDelete,
      personalAgentConversationsList: IPC_CHANNELS.personalAgentConversationsList,
      personalAgentWorkspaceList: IPC_CHANNELS.personalAgentWorkspaceList,
      personalAgentWorkspaceFileRead: IPC_CHANNELS.personalAgentWorkspaceFileRead,
      personalAgentWorkspaceFileWrite: IPC_CHANNELS.personalAgentWorkspaceFileWrite,
      personalAgentStartConversation: IPC_CHANNELS.personalAgentStartConversation,
      personalAgentSendMessage: IPC_CHANNELS.personalAgentSendMessage,
      personalAgentGetConversation: IPC_CHANNELS.personalAgentGetConversation,
      personalAgentConversationEvent: IPC_CHANNELS.personalAgentConversationEvent,
    },
    {
      personalAgentsList: 'forger:personal-agents:list',
      personalAgentsCreate: 'forger:personal-agents:create',
      personalAgentGrantOptionsList: 'forger:personal-agents:grant-options:list',
      personalAgentUpdatePermissions: 'forger:personal-agents:permissions:update',
      personalAgentsDelete: 'forger:personal-agents:delete',
      personalAgentConversationsList: 'forger:personal-agents:conversations:list',
      personalAgentWorkspaceList: 'forger:personal-agents:workspace:list',
      personalAgentWorkspaceFileRead: 'forger:personal-agents:workspace:file:read',
      personalAgentWorkspaceFileWrite: 'forger:personal-agents:workspace:file:write',
      personalAgentStartConversation: 'forger:personal-agents:conversation:start',
      personalAgentSendMessage: 'forger:personal-agents:conversation:send',
      personalAgentGetConversation: 'forger:personal-agents:conversation:get',
      personalAgentConversationEvent: 'forger:personal-agents:conversation:event',
    },
  );
});
