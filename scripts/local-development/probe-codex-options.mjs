import path from 'node:path';
import { createHash } from 'node:crypto';

const agentProfiles = ['baseline-v1', 'single-agent-v1', 'single-agent-no-thinking-v1', 'compact-v1'];
export function resolveAgentProfile(value) {
  if (value === undefined) return 'baseline-v1';
  if (!agentProfiles.includes(value)) throw new Error('invalid_agent_profile');
  return value;
}

export function parseProbeOptions(args) {
  const [cliPath, ...flags] = args;
  const usage = `Usage: node scripts/local-development/probe-codex-cli.mjs /absolute/path/to/codex [--agent-profile ${agentProfiles.join('|')}] [--network-sandbox] [--redirect-check[=301|302|303|307|308]]`;
  if (!cliPath || !path.isAbsolute(cliPath)) throw new Error(usage);
  const options = { cliPath, networkSandbox: false, redirectCheck: false, redirectStatus: 307, agentProfile: 'baseline-v1' };
  let profileProvided = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const redirect = flag.match(/^--redirect-check(?:=(301|302|303|307|308))?$/);
    if ((flag === '--agent-profile' || flag.startsWith('--agent-profile=')) && !profileProvided) {
      const value = flag === '--agent-profile' ? flags[++index] : flag.slice('--agent-profile='.length);
      if (!agentProfiles.includes(value)) throw new Error(usage);
      options.agentProfile = value;
      profileProvided = true;
    } else if (flag === '--network-sandbox' && !options.networkSandbox) options.networkSandbox = true;
    else if (redirect && !options.redirectCheck) {
      options.redirectCheck = true;
      options.redirectStatus = Number(redirect[1] ?? 307);
    } else throw new Error(usage);
  }
  return options;
}

/** Record observations only; request context, schemas and instruction text stay out of reports. */
export function inspectProbeRequestProfile(body, { agentProfile, compactContract } = {}) {
  const profile = resolveAgentProfile(agentProfile);
  const pending = Array.isArray(body.tools) ? [...body.tools] : [];
  let multiAgentNamespacePresent = false;
  while (pending.length) {
    const tool = pending.pop();
    if (typeof tool?.name === 'string' && /(?:^|[.:/])multi_agent(?:_v\d+)?(?:$|[.:/])/.test(tool.name)) multiAgentNamespacePresent = true;
    if (tool?.type === 'namespace') {
      if (Array.isArray(tool.tools)) pending.push(...tool.tools);
    }
  }
  const instructionText = [typeof body.instructions === 'string' ? body.instructions : '',
    ...(Array.isArray(body.input) ? body.input : []).filter((item) => ['system', 'developer'].includes(item?.role)).flatMap((item) =>
      typeof item.content === 'string' ? [item.content] : (Array.isArray(item.content) ? item.content : []).map((part) => typeof part.text === 'string' ? part.text : '')),
  ];
  const compactContractPresent = typeof compactContract === 'string' && compactContract.trim().length > 0
    && instructionText.some((text) => text.includes(compactContract.trim()));
  const reasoningEffort = typeof body.reasoning?.effort === 'string' ? body.reasoning.effort : null;
  const checks = [
    { name: 'single_agent_tools', passed: profile === 'baseline-v1' || !multiAgentNamespacePresent },
    { name: 'explicit_no_thinking', passed: !['single-agent-no-thinking-v1', 'compact-v1'].includes(profile) || reasoningEffort === 'none' },
    { name: 'compact_forger_contract', passed: profile !== 'compact-v1' || compactContractPresent },
  ];
  return { agentProfile: profile, multiAgentNamespacePresent, reasoningEffort, compactContractPresent,
    compactContractSha256: compactContractPresent ? createHash('sha256').update(compactContract).digest('hex') : null,
    checks, passed: checks.every((check) => check.passed) };
}

/** Inspect only permission options, never model instructions paths, tokens or arbitrary CLI arguments. */
export function inspectProbeInvocationPolicy(args, { agentProfile } = {}) {
  const profile = resolveAgentProfile(agentProfile);
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  const values = (flag) => options.flatMap((value, index) => value === flag ? [options[index + 1]] : []);
  const configurations = values('--config');
  const settings = (key) => configurations.filter((value) => typeof value === 'string' && value.startsWith(`${key}=`)).map((value) => value.slice(key.length + 1));
  const exactly = (observed, expected) => observed.length === 1 && observed[0] === expected;
  const checks = [
    { name: 'workspace_sandbox', passed: exactly(values('--sandbox'), 'workspace-write') },
    { name: 'no_interactive_approval', passed: exactly(values('--ask-for-approval'), 'never') },
    { name: 'network_access_disabled', passed: exactly(settings('sandbox_workspace_write.network_access'), 'false') },
    { name: 'web_search_disabled', passed: exactly(settings('web_search'), '"disabled"') },
    { name: 'user_config_ignored', passed: options.filter((value) => value === '--ignore-user-config').length === 1 },
    { name: 'no_sandbox_bypass', passed: !options.some((value) => ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto'].includes(value)) },
    { name: 'compact_permissions_included', passed: profile !== 'compact-v1' || exactly(settings('include_permissions_instructions'), 'true') },
  ];
  return { agentProfile: profile, checks, passed: checks.every((check) => check.passed), evidence: 'Observed CLI invocation options; permission instructions in the serialized model request are not verified by this check.' };
}
