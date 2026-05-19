export interface MacTerminalLoginScriptInput {
  providerName: string;
  logPath: string;
  command: string[];
  env?: Record<string, string>;
  pathEntries?: string[];
}

export const shellQuote = (value: string): string => {
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

export const buildMacTerminalScriptLaunchCommand = (scriptPath: string): string => {
  return `/bin/bash ${shellQuote(scriptPath)}`;
};

export const buildMacTerminalLoginScript = ({
  providerName,
  logPath,
  command,
  env = {},
  pathEntries = [],
}: MacTerminalLoginScriptInput): string => {
  const exitVariable = `FORGER_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_LOGIN_EXIT`;
  const commandLine = command.map(shellQuote).join(' ');
  const lines = [
    '#!/bin/bash',
    'set +e',
    'set -o pipefail',
    `export FORGER_LOGIN_LOG=${shellQuote(logPath)}`,
    ...Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
  ];

  if (pathEntries.length > 0) {
    lines.push(`export PATH=${shellQuote(pathEntries.join(':'))}:"$PATH"`);
  }

  lines.push(
    'echo "[$(date)] Script started" >> "$FORGER_LOGIN_LOG"',
    'echo "PATH=$PATH" >> "$FORGER_LOGIN_LOG"',
    'command -v node >> "$FORGER_LOGIN_LOG" 2>&1',
    'command -v npm >> "$FORGER_LOGIN_LOG" 2>&1',
    `command -v ${shellQuote(command[0])} >> "$FORGER_LOGIN_LOG" 2>&1`,
    `echo "[$(date)] Running ${providerName} login" >> "$FORGER_LOGIN_LOG"`,
    `${commandLine} 2>&1 | tee -a "$FORGER_LOGIN_LOG"`,
    `${exitVariable}=$?`,
    `echo "[$(date)] ${providerName} login exited with code $${exitVariable}" >> "$FORGER_LOGIN_LOG"`,
    'echo',
    `echo "${providerName} login finished with exit code $${exitVariable}. You can close this window."`,
    `exit "$${exitVariable}"`,
  );

  return `${lines.join('\n')}\n`;
};
