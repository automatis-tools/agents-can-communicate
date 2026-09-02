class InputValidationError extends Error {}

const fail = (path, message) => {
  throw new InputValidationError(`${path} ${message}`);
};

const isObject = value => value !== null && typeof value === "object"
  && !Array.isArray(value);

function matches(schema, value, path) {
  try {
    validateSchema(schema, value, path);
    return true;
  } catch (error) {
    if (!(error instanceof InputValidationError)) throw error;
    return false;
  }
}

function validateSchema(schema, value, path) {
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    fail(path, `must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some(item => Object.is(item, value))) {
    fail(path, `must be one of ${schema.enum.map(item => JSON.stringify(item)).join(", ")}`);
  }

  const objectKeywords = schema.type === "object" || schema.properties !== undefined
    || schema.required !== undefined || schema.additionalProperties !== undefined;
  if (objectKeywords) {
    if (!isObject(value)) fail(path, "must be an object");
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) fail(`${path}.${key}`, "is not a known field");
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchema(child, value[key], `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) fail(path, "must be an array");
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`));
    }
  } else if (schema.type === "string" && typeof value !== "string") {
    fail(path, "must be a string");
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    fail(path, "must be a boolean");
  } else if (schema.type === "integer" && !Number.isInteger(value)) {
    fail(path, "must be an integer");
  }

  if (schema.minimum !== undefined && value < schema.minimum) {
    fail(path, `must be at least ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    fail(path, `must be at most ${schema.maximum}`);
  }
  if (schema.anyOf !== undefined
    && !schema.anyOf.some(branch => matches(branch, value, path))) {
    fail(path, "must match an accepted shape");
  }
  if (schema.oneOf !== undefined
    && schema.oneOf.filter(branch => matches(branch, value, path)).length !== 1) {
    fail(path, "must match exactly one accepted shape");
  }
  if (schema.not !== undefined && matches(schema.not, value, path)) {
    fail(path, "contains fields that cannot be combined");
  }
  return value;
}

export function validateToolInput(schema, value) {
  return validateSchema(schema, value, "arguments");
}
