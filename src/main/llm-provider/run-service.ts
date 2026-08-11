import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentProvider, AgentRuntime, ChatErrorCode } from '../../shared/types';
import {
  createIsolatedCodexHome,
  preparePersistentIsolatedCodexHome,
  removeIsolatedCodexHome,
} from '../codex-run-isolation';
import { getLlmProviderDescriptor, type LlmProviderResolvedCommand, type LlmProviderRunMode, type LlmProviderRunOutput } from './descriptors';
import { resolveLlmProviderAuthContext } from './profile-resolver';
import type { LlmCliRunInput, LlmProviderAuthProfileResolver, LlmRunCommandCapture } from './types';

export type LlmProviderSurface =
  | 'desktop_chat'
  | 'app_agent_thread'
  | 'app_prompt_task'
  | 'automation'
  | 'personal_agent'
  | 'memory_maintenance';

export type LlmProviderSetupErrorMode = 'chat' | 'code';

export type LlmProviderCodexHomePlan =
  | { type: 'none' }
  | { type: 'provided'; path: string; rootCodexHome?: string }
  | { type: 'temporary'; rootCodexHome: string; prefix: string; trustedRoots: string[]; networkAccess?: boolean }
  | { type: 'persistent'; rootCodexHome: string; targetCodexHome: string; trustedRoots: string[]; networkAccess?: boolean };

export interface LlmProviderRunServiceOptions {
  codexHome?: string;
  providerProfilesRoot?: string;
  resolveAuthProfile?: LlmProviderAuthProfileResolver;
  getProviderProfile?: LlmProviderAuthProfileResolver;
  getCodexCliPath?: () => Promise<string | null>;
  getClaudeCliPath?: () => Promise<string | null>;
  getAntigravityCliPath?: () => Promise<string | null>;
  getCodexAuthenticated?: () => Promise<boolean>;
  getClaudeAuthenticated?: () => Promise<boolean>;
  getAntigravityAuthenticated?: () => Promise<boolean>;
  ensureGitAvailable?: () => Promise<void>;
}

export interface LlmProviderRunInput extends Omit<LlmCliRunInput, 'cliPath' | 'runCommandCapture'> {
  surface: LlmProviderSurface;
  mode: LlmProviderRunMode;
  runtime: AgentRuntime;
  cliPath?: string;
  runCommandCapture: LlmRunCommandCapture;
  codexHomePlan?: LlmProviderCodexHomePlan;
  threadId?: string | null;
  imagePaths?: string[];
  networkAccess?: boolean;
  alwaysIncludeMcpConfig?: boolean;
  throwOnNonZero?: boolean;
  resolvedCommand?: LlmProviderResolvedCommand;
  checkReady?: boolean;
  setupErrorMode?: LlmProviderSetupErrorMode;
}

export class LlmProviderRunService {
  public constructor(private readonly options: LlmProviderRunServiceOptions = {}) {}

  public async resolveCommand(
    provider: AgentProvider,
    cliPath: string,
    pathEntries: string[],
  ): Promise<LlmProviderResolvedCommand> {
    const descriptor = getLlmProviderDescriptor(provider);
    return descriptor.resolveCommand
      ? await descriptor.resolveCommand(cliPath, pathEntries)
      : { command: cliPath, prefixArgs: [], pathEntries };
  }

  public async assertReady(
    provider: AgentProvider,
    mode: LlmProviderSetupErrorMode = 'code',
  ): Promise<void> {
    await this.assertProviderReady(provider, mode);
    await this.getProviderCliPath(provider, mode);
    if (provider === 'codex') {
      await this.options.ensureGitAvailable?.();
    }
  }

  public async run(input: LlmProviderRunInput): Promise<LlmProviderRunOutput> {
    const provider = input.runtime.provider;
    const descriptor = getLlmProviderDescriptor(provider);
    if (input.checkReady !== false) {
      await this.assertProviderReady(provider, input.setupErrorMode);
    }
    const authContext = await resolveLlmProviderAuthContext(
      provider,
      input.runtime.authProfileId,
      this.options.resolveAuthProfile ?? this.options.getProviderProfile,
    );
    if (provider === 'codex') {
      await this.options.ensureGitAvailable?.();
    }
    const cliPath = input.cliPath ?? await this.getProviderCliPath(provider, input.setupErrorMode);
    const profileDirectory = authContext
      ? await this.materializeProviderProfileDirectory(provider, authContext.profile.id, authContext.runtimeAuthMode)
      : undefined;
    const profileCodexHome = provider === 'codex'
      ? authContext?.codexHome ?? profileDirectory
      : undefined;
    const profileClaudeConfigDir = provider === 'claude'
      ? authContext?.environment.CLAUDE_CONFIG_DIR ?? profileDirectory
      : undefined;
    const codexHomePlan = provider === 'codex'
      ? this.resolveCodexHomePlan(input.codexHomePlan, profileCodexHome, authContext?.rootCodexHome)
      : input.codexHomePlan;
    const codexHome = provider === 'codex'
      ? await this.materializeCodexHome(codexHomePlan)
      : null;
    const environment = {
      ...input.environment,
      ...(provider === 'codex'
        ? Object.fromEntries(Object.entries(authContext?.environment ?? {}).filter(([key]) => key !== 'CODEX_HOME'))
        : authContext?.environment ?? {}),
      ...(profileClaudeConfigDir ? { CLAUDE_CONFIG_DIR: profileClaudeConfigDir } : {}),
    };

    try {
      return await descriptor.run({
        ...input,
        cliPath,
        environment,
        model: input.runtime.model,
        effort: input.runtime.effort,
        permissionMode: input.runtime.permissionMode ?? input.permissionMode,
        codexHome: codexHome?.path,
        rootCodexHome: codexHome?.rootCodexHome ?? authContext?.rootCodexHome ?? this.options.codexHome,
      });
    } finally {
      await codexHome?.cleanup();
    }
  }

