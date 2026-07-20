import { defineCommand, optionalStringOption, requiredString } from "../../cli/command-contract.js";
import { CliError } from "../../core/errors.js";
import { result } from "../../core/result.js";
import type { FeatureModule } from "../feature.js";
import type { QueryValue } from "../context.js";
import { AUTH_RECOVERY_OPTIONS, AUTH_RECOVERY_RULES } from "../auth-recovery-options.js";

type ApiPath = `/gc-api/${string}`;

const FORBIDDEN_QUERY_NAMES = new Set([
  "access_token",
  "authorization",
  "connect-csrf-token",
  "cookie",
  "csrf",
  "csrf-token",
  "host",
  "origin",
  "password",
  "refresh_token",
  "secret",
  "service_ticket",
  "set-cookie",
  "ticket",
  "token"
]);

interface ApiGetOptions {
  readonly path: ApiPath;
  readonly query: Readonly<Record<string, QueryValue>>;
}

export const apiFeature: FeatureModule = {
  id: "api",
  commands: [
    defineCommand({
      contract: {
        id: "api.get",
        path: ["api", "get"],
        summary: "Run a read-only GET against an approved Garmin gc-api path.",
        positionals: [{ name: "path", description: "Absolute path beginning with /gc-api/." }],
        options: {
          query: {
            type: "string",
            description: "URL-encoded query string, for example date=2026-07-17&limit=20."
          },
          ...AUTH_RECOVERY_OPTIONS
        },
        rules: AUTH_RECOVERY_RULES,
        examples: [
          "gconnect api get /gc-api/userprofile-service/userprofile/user-settings/",
          "gconnect api get /gc-api/wellness-service/wellness/dailyHeartRate --query date=2026-07-17"
        ],
        output: { dataset: "api.raw", shape: "document" },
        limitations: ["GET only", "The origin and authentication headers cannot be overridden"]
      },
      parse: (input): ApiGetOptions => ({
        path: parseApiPath(requiredString(input, "path")),
        query: parseQuery(optionalStringOption(input, "query"))
      }),
      execute: async (context, options) => {
        const payload = await context.download.json({
          path: options.path,
          query: options.query,
          decode: (input) => input
        });
        return result({
          command: "api.get",
          dataset: "api.raw",
          generatedAt: context.clock.now().toISOString(),
          sourceEndpoints: [options.path],
          appliedOptions: { path: options.path, query: options.query },
          raw: true,
          data: payload
        });
      }
    })
  ]
};

function parseApiPath(value: string): ApiPath {
  let canonical: URL;
  try {
    canonical = new URL(value, "https://connect.garmin.com");
  } catch {
    throw invalidApiPath(value);
  }
  if (
    !value.startsWith("/gc-api/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.includes("..") ||
    value.includes("%") ||
    canonical.origin !== "https://connect.garmin.com" ||
    canonical.pathname !== value
  ) {
    throw invalidApiPath(value);
  }
  return value as ApiPath;
}

function invalidApiPath(value: string): CliError {
  return new CliError("INVALID_API_PATH", "API path must be a clean absolute /gc-api/ path", {
    path: value
  });
}

function parseQuery(value: string | undefined): Readonly<Record<string, QueryValue>> {
  if (value === undefined) return {};
  if (value.length > 8192) throw new CliError("INVALID_QUERY", "Query string cannot exceed 8192 characters");
  const parsed = new URLSearchParams(value);
  const query = Object.create(null) as Record<string, QueryValue>;
  for (const [name, item] of parsed) {
    if (name.length === 0) throw new CliError("INVALID_QUERY", "Query parameter names cannot be empty");
    if (FORBIDDEN_QUERY_NAMES.has(name.toLowerCase())) {
      throw new CliError("INVALID_QUERY", "Sensitive or transport-level query names are not allowed", { name });
    }
    const existing = Object.hasOwn(query, name) ? query[name] : undefined;
    query[name] = existing === undefined
      ? item
      : Array.isArray(existing)
        ? [...existing, item]
        : [existing, item];
  }
  return Object.freeze(query);
}
