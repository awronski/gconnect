export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

export function expectArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  return value;
}

export function expectString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

export function expectNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

export function isIdentifier(value: unknown): value is string | number {
  return (typeof value === "string" && /^\d+$/.test(value))
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

export function expectIdentifier(value: unknown, name: string): string | number {
  if (!isIdentifier(value)) {
    throw new TypeError(`${name} must be a non-negative safe integer or decimal string`);
  }
  return value;
}

export function optionalString(value: unknown, name: string): string | null {
  return value === null || value === undefined ? null : expectString(value, name);
}

export function optionalNumber(value: unknown, name: string): number | null {
  return value === null || value === undefined ? null : expectNumber(value, name);
}
