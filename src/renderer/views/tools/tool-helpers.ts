import type {
  AgentToolApprovalSettings,
  AgentToolDefinition,
  AgentToolPackageDefinition,
} from '@shared/types';
import type { ChipProps } from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';

export const riskColor = (risk: AgentToolDefinition['risk']): ChipProps['color'] => {
  if (risk === 'alto') return 'error';
  if (risk === 'medio') return 'warning';
  return 'success';
};

export const requiresApproval = (
  approvals: Partial<AgentToolApprovalSettings>,
  tool: AgentToolDefinition,
): boolean => approvals[tool.id] ?? tool.defaultRequiresApproval;

export const localizedPackageCopy = (
  t: AppDictionary,
  toolPackage: AgentToolPackageDefinition,
): { name: string; description: string } => {
  const packages = t.sections.tools.packages as Record<string, { name: string; description: string }>;
  return packages[toolPackage.id] ?? {
    name: toolPackage.name,
    description: toolPackage.description,
  };
};

export const localizedToolCopy = (
  t: AppDictionary,
  tool: AgentToolDefinition,
): { name: string; description: string } => {
  const definitions = t.sections.tools.definitions as Partial<Record<AgentToolDefinition['id'], { name: string; description: string }>>;
  return definitions[tool.id] ?? {
    name: tool.name,
    description: tool.description,
  };
};