  private async assertProviderReady(
    provider: AgentProvider,
    mode: LlmProviderSetupErrorMode = 'code',
  ): Promise<void> {
    const authenticated = await this.getProviderAuthenticated(provider);
    if (!authenticated) {
      throw this.createSetupError(provider, 'auth', mode);
    }
  }

  private async getProviderAuthenticated(provider: AgentProvider): Promise<boolean> {
    if (provider === 'claude') {
      return Boolean(await this.options.getClaudeAuthenticated?.());
    }
    if (provider === 'antigravity') {
      return Boolean(await this.options.getAntigravityAuthenticated?.());
    }
    return Boolean(await this.options.getCodexAuthenticated?.());
  }

  private async getProviderCliPath(
    provider: AgentProvider,
    mode: LlmProviderSetupErrorMode = 'code',
  ): Promise<string> {
    const cliPath = provider === 'claude'
      ? await this.options.getClaudeCliPath?.()
      : provider === 'antigravity'
        ? await this.options.getAntigravityCliPath?.()
        : await this.options.getCodexCliPath?.();
    if (!cliPath) {
      throw this.createSetupError(provider, 'cli', mode);
    }
    return cliPath;
  }

  private async materializeCodexHome(
    plan: LlmProviderCodexHomePlan | undefined,
  ): Promise<{ path: string; rootCodexHome: string; cleanup: () => Promise<void> } | null> {
    if (!plan || plan.type === 'none') {
      return null;
    }
    if (plan.type === 'provided') {
      return {
        path: plan.path,
        rootCodexHome: plan.rootCodexHome ?? this.options.codexHome ?? plan.path,
        cleanup: async () => undefined,
      };
    }
    if (plan.type === 'persistent') {
      const path = await preparePersistentIsolatedCodexHome(
        plan.rootCodexHome,
        plan.targetCodexHome,
        {
          trustedRoots: plan.trustedRoots,
          networkAccess: plan.networkAccess,
        },
      );
      return {
        path,
        rootCodexHome: plan.rootCodexHome,
        cleanup: async () => undefined,
      };
    }
    const path = await createIsolatedCodexHome(plan.rootCodexHome, {
      prefix: plan.prefix,
      trustedRoots: plan.trustedRoots,
      networkAccess: plan.networkAccess,
    });
    return {
      path,
      rootCodexHome: plan.rootCodexHome,
      cleanup: async () => {
        await removeIsolatedCodexHome(path);
      },
    };
  }

  private resolveCodexHomePlan(
    plan: LlmProviderCodexHomePlan | undefined,
    profileCodexHome: string | undefined,
    profileRootCodexHome: string | undefined,
  ): LlmProviderCodexHomePlan | undefined {
    if (!profileCodexHome) {
      return plan;
    }
    const rootCodexHome = profileRootCodexHome ?? profileCodexHome;
    if (!plan || plan.type === 'none') {
      return { type: 'provided', path: profileCodexHome, rootCodexHome };
    }
    if (plan.type === 'provided') {
      return { ...plan, rootCodexHome };
    }
    if (plan.type === 'persistent') {
      return { ...plan, rootCodexHome };
    }
    return { ...plan, rootCodexHome };
  }

  private async materializeProviderProfileDirectory(
    provider: AgentProvider,
    profileId: string,
    runtimeAuthMode: 'materialized' | 'externalActiveOnly',
  ): Promise<string | undefined> {
    if (!this.options.providerProfilesRoot || runtimeAuthMode !== 'materialized') {
      return undefined;
    }
    const profileDir = path.join(this.options.providerProfilesRoot, provider, safeProfileDirectoryName(profileId));
    await fs.mkdir(profileDir, { recursive: true });
    return profileDir;
  }

  private createSetupError(
    provider: AgentProvider,
    kind: 'auth' | 'cli',
    mode: LlmProviderSetupErrorMode,
  ): Error {
    if (mode === 'chat') {
      const error = new Error(kind === 'auth' ? `${provider}_auth_missing` : `${provider}_cli_missing`);
      (error as Error & { chatCode?: ChatErrorCode }).chatCode = kind === 'auth'
        ? 'auth_missing'
        : 'capability_unavailable';
      return error;
    }
    return new Error(kind === 'auth' ? `${provider}_auth_missing` : `${provider}_cli_missing`);
  }
}

const safeProfileDirectoryName = (profileId: string): string =>
  profileId.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';

export const createLlmProviderRunService = (options: LlmProviderRunServiceOptions = {}): LlmProviderRunService =>
  new LlmProviderRunService(options);
