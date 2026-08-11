export interface WorkflowStructuredValueLimits {
  maxDepth: number;
  maxKeys: number;
  maxArrayItems: number;
  maxBytes: number;
}

export const WORKFLOW_STRUCTURED_VALUE_LIMITS: Readonly<WorkflowStructuredValueLimits> = {
  maxDepth: 24,
  maxKeys: 5_000,
  maxArrayItems: 1_000,
  maxBytes: 1024 * 1024,
};

export const WORKFLOW_VALUE_RECEIPT_MAX_BYTES = 16 * 1024;
export const WORKFLOW_VALUE_RECEIPT_MAX_DEPTH = 8;
export const WORKFLOW_VALUE_RECEIPT_MAX_KEYS = 200;
export const WORKFLOW_VALUE_RECEIPT_MAX_ARRAY_ITEMS = 100;
export const WORKFLOW_VALUE_RECEIPT_MAX_STRING_LENGTH = 2_000;

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:token|password|secret|api[_-]?key|authorization|cookie)/i;
const REDACTED_VALUE = '[REDACTED]';
const TRUNCATED_VALUE = '[TRUNCATED]';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const serializedByteLength = (value: unknown): number | null => {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : null;
  } catch {
    return null;
  }
};

/** Rejects structures that are unsafe or too large to validate and persist. */
export const validateWorkflowStructuredValueLimits = (
  value: unknown,
  limits: WorkflowStructuredValueLimits = WORKFLOW_STRUCTURED_VALUE_LIMITS,
): string[] => {
  let keyCount = 0;
  let arrayItemCount = 0;
  let estimatedBytes = 0;
  const ancestors = new Set<object>();
  const addEstimatedBytes = (bytes: number): string | null => {
    estimatedBytes += bytes;
    return estimatedBytes > limits.maxBytes ? 'workflow_value_bytes_exceeded' : null;
  };
  const visit = (entry: unknown, depth: number): string | null => {
    if (depth > limits.maxDepth) return 'workflow_value_depth_exceeded';
    if (entry === null) return addEstimatedBytes(4);
    if (typeof entry === 'string') {
      return addEstimatedBytes(Buffer.byteLength(entry, 'utf8') + 2);
    }
    if (typeof entry === 'number') {
      return Number.isFinite(entry)
        ? addEstimatedBytes(String(entry).length)
        : 'workflow_value_not_serializable';
    }
    if (typeof entry === 'boolean') return addEstimatedBytes(entry ? 4 : 5);
    if (typeof entry !== 'object') return 'workflow_value_not_serializable';
    if (ancestors.has(entry)) return 'workflow_value_not_serializable';
    ancestors.add(entry);
    if (Array.isArray(entry)) {
      arrayItemCount += entry.length;
      if (entry.length > limits.maxArrayItems || arrayItemCount > limits.maxArrayItems) {
        ancestors.delete(entry);
        return 'workflow_value_array_items_exceeded';
      }
      const containerError = addEstimatedBytes(2 + entry.length);
      if (containerError) {
        ancestors.delete(entry);
        return containerError;
      }
      for (const item of entry) {
        const error = visit(item, depth + 1);
        if (error) {
          ancestors.delete(entry);
          return error;
        }
      }
      ancestors.delete(entry);
      return null;
    }
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) {
      ancestors.delete(entry);
      return 'workflow_value_not_serializable';
    }
    const containerError = addEstimatedBytes(2);
    if (containerError) {
      ancestors.delete(entry);
      return containerError;
    }
    for (const [key, nested] of Object.entries(entry)) {
      // JSON.stringify omits undefined object properties. Treat them as
      // absent here too, while still rejecting undefined inside arrays.
      if (nested === undefined) continue;
      keyCount += 1;
      if (UNSAFE_OBJECT_KEYS.has(key)) {
        ancestors.delete(entry);
        return 'workflow_value_unsafe_key';
      }
      if (keyCount > limits.maxKeys) {
        ancestors.delete(entry);
        return 'workflow_value_keys_exceeded';
      }
      const keyError = addEstimatedBytes(Buffer.byteLength(key, 'utf8') + 3);
      if (keyError) {
        ancestors.delete(entry);
        return keyError;
      }
      const error = visit(nested, depth + 1);
      if (error) {
        ancestors.delete(entry);
        return error;
      }
    }
    ancestors.delete(entry);
    return null;
  };
  const structuralError = visit(value, 0);
  if (structuralError) return [structuralError];
  const bytes = serializedByteLength(value);
  if (bytes === null) return ['workflow_value_not_serializable'];
  return bytes > limits.maxBytes ? ['workflow_value_bytes_exceeded'] : [];
};

const enumValueEquals = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if ((!isRecord(left) && !Array.isArray(left)) || (!isRecord(right) && !Array.isArray(right))) {
    return false;
  }
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (!isRecord(entry)) return entry;
    return Object.fromEntries(
      Object.entries(entry)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
};

