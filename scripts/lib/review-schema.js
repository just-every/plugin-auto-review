"use strict";

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          description: { type: "string" },
          recommendation: { type: "string" }
        },
        required: ["title", "severity", "file", "line", "description", "recommendation"]
      }
    },
    overall_correctness: { type: "string", enum: ["correct", "incorrect"] },
    overall_explanation: { type: "string" },
    overall_confidence: { type: "string", enum: ["high", "medium", "low"] }
  },
  required: ["findings", "overall_correctness", "overall_explanation", "overall_confidence"]
};

function validateReviewResult(value, options = {}) {
  const errors = [];
  validateObject(value, REVIEW_SCHEMA, "", errors);
  if (errors.length === 0) {
    validateReviewSemantics(value, options, errors);
  }
  return { ok: errors.length === 0, errors };
}

function validateReviewSemantics(value, options, errors) {
  if (value.overall_correctness === "incorrect" && value.findings.length === 0) {
    errors.push("overall_correctness=incorrect requires at least one finding");
  }
  const changedPaths = options.changedPaths ? new Set(options.changedPaths) : null;
  value.findings.forEach((finding, index) => {
    if (finding.line !== null && finding.line < 1) {
      errors.push(`findings[${index}].line must be null or a positive integer`);
    }
    if (changedPaths && !changedPaths.has(finding.file)) {
      errors.push(`findings[${index}].file must be one of the changed paths`);
    }
  });
}

function validateObject(value, schema, path, errors) {
  if (schema.type === "object" && !isPlainObject(value)) {
    errors.push(`${path || "value"} must be an object`);
    return;
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!schema.properties || !Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        errors.push(`${joinPath(path, key)} is not allowed`);
      }
    }
  }
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${joinPath(path, key)} is required`);
    }
  }
  for (const [key, childSchema] of Object.entries(schema.properties || {})) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    validateValue(value[key], childSchema, joinPath(path, key), errors);
  }
}

function validateValue(value, schema, path, errors) {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
    return;
  }
  if (allowedTypes.includes("array")) {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return;
    }
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, errors));
    return;
  }
  if (allowedTypes.includes("object")) {
    validateObject(value, schema, path, errors);
    return;
  }
  if (!allowedTypes.some((type) => matchesType(value, type))) {
    errors.push(`${path} must be ${allowedTypes.join(" or ")}`);
  }
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function joinPath(base, key) {
  return base ? `${base}.${key}` : key;
}

module.exports = {
  REVIEW_SCHEMA,
  validateReviewResult
};
