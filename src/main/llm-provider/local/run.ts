import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LlmProviderRunInput } from '../run-service';
import type { LlmCommandResult } from '../types';
import { codexCliAdapter, parseCodexJsonl } from '../adapters/codex-cli-adapter';
import { preflightLocalModel, validateLocalConfig, validateLocalContextRequest } from './preflight';
import { stopLocalProcessTree } from './process';
import { createLocalInferenceGateway, type LocalInferenceGateway } from './gateway';
import { prepareLocalAgentProfile } from './profiles';
import { prepareLocalContext } from './context-preprocessor';
import type { LocalInferenceEvidence } from './types';

export function assertLocalInput(input: LlmProviderRunInput): void {
  if (input.runtime.provider !== 'codex' || input.surface !== 'app_prompt_task' || input.mode !== 'task'
    || input.runtime.authProfileId || input.conversationId || input.threadId || input.imagePaths?.length
    || input.mcpServers?.length || input.addDirs?.length || input.sharedRoots?.length
    || input.networkAccess || input.codexHomePlan || input.resolvedCommand || input.configWorkspaceRoot
    || input.runtime.permissionMode === 'unsafe' || input.permissionMode === 'unsafe'
    || Object.keys(input.environment).length) throw new Error('local_scope_unsupported');
  if (!input.localInference || input.runtime.model !== input.localInference.model) throw new Error('local_model_mismatch');
  validateLocalConfig(input.localInference);
  validateLocalContextRequest(input.prompt, input.localContextRequest, input.localInference.contextStrategy === 'staged-request-v2');
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3600000
    || (input.inactivityTimeoutMs !== undefined && (!Number.isFinite(input.inactivityTimeoutMs) || input.inactivityTimeoutMs < 1))) {
    throw new Error('local_timeout_invalid');
  }
}

async function rejectProjectConfig(workingDir: string): Promise<void> {
  let current = await fs.realpath(workingDir);
  while (true) {
    // Project settings and hooks can override a local-only user config. Fail closed.
    try {
      await fs.lstat(path.join(current, '.codex'));
      throw new Error('local_project_config_unsupported');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isolatedEnvironment(home: string, pathEntries: string[]): NodeJS.ProcessEnv {
  // Tombstones also protect legacy capture implementations which merge process.env.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    PATH: pathEntries.join(path.delimiter),
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
  });
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  return env;
}

async function captureBounded(input: LlmProviderRunInput, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<LlmCommandResult> {
  return await new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let settled = false;
    let byteCount = 0;
    let inactivity: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      clearTimeout(deadline);
      clearTimeout(inactivity);
      input.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      stopLocalProcessTree(child);
      cleanup();
      reject(error);
    };
    const abort = (): void => fail(new Error('local_cancelled'));
    const deadline = setTimeout(() => fail(new Error('local_timeout')), input.timeoutMs);
    const resetInactivity = (): void => {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => fail(new Error('local_inactivity_timeout')), input.inactivityTimeoutMs ?? Math.min(input.timeoutMs, 120000));
    };
    const output = (stream: 'stdout' | 'stderr', text: string): void => {
      if (settled) return;
      byteCount += Buffer.byteLength(text);
      if (byteCount > 4 * 1024 * 1024) { fail(new Error('local_output_limit')); return; }
      resetInactivity();
      input.onOutput?.(stream, text);
      input.onEvent?.({ type: 'output', provider: 'codex', runId: input.runId, stream, text });
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) { abort(); return; }
    resetInactivity();
    Promise.resolve().then(() => input.runCommandCapture(command, args, {
      cwd: input.workingDir,
      env,
      timeoutMs: input.timeoutMs,
      inactivityTimeoutMs: input.inactivityTimeoutMs,
      stdinText: input.prompt,
      onChild: (value) => {
        child = value;
        if (settled) stopLocalProcessTree(child);
        else input.onChild?.(child);
      },
      onStdout: (text) => output('stdout', text),
      onStderr: (text) => output('stderr', text),
    })).then((result) => {
      if (settled) return;
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4 * 1024 * 1024) { fail(new Error('local_output_limit')); return; }
      settled = true;
      cleanup();
      resolve(result);
    }, (error: unknown) => fail(error instanceof Error ? error : new Error('local_cli_failed')));
  });
}

