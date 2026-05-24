import { renderPromptFile } from './index';

export const FORGER_AGENT_CONTRACT_VERSION = 13;
export const FORGER_AGENT_CONTRACT_MARKER = `FORGER_AGENT_CONTRACT_VERSION: ${FORGER_AGENT_CONTRACT_VERSION}`;
export const FORGER_AGENT_CONTRACT_MARKER_PREFIX = 'FORGER_AGENT_CONTRACT_VERSION:';

export const buildGlobalForgerAgentsMarkdown = (): string =>
  renderPromptFile('agents-md/global-forger.md', {
    forgerContractMarker: FORGER_AGENT_CONTRACT_MARKER,
    forgerPartial: renderPromptFile('partials/forger.md', {}),
  });
