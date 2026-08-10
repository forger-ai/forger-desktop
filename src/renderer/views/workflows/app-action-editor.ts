import type { WorkflowAppActionContract, WorkflowAppActionSummary } from '@shared/types';

export type PendingAppActionChange =
  | { kind: 'app'; appId: string }
  | { kind: 'action'; action: WorkflowAppActionSummary }
  | { kind: 'contract'; action: WorkflowAppActionSummary };

export interface AppActionContractChangeSummary {
  savedInputFields: string[];
  currentInputFields: string[];
  savedOutputFields: string[];
  currentOutputFields: string[];
  keptInputValues: string[];
  removedInputValues: string[];
}

export const appActionContractMatchesSummary = (
  contract: WorkflowAppActionContract,
  action: WorkflowAppActionSummary,
): boolean => contract.effect === action.effect
  && canonicalValue(contract.inputSchema) === canonicalValue(action.inputSchema)
  && canonicalValue(contract.outputSchema) === canonicalValue(action.outputSchema);

export const preserveCompatibleAppActionInput = (
  input: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> => {
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  if (inputSchema.additionalProperties !== false) return input;
  return Object.fromEntries(Object.entries(input)
    .filter(([key]) => key in properties)
    .map(([key, value]) => {
      const propertySchema = isRecord(properties[key]) ? properties[key] : {};
      return [key, isRecord(value)
        ? preserveCompatibleAppActionInput(value, propertySchema)
        : value];
    }));
};

export const summarizeAppActionContractChange = (
  contract: WorkflowAppActionContract | undefined,
  action: WorkflowAppActionSummary,
  input: Record<string, unknown>,
): AppActionContractChangeSummary => {
  const preserved = preserveCompatibleAppActionInput(input, action.inputSchema);
  const configuredPaths = configuredValuePaths(input);
  const preservedPaths = new Set(configuredValuePaths(preserved));
  return {
    savedInputFields: contract ? schemaFields(contract.inputSchema) : [],
    currentInputFields: schemaFields(action.inputSchema),
    savedOutputFields: contract ? schemaFields(contract.outputSchema) : [],
    currentOutputFields: schemaFields(action.outputSchema),
    keptInputValues: configuredPaths.filter((path) => preservedPaths.has(path)),
    removedInputValues: configuredPaths.filter((path) => !preservedPaths.has(path)),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const canonicalValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const schemaFields = (schema: Record<string, unknown>): string[] =>
  isRecord(schema.properties) ? Object.keys(schema.properties).sort() : [];

const configuredValuePaths = (value: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(entry) && Object.keys(entry).length > 0) {
      return configuredValuePaths(entry, path);
    }
    return [path];
  }).sort();
