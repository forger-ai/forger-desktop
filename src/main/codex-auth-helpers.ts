import path from 'node:path';

export interface CodexAuthEnvironmentInput {
  codexHome: string;
  codexCliPath: string;
  nodePathEntries: string[];
  baseEnv?: NodeJS.ProcessEnv;
  delimiter?: string;
}

export const buildCodexAuthEnvironment = ({
  codexHome,
  codexCliPath,
  nodePathEntries,
  baseEnv = process.env,
  delimiter = path.delimiter,
}: CodexAuthEnvironmentInput): NodeJS.ProcessEnv => {
  const pathEntries = [
    ...nodePathEntries,
    path.dirname(codexCliPath),
    ...(baseEnv.PATH ?? '').split(delimiter),
  ].filter(Boolean);
  const dedupedPathEntries = [...new Set(pathEntries)];
  return {
    ...baseEnv,
    CODEX_HOME: codexHome,
    PATH: dedupedPathEntries.join(delimiter),
  };
};

const stripTrailingUrlPunctuation = (value: string): string => value.replace(/[),.;\]}]+$/g, '');

export const extractAllowedCodexAuthUrls = (text: string): string[] => {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const candidate = stripTrailingUrlPunctuation(match[0]);
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:') {
        continue;
      }
      if (parsed.hostname !== 'auth.openai.com') {
        continue;
      }
      urls.add(parsed.toString());
    } catch {
      // Ignore malformed CLI output fragments.
    }
  }
  return [...urls];
};

export const classifyCodexAuthOutput = (stdout = '', stderr = ''): string | undefined => {
  const text = `${stdout}\n${stderr}`;
  if (/env:\s*node:\s*No such file or directory/i.test(text)) {
    return 'codex_node_runtime_missing';
  }
  if (/(Failed to refresh token|refresh token).*401 Unauthorized/i.test(text) || /401 Unauthorized/i.test(text)) {
    return 'codex_auth_expired';
  }
  return undefined;
};
