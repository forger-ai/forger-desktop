import assert from 'node:assert/strict';
import test from 'node:test';

import { selectSidekickPersonalAgentId } from '../../dist-electron/main/sidekick-voice-runtime.js';

const agents = [{ id: 'agent-a' }, { id: 'agent-b' }];

test('Sidekick voice uses an explicit valid agent binding', () => {
  assert.equal(selectSidekickPersonalAgentId('agent-b', agents), 'agent-b');
  assert.throws(
    () => selectSidekickPersonalAgentId('agent-deleted', agents),
    /sidekick_voice_personal_agent_binding_invalid/,
  );
});

test('Sidekick voice only falls back automatically when exactly one agent exists', () => {
  assert.equal(selectSidekickPersonalAgentId(undefined, [{ id: 'only-agent' }]), 'only-agent');
  assert.throws(() => selectSidekickPersonalAgentId(undefined, []), /sidekick_voice_personal_agent_required/);
  assert.throws(() => selectSidekickPersonalAgentId(undefined, agents), /sidekick_voice_personal_agent_selection_required/);
});
