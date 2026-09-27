import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  codexCliAdapter,
  parseCodexJsonl,
} from '../llm-provider/adapters/codex-cli-adapter';
import { buildRepositoryEnvironment, runRepositoryProcess } from './process';
import type { RepositoryExecutor } from './types';
import { CODEX_CLI_VERSION } from '../core/agent-runtime-defaults';
import type { CodexReasoningEffort } from '../../shared/types';

const PROFILE = 'forger-repositories';
const quote = JSON.stringify;
const inside = (target: string, root: string) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export async function validateRepositoryRoots(
  roots: string[],
): Promise<string[]> {
  if (!roots.length || roots.length > 10)
    throw new Error('repository_execution_roots_invalid');
  const canonical: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root))
      throw new Error('repository_execution_roots_invalid');
    const actual = await fs.realpath(root);
    // macOS /var is a system alias; registered repository paths otherwise must be canonical.
    const resolved = path.resolve(root).replace(/^\/var\//, '/private/var/');
    if (actual !== resolved)
      throw new Error('repository_execution_symlink_root');
    if (
      actual === path.parse(actual).root ||
      actual === (await fs.realpath(os.homedir())) ||
      !(await fs.stat(actual)).isDirectory()
    )
      throw new Error('repository_execution_roots_invalid');
    const git = await fs.lstat(path.join(actual, '.git')).catch(() => null);
    if (!git?.isDirectory() || git.isSymbolicLink())
      throw new Error('repository_execution_git_metadata_external');
    canonical.push(actual);
  }
  return [...new Set(canonical)].sort();
}

function permissionEntries(
  roots: string[],
  tempRoot: string,
  codexHome: string,
  runtimeRoots: string[] = [],
) {
  const entries: Record<string, string> = {
    ':root': 'deny',
    ':minimal': 'read',
    ':tmpdir': 'deny',
    ':slash_tmp': 'deny',
  };
  for (const root of runtimeRoots) entries[root] = 'read';
  for (const root of roots) {
    entries[root] = 'write';
    entries[path.join(root, '.git')] = 'read';
    entries[path.join(root, '.codex')] = 'deny';
  }
  entries[tempRoot] = 'write';
  entries[codexHome] = 'deny';
  return entries;
}
export function buildRepositoryPermissionsConfig(
  roots: string[],
  tempRoot: string,
  codexHome: string,
  runtimeRoots: string[] = [],
): string {
  return [
    `default_permissions = ${quote(PROFILE)}`,
    'approval_policy = "never"',
    `[permissions.${PROFILE}.filesystem]`,
    ...Object.entries(
      permissionEntries(roots, tempRoot, codexHome, runtimeRoots),
    ).map(([key, value]) => `${quote(key)} = ${quote(value)}`),
    `[permissions.${PROFILE}.network]`,
    'enabled = false',
    '',
  ].join('\n');
}

export function repositoryPolicyArgs(
  roots: string[],
  tempRoot: string,
  codexHome: string,
  runtimeRoots: string[] = [],
): string[] {
  const filesystem = Object.entries(
    permissionEntries(roots, tempRoot, codexHome, runtimeRoots),
  )
    .map(([k, v]) => `${quote(k)}=${quote(v)}`)
    .join(',');
  return [
    '--config',
    `default_permissions=${quote(PROFILE)}`,
    '--config',
    `permissions={${quote(PROFILE)}={filesystem={${filesystem}},network={enabled=false}}}`,
    '--config',
    'approval_policy="never"',
    '--config',
    'mcp_servers={}',
    '--config',
    'web_search="disabled"',
    ...[
      'hooks',
      'plugins',
      'remote_plugin',
      'apps',
      'multi_agent',
      'in_app_browser',
      'shell_snapshot',
    ].flatMap((feature) => ['--disable', feature]),
    '--config',
    'shell_environment_policy.inherit="none"',
  ];
}

interface ExecutorOptions {
  root: string;
  sourceCodexHome: () => string;
  resolveRuntime: () => Promise<{
    cliPath: string;
    pathEntries: string[];
    model: string;
    effort: CodexReasoningEffort;
    authenticated: boolean;
  }>;
  runProcess?: typeof runRepositoryProcess;
  platform?: NodeJS.Platform;
}

