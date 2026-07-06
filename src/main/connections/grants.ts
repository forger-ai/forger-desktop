import type {
  AppConnectionDeclaration,
  PersistedConnectionGrant,
} from '../../shared/types/connections';
import type { AppToolDeclaration } from '../../shared/types';
import { isBuiltInConnectionType } from '../../shared/connection-catalog';

const ALL_ACTIONS_TOKEN = '*';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizeActions = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const actions: string[] = [];
  for (const item of value) {
    const action = cleanString(item);
    if (!action || seen.has(action)) {
      continue;
    }
    seen.add(action);
    actions.push(action);
  }
  return actions;
};

const normalizeBucket = (value: unknown): AppConnectionDeclaration[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const merged = new Map<string, AppConnectionDeclaration>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const type = cleanString(item.type);
    const reason = cleanString(item.reason);
    const actions = normalizeActions(item.actions);
    if (!type || !reason || actions.length === 0) {
      continue;
    }
    const multiple = item.multiple === true;
    const existing = merged.get(type);
    if (existing) {
      const nextActions = Array.from(new Set([...existing.actions, ...actions]));
      merged.set(type, {
        ...existing,
        actions: nextActions,
        multiple: existing.multiple || multiple,
      });
      continue;
    }
    merged.set(type, { type, reason, actions, multiple });
  }
  return [...merged.values()];
};

const legacyToolToConnectionDeclaration = (declaration: AppToolDeclaration): AppConnectionDeclaration | null => {
  const type = declaration.toolId.trim();
  if (!isBuiltInConnectionType(type)) {
    return null;
  }
  return {
    type,
    reason: declaration.reason,
    actions: [...declaration.actions],
    multiple: false,
    legacyToolId: declaration.toolId,
  };
};

const appendLegacyDeclarations = (
  target: AppConnectionDeclaration[],
  legacy: AppToolDeclaration[] | undefined,
): AppConnectionDeclaration[] => {
  if (!legacy?.length) {
    return target;
  }
  const byType = new Map(target.map((item) => [item.type, item]));
  for (const declaration of legacy) {
    const connection = legacyToolToConnectionDeclaration(declaration);
    if (!connection || byType.has(connection.type)) {
      continue;
    }
    byType.set(connection.type, connection);
  }
  return [...byType.values()];
};

export const normalizeAppConnectionDeclarations = (
  value: unknown,
  legacyTools?: { required?: AppToolDeclaration[]; optional?: AppToolDeclaration[] },
): { required: AppConnectionDeclaration[]; optional: AppConnectionDeclaration[] } => {
  const record = isRecord(value) ? value : {};
  return {
    required: appendLegacyDeclarations(normalizeBucket(record.required), legacyTools?.required),
    optional: appendLegacyDeclarations(normalizeBucket(record.optional), legacyTools?.optional),
  };
};

const hashActions = (type: string, actions: string[]): string =>
  `${type}:${actions.join('|')}`;

export const resolveConnectionActionSnapshot = (
  declaration: AppConnectionDeclaration,
  actionCatalog: Record<string, string[]>,
  options: { granted?: boolean; approvedAt?: string; connectionIds?: string[] } = {},
): PersistedConnectionGrant => {
  const catalogActions = actionCatalog[declaration.type] ?? [];
  const requestedWildcard = declaration.actions.includes(ALL_ACTIONS_TOKEN);
  const resolvedActions = requestedWildcard
    ? catalogActions
    : declaration.actions.filter((action) => catalogActions.includes(action));
  const granted = options.granted ?? true;
  return {
    type: declaration.type,
    reason: declaration.reason,
    requestedActions: [...declaration.actions],
    resolvedActions: [...new Set(resolvedActions)],
    multiple: declaration.multiple,
    granted,
    ...(granted ? { approvedAt: options.approvedAt ?? new Date().toISOString() } : {}),
    actionCatalogHash: hashActions(declaration.type, catalogActions),
    ...(options.connectionIds ? { connectionIds: [...options.connectionIds] } : {}),
  };
};

export const connectionGrantAllowsAction = (
  grant: PersistedConnectionGrant,
  actionId: string,
  _actionCatalog?: Record<string, string[]>,
): boolean =>
  grant.granted === true && grant.resolvedActions.includes(actionId);

export const isLegacyExternalToolId = (toolId: string): boolean =>
  isBuiltInConnectionType(toolId);
