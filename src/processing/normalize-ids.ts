import { ProtocolChangedError } from "../core/errors.js";
import { isIdentifier } from "../core/json.js";

const IDENTIFIER_KEYS = new Set([
  "activityId",
  "deviceId",
  "userId",
  "userProfilePK",
  "userProfilePk",
  "userProfileId"
]);

export function normalizeKnownIds(value: unknown, path = "data"): unknown {
  if (Array.isArray(value)) return value.map((item, index) => normalizeKnownIds(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (IDENTIFIER_KEYS.has(key) && item !== null && item !== undefined) {
      output[key] = normalizeIdentifier(item, `${path}.${key}`);
    } else {
      output[key] = normalizeKnownIds(item, `${path}.${key}`);
    }
  }
  return output;
}

function normalizeIdentifier(value: unknown, path: string): string {
  if (isIdentifier(value)) return String(value);
  throw new ProtocolChangedError({ issue: "invalid identifier", path });
}