export async function runLocalInference(originalInput: LlmProviderRunInput, cliPath: string) {
  let observedEvidence: LocalInferenceEvidence | undefined;
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  const deadline = setTimeout(() => controller.abort(), originalInput.timeoutMs);
  originalInput.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (originalInput.signal?.aborted) controller.abort();
  try {
    return await executeLocalInference({ ...originalInput, signal: controller.signal }, cliPath, (evidence) => {
      observedEvidence = evidence;
    });
  } catch (error) {
    if (controller.signal.aborted) {
      const failure = new Error(originalInput.signal?.aborted ? 'local_cancelled' : 'local_timeout');
      if (observedEvidence) Object.assign(failure, { localInference: observedEvidence });
      throw failure;
    }
    if (observedEvidence) {
      throw Object.assign(error instanceof Error ? error : new Error('local_cli_failed'), {
        localInference: observedEvidence,
      });
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    originalInput.signal?.removeEventListener('abort', forwardAbort);
  }
}

async function executeLocalInference(
  input: LlmProviderRunInput,
  cliPath: string,
  onEvidence: (evidence: LocalInferenceEvidence) => void,
) {
  assertLocalInput(input);
  const config = input.localInference!;
  await rejectProjectConfig(input.workingDir);
  const localInference = await preflightLocalModel(config, input.signal);
  localInference.observedToolContracts = [];
  onEvidence(localInference);
  if (config.contextStrategy === 'staged-v1' || config.contextStrategy === 'staged-request-v2') {
    input = { ...input, prompt: await prepareLocalContext({
      config, prompt: input.prompt, localContextRequest: input.localContextRequest, workingDir: input.workingDir, signal: input.signal,
      onEvidence: (evidence) => { localInference.contextPreparation = evidence; },
    }) };
  }
  const resolved = await codexCliAdapter.resolveCommand(cliPath, input.pathEntries);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-local-'));
  let gateway: LocalInferenceGateway | undefined;
  try {
    const profile = await prepareLocalAgentProfile(config.agentProfile, home);
    Object.assign(localInference, profile.evidence);
    gateway = await createLocalInferenceGateway({
      endpoint: validateLocalConfig(config), model: config.model, timeoutMs: input.timeoutMs,
      onToolInventory: (inventory) => { localInference.observedToolContracts = inventory; },
    });
    await fs.mkdir(path.join(home, '.codex'), { mode: 0o700 });
    const settings = [
      'model_provider="forger_local"',
      `model_providers.forger_local.name="Forger local experimental"`,
      `model_providers.forger_local.base_url=${JSON.stringify(gateway.baseUrl)}`,
      'model_providers.forger_local.env_key="FORGER_LOCAL_GATEWAY_TOKEN"',
      'model_providers.forger_local.wire_api="responses"',
      'model_providers.forger_local.requires_openai_auth=false',
      'model_providers.forger_local.supports_websockets=false',
      'model_providers.forger_local.request_max_retries=0',
      'model_providers.forger_local.stream_max_retries=0',
      `model_context_window=${config.contextWindow}`,
      'sandbox_workspace_write.network_access=false',
      'web_search="disabled"',
      'analytics.enabled=false',
      'feedback.enabled=false',
      'otel.exporter="none"',
      'otel.trace_exporter="none"',
      'allow_login_shell=false',
      'shell_environment_policy.inherit="none"',
      'shell_environment_policy.experimental_use_profile=false',
      `shell_environment_policy.set.HOME=${JSON.stringify(home)}`,
      `shell_environment_policy.set.PATH=${JSON.stringify(resolved.pathEntries.join(path.delimiter))}`,
      `shell_environment_policy.set.TMPDIR=${JSON.stringify(home)}`,
      'features.shell_snapshot=false',
      ...profile.settings,
    ];
    const args = [...resolved.prefixArgs, '--ask-for-approval', 'never',
      ...settings.flatMap((setting) => ['--config', setting]),
      'exec', '--ignore-user-config', '--json', '--ephemeral', '--sandbox', 'workspace-write', '--skip-git-repo-check',
      '--model', config.model, '-C', input.workingDir, '--', '-'];
    input.onEvent?.({ type: 'started', provider: 'codex', runId: input.runId });
    const environment = isolatedEnvironment(home, resolved.pathEntries);
    environment.FORGER_LOCAL_GATEWAY_TOKEN = gateway.token;
    const result = await captureBounded(input, resolved.command, args, environment);
    if (result.code !== 0) throw new Error('local_cli_failed');
    const parsed = parseCodexJsonl(result.stdout, result.stderr);
    input.onEvent?.({ type: 'finished', provider: 'codex', runId: input.runId, assistantText: parsed.assistantText });
    return { ...result, ...parsed, code: 0, conversationId: undefined, threadId: undefined, localInference };
  } catch (error) {
    const failure = Object.assign(error instanceof Error ? error : new Error('local_cli_failed'), { localInference });
    input.onEvent?.({ type: 'failed', provider: 'codex', runId: input.runId, error: failure });
    throw failure;
  } finally {
    await gateway?.close();
    await fs.rm(home, { recursive: true, force: true });
  }
}
