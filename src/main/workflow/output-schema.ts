/**
 * Minimal JSON-schema-like validation for workflow node outputs.
 * Supports: type (object, array, string, number, boolean), properties,
 * required and items. Unknown keywords are ignored on purpose so agents
 * can declare richer schemas without breaking validation.
 */
export const validateOutputAgainstSchema = (
  value: unknown,
  schema: Record<string, unknown>,
  path = 'output',
): string[] => {
  const errors: string[] = [];
  const expectedType = typeof schema.type === 'string' ? schema.type : undefined;

  if (expectedType === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path} debe ser un objeto`];
    }
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    for (const key of required) {
      if (record[key] === undefined) {
        errors.push(`${path}.${key} es requerido`);
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (record[key] === undefined || !propertySchema || typeof propertySchema !== 'object') {
        continue;
      }
      errors.push(...validateOutputAgainstSchema(record[key], propertySchema as Record<string, unknown>, `${path}.${key}`));
    }
    return errors;
  }

  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      return [`${path} debe ser una lista`];
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((item, index) => {
        errors.push(...validateOutputAgainstSchema(item, schema.items as Record<string, unknown>, `${path}[${index}]`));
      });
    }
    return errors;
  }

  if (expectedType === 'string' && typeof value !== 'string') {
    return [`${path} debe ser texto`];
  }
  if (expectedType === 'number' && typeof value !== 'number') {
    return [`${path} debe ser un numero`];
  }
  if (expectedType === 'boolean' && typeof value !== 'boolean') {
    return [`${path} debe ser booleano`];
  }
  return errors;
};
