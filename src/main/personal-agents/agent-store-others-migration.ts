const OTHERS_PEER_BLOCK_BEGIN = '<!-- FORGER_MANAGED_PEER_AGENTS_BEGIN -->';
const OTHERS_PEER_BLOCK_END = '<!-- FORGER_MANAGED_PEER_AGENTS_END -->';
const LEGACY_OTHERS_INTRO = 'This file defines how `';
const LEGACY_OTHERS_DURABLE_HEADING = '## What To Record Here';
const LEGACY_OTHERS_DURABLE_SCAFFOLD_LINES = new Set([
  'Record only reusable collaboration rules that help future runs, such as:',
  '- Which agents or apps should be consulted for specific recurring topics.',
  '- When a handoff is appropriate or inappropriate.',
  '- Which account/session selection questions the human prefers.',
  '- Communication tone or review expectations for external messages.',
  '- Safety checks that should happen before another agent receives context.',
  'Do not store secrets, raw sensitive content, private message bodies, account identifiers that are not necessary, or one-off transcript details. Replace stale collaboration rules when the human corrects them.',
]);

const withoutManagedBlock = (content: string): string => {
  const beginIndex = content.indexOf(OTHERS_PEER_BLOCK_BEGIN);
  const endIndex = content.indexOf(OTHERS_PEER_BLOCK_END);
  if (beginIndex < 0 || endIndex <= beginIndex) {
    return content;
  }
  return `${content.slice(0, beginIndex).trimEnd()}\n${content.slice(endIndex + OTHERS_PEER_BLOCK_END.length).trimStart()}`;
};

export const extractLegacyOthersDurableCriteria = (content: string): string | null => {
  if (!content.includes(LEGACY_OTHERS_INTRO) || !content.includes('## Source Of Truth')) {
    return null;
  }
  const unmanaged = withoutManagedBlock(content);
  const headingIndex = unmanaged.indexOf(LEGACY_OTHERS_DURABLE_HEADING);
  if (headingIndex < 0) {
    return null;
  }
  const durableSection = unmanaged.slice(headingIndex + LEGACY_OTHERS_DURABLE_HEADING.length);
  return durableSection
    .split(/\r?\n/)
    .filter((line) => !LEGACY_OTHERS_DURABLE_SCAFFOLD_LINES.has(line.trim()))
    .join('\n')
    .trim()
    .replace(/\n{3,}/g, '\n\n');
};

interface ManagedAgentToolsConfig {
  canSpawnAgents: boolean;
  peerAgentGrants: Array<{ agentId: string; name?: string; criteria?: string }>;
}

export const buildManagedAgentToolsBlock = (agent: ManagedAgentToolsConfig): string => {
  const lines = [
    OTHERS_PEER_BLOCK_BEGIN,
    '## Forger-Managed Agent Tools Configuration',
    '',
    'This block is generated from Forger Desktop permissions. Edit peer access in Forger Settings; manual notes belong outside this block.',
    '',
    `- Create other agents: ${agent.canSpawnAgents ? 'enabled' : 'disabled'}.`,
  ];
  if (agent.peerAgentGrants.length === 0) {
    lines.push('- Contact other agents: disabled; no peer agents are currently allowed.');
  } else {
    lines.push(`- Contact other agents: enabled for ${agent.peerAgentGrants.length} allowed agent${agent.peerAgentGrants.length === 1 ? '' : 's'}.`);
    lines.push(...agent.peerAgentGrants.map((grant) => {
      const label = grant.name ? `${grant.name} (${grant.agentId})` : grant.agentId;
      return `- ${label}: ${grant.criteria || 'No specific criteria recorded.'}`;
    }));
  }
  lines.push('', OTHERS_PEER_BLOCK_END);
  return lines.join('\n');
};