interface Session {
  directory: string;
  scope: string;
  conversationId: string;
}
export class RepositoryCodexExecutor implements RepositoryExecutor {
  constructor(private readonly options: ExecutorOptions) {}
  async run(
    input: Parameters<RepositoryExecutor['run']>[0],
  ): ReturnType<RepositoryExecutor['run']> {
    if ((this.options.platform ?? process.platform) !== 'darwin')
      throw new Error('repository_execution_platform_unsupported');
    if (input.signal.aborted) throw new Error('repository_execution_cancelled');
    const roots = await validateRepositoryRoots(
      input.repositories.map((repository) => repository.root),
    );
    const runtime = await this.options.resolveRuntime();
    if (!runtime.authenticated)
      throw new Error('repository_execution_auth_required');
    if (!runtime.cliPath)
      throw new Error('repository_execution_runtime_missing');
    const source = await fs.realpath(this.options.sourceCodexHome());
    const authSource = path.join(source, 'auth.json');
    const auth = await fs.lstat(authSource).catch(() => null);
    if (!auth?.isFile() || auth.isSymbolicLink())
      throw new Error('repository_execution_auth_required');
    const authBytes = await fs.readFile(authSource);
    const accountIdentity = authIdentity(authBytes);

    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const runtimeRoot = await fs.realpath(this.options.root);
    for (const root of roots)
      if (
        inside(runtimeRoot, root) ||
        inside(source, root) ||
        inside(root, runtimeRoot) ||
        inside(root, source)
      )
        throw new Error('repository_execution_roots_invalid');
    await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const scope = createHash('sha256')
      .update(
        JSON.stringify([input.task.groupId, roots, source, accountIdentity]),
      )
      .digest('hex');
    const sessions = path.join(runtimeRoot, 'sessions');
    await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
    const sessionFile = (id: string) =>
      path.join(
        sessions,
        `${createHash('sha256').update(id).digest('hex')}.json`,
      );
    let directory: string;
    if (input.conversationId) {
      const previous = JSON.parse(
        await fs
          .readFile(sessionFile(input.conversationId), 'utf8')
          .catch(() => {
            throw new Error('repository_execution_conversation_invalid');
          }),
      ) as Session;
      if (
        previous.scope !== scope ||
        previous.conversationId !== input.conversationId ||
        !inside(previous.directory, runtimeRoot)
      )
        throw new Error('repository_execution_conversation_invalid');
      directory = previous.directory;
    } else directory = await fs.mkdtemp(path.join(runtimeRoot, 'task-'));
    const tempRoot = path.join(directory, 'work');
    const home = path.join(tempRoot, 'home');
    const codexHome = path.join(directory, 'codex');
    for (const dir of [home, codexHome, tempRoot]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      if ((await fs.realpath(dir)) !== dir)
        throw new Error('repository_execution_symlink_root');
    }
    const authTarget = path.join(codexHome, 'auth.json');
    const copied = await fs.lstat(authTarget).catch(() => null);
    if (copied?.isSymbolicLink())
      throw new Error('repository_execution_symlink_root');
    if (!copied || auth.mtimeMs > copied.mtimeMs)
      await fs.writeFile(authTarget, authBytes, { mode: 0o600 });
    const command = await codexCliAdapter.resolveCommand(
      runtime.cliPath,
      runtime.pathEntries,
    );
    const runtimeRoots = await Promise.all(
      command.pathEntries.map((entry) => fs.realpath(entry)),
    );
    const env = buildRepositoryEnvironment({
      home,
      codexHome,
      tempRoot,
      pathEntries: runtimeRoots,
    });
    const run = this.options.runProcess ?? runRepositoryProcess;
    const version = await run(
      command.command,
      [...command.prefixArgs, '--version'],
      { cwd: tempRoot, env, signal: input.signal, timeoutMs: 10_000 },
    );
    // The permission profile is verified against the pinned managed runtime; never silently weaken it for another version.
    if (
      version.code !== 0 ||
      version.stdout.trim() !== `codex-cli ${CODEX_CLI_VERSION}`
    )
      throw new Error('repository_execution_runtime_unsupported');
    const args = [
      ...command.prefixArgs,
      '--strict-config',
      ...repositoryPolicyArgs(roots, tempRoot, codexHome, runtimeRoots),
      '--config',
      `shell_environment_policy.set={${Object.entries(env)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => `${quote(k)}=${quote(v)}`)
        .join(',')}}`,
      'exec',
      ...(input.conversationId ? ['resume'] : []),
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      '--model',
      runtime.model,
      '--config',
      `model_reasoning_effort=${quote(runtime.effort)}`,
      '--skip-git-repo-check',
      '--',
      ...(input.conversationId ? [input.conversationId] : []),
      '-',
    ];
    const map = input.repositories
      .map((repository) => `${repository.name}: ${repository.root}`)
      .join('\n');
    const prompt = `Work only within these explicitly shared repositories. Read their AGENTS.md instructions. Preserve existing changes. Do not publish, push, deploy, contact others, or access other data. Network access for commands is disabled. Finish with a concise functional summary, verification, and remaining limitations.\n${map}\n\n${input.prompt}`;
    input.onProgress?.('Trabajando en los repositorios autorizados.');
    const result = await run(command.command, args, {
      cwd: tempRoot,
      env,
      signal: input.signal,
      stdinText: prompt,
      timeoutMs: 30 * 60_000,
      inactivityTimeoutMs: 5 * 60_000,
    });
    if (result.code !== 0) throw new Error('repository_execution_failed');
    const parsed = parseCodexJsonl(result.stdout, result.stderr);
    const conversationId = parsed.threadId ?? input.conversationId;
    if (!conversationId || !parsed.assistantText)
      throw new Error('repository_execution_result_missing');
    await fs.writeFile(
      sessionFile(conversationId),
      JSON.stringify({ directory, scope, conversationId }),
      { mode: 0o600 },
    );
    return { text: parsed.assistantText, conversationId };
  }
}

function authIdentity(bytes: Buffer): string {
  let identity: string | undefined;
  try {
    const value = JSON.parse(bytes.toString('utf8')) as {
      tokens?: { account_id?: unknown };
    };
    if (typeof value.tokens?.account_id === 'string')
      identity = value.tokens.account_id;
  } catch {
    /* An opaque credential format is bound to its digest instead. */
  }
  return createHash('sha256')
    .update(identity ?? bytes)
    .digest('hex');
}
