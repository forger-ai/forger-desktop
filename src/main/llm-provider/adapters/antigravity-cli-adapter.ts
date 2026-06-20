import path from 'node:path';
import { assertAllowedMcpServers } from '../../codex-run-isolation';
import {
  buildAntigravityArgs,
  parseAntigravityOutput,
  prepareAntigravityLogPath,
  readAntigravityLog,
  writeAntigravityMcpConfig,
} from '../../app-agent/mcp';
import { resolveAntigravityCliModel } from '../../../shared/agent-runtime-registry';
import type { LlmCliRunInput, LlmRunResult } from '../types';
import { createProviderQuotaError, detectProviderQuotaError } from '../provider-errors';

export class AntigravityCliAdapter {
  public readonly key = 'antigravity' as const;

  public async run(input: LlmCliRunInput): Promise<LlmRunResult> {
    const mcpServers = input.mcpServers ?? [];
    const configWorkspaceRoot = input.configWorkspaceRoot ?? input.workingDir;
    const mcpConfig = await writeAntigravityMcpConfig(configWorkspaceRoot, mcpServers);
    const logPath = await prepareAntigravityLogPath(configWorkspaceRoot, input.runId);
    const allowedMcpServers = new Set(mcpServers.map((server) => server.name));
    const cliModel = input.model ? resolveAntigravityCliModel(input.model, input.effort) : undefined;
    const args = buildAntigravityArgs({
      prompt: input.prompt,
      model: cliModel,
      threadId: input.conversationId,
      addDirs: input.addDirs,
      logFile: logPath,
      hasMcpServers: mcpServers.length > 0,
      permissionMode: input.permissionMode,
    });

    const emitOutput = (stream: 'stdout' | 'stderr' | 'meta', text: string): void => {
      input.onOutput?.(stream, text);
      input.onEvent?.({ type: 'output', provider: this.key, runId: input.runId, stream, text });
    };

    emitOutput('meta', [
      `Antigravity workingDir=${input.workingDir}`,
      `configWorkspaceRoot=${configWorkspaceRoot}`,
      `logFile=${logPath}`,
      `mcpConfig=${mcpConfig?.configPath ?? '(none)'}`,
      `allowedMcpServers=${mcpServers.map((server) => server.name).join(',') || '(none)'}`,
      `model=${input.model ?? '(default)'}`,
      `effort=${input.effort ?? '(default)'}`,
      `cliModel=${cliModel ?? '(default)'}`,
    ].join(' '));
    input.onEvent?.({ type: 'started', provider: this.key, runId: input.runId });

    try {
      const result = await input.runCommandCapture(input.cliPath, args, {
        cwd: input.workingDir,
        env: {
          FORGER_ALLOWED_ROOTS: [input.workingDir, ...(input.sharedRoots ?? [])].join(path.delimiter),
          ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
          ...input.environment,
          PATH: [path.dirname(input.cliPath), ...input.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
        },
        ...(input.timeoutMode === 'inactivity'
          ? { inactivityTimeoutMs: input.timeoutMs }
          : { timeoutMs: input.timeoutMs }),
        onChild: input.onChild,
        onStdout: (text) => emitOutput('stdout', text),
        onStderr: (text) => emitOutput('stderr', text),
      });
      assertAllowedMcpServers(result.stdout, result.stderr, allowedMcpServers);
      const logText = await readAntigravityLog(logPath);
      const quotaError = detectProviderQuotaError(this.key, result.stdout, result.stderr, logText);
      if (quotaError) {
        throw createProviderQuotaError(quotaError);
      }
      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || 'antigravity_exec_failed').trim());
      }

      const parsed = parseAntigravityOutput(result.stdout, result.stderr, logText);
      if (parsed.threadId) {
        input.onEvent?.({ type: 'conversation', provider: this.key, runId: input.runId, id: parsed.threadId });
      }
      const output = {
        assistantText: parsed.assistantText || 'Listo. ¿Qué te gustaría hacer ahora?',
        conversationId: parsed.threadId ?? input.conversationId ?? null,
        toolEvents: parsed.toolEvents.length,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      input.onEvent?.({
        type: 'finished',
        provider: this.key,
        runId: input.runId,
        assistantText: output.assistantText,
        conversationId: output.conversationId,
      });
      return output;
    } catch (error) {
      input.onEvent?.({ type: 'failed', provider: this.key, runId: input.runId, error: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    } finally {
      await mcpConfig?.cleanup().catch(() => undefined);
    }
  }
}

export const antigravityCliAdapter = new AntigravityCliAdapter();