const validateSchemaValue = (
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  _depth: number,
): string[] => {
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => enumValueEquals(candidate, value))) {
    return [`${path} no coincide con un valor permitido`];
  }
  const expectedType = typeof schema.type === 'string' ? schema.type : undefined;
  if (expectedType === 'object') {
    if (!isRecord(value)) return [`${path} debe ser un objeto`];
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    const errors: string[] = [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
        errors.push(`${path}.${key} es requerido`);
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (
        !Object.prototype.hasOwnProperty.call(value, key)
        || value[key] === undefined
        || !isRecord(propertySchema)
      ) {
        continue;
      }
      errors.push(...validateSchemaValue(value[key], propertySchema, `${path}.${key}`, _depth + 1));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${path}.${key} no esta permitido`);
        }
      }
    }
    return errors;
  }
  if (expectedType === 'array') {
    if (!Array.isArray(value)) return [`${path} debe ser una lista`];
    const errors: string[] = [];
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path} contiene menos elementos de los permitidos`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path} contiene mas elementos de los permitidos`);
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) => {
        errors.push(...validateSchemaValue(item, schema.items as Record<string, unknown>, `${path}[${index}]`, _depth + 1));
      });
    }
    return errors;
  }
  if (expectedType === 'null') {
    return value === null ? [] : [`${path} debe ser nulo`];
  }
  if (expectedType === 'integer') {
    return typeof value === 'number' && Number.isInteger(value)
      ? []
      : [`${path} debe ser un entero`];
  }
  if (expectedType === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? []
      : [`${path} debe ser un numero`];
  }
  if (expectedType === 'string') {
    if (typeof value !== 'string') return [`${path} debe ser texto`];
    const errors: string[] = [];
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path} es mas corto de lo permitido`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path} es mas largo de lo permitido`);
    }
    return errors;
  }
  if (expectedType === 'boolean' && typeof value !== 'boolean') {
    return [`${path} debe ser booleano`];
  }
  return [];
};

/** Validates the bounded JSON-Schema subset accepted by workflow contracts. */
export const validateOutputAgainstSchema = (
  value: unknown,
  schema: Record<string, unknown>,
  path = 'output',
): string[] => {
  const limitErrors = validateWorkflowStructuredValueLimits(value);
  if (limitErrors.length > 0) return limitErrors;
  const schemaErrors = validateWorkflowStructuredValueLimits(schema);
  if (schemaErrors.length > 0) return ['workflow_output_schema_unsafe'];
  return validateSchemaValue(value, schema, path, 0);
};

const redactReceiptValue = (
  value: unknown,
  depth: number,
  budget: { keys: number },
): unknown => {
  if (depth > WORKFLOW_VALUE_RECEIPT_MAX_DEPTH) return TRUNCATED_VALUE;
  if (typeof value === 'string') {
    return value.length > WORKFLOW_VALUE_RECEIPT_MAX_STRING_LENGTH
      ? `${value.slice(0, WORKFLOW_VALUE_RECEIPT_MAX_STRING_LENGTH)}${TRUNCATED_VALUE}`
      : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const entries = value
      .slice(0, WORKFLOW_VALUE_RECEIPT_MAX_ARRAY_ITEMS)
      .map((entry) => redactReceiptValue(entry, depth + 1, budget));
    if (value.length > entries.length) entries.push(TRUNCATED_VALUE);
    return entries;
  }
  if (!isRecord(value)) return String(value);
  const receipt: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (budget.keys >= WORKFLOW_VALUE_RECEIPT_MAX_KEYS) {
      receipt._truncated = true;
      break;
    }
    budget.keys += 1;
    receipt[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED_VALUE
      : redactReceiptValue(nested, depth + 1, budget);
  }
  return receipt;
};

/** Produces a bounded, secret-redacted value suitable for persisted run history. */
export const createWorkflowValueReceipt = (value: Record<string, unknown>): Record<string, unknown> => {
  const redacted = redactReceiptValue(value, 0, { keys: 0 }) as Record<string, unknown>;
  const bytes = serializedByteLength(redacted) as number;
  if (bytes <= WORKFLOW_VALUE_RECEIPT_MAX_BYTES) return redacted;
  const serialized = JSON.stringify(redacted) as string;
  let previewLength = Math.min(serialized.length, WORKFLOW_VALUE_RECEIPT_MAX_BYTES / 2);
  let receipt: Record<string, unknown> = { _truncated: true, preview: serialized.slice(0, previewLength) };
  while ((serializedByteLength(receipt) as number) > WORKFLOW_VALUE_RECEIPT_MAX_BYTES) {
    previewLength = Math.floor(previewLength * 0.8);
    receipt = { _truncated: true, preview: serialized.slice(0, previewLength) };
  }
  return receipt;
};
