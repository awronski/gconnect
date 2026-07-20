import type { DiTokenSet } from "./contracts.js";
import { PRIVATE_DI_AUTH_BACKEND } from "./contracts.js";
import { protocolChanged } from "./errors.js";

export type MobileLoginResult =
  | { readonly kind: "success"; readonly serviceTicketId: string }
  | { readonly kind: "mfa-required"; readonly method: string }
  | { readonly kind: "invalid-credentials" }
  | { readonly kind: "captcha-required" };

export type MfaVerificationResult =
  | { readonly kind: "success"; readonly serviceTicketId: string }
  | { readonly kind: "rejected"; readonly responseType: string };

export interface DecodedDiTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number | null;
  readonly refreshExpiresInSeconds: number | null;
}

export function parseJsonBody(bodyText: string, stage: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch (cause) {
    throw protocolChanged(stage, cause);
  }
}

export function responseContainsRateLimit(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const error = input.error;
  return isRecord(error) && error["status-code"] === "429";
}

export function decodeMobileLoginResponse(input: unknown): MobileLoginResult {
  const record = expectRecord(input, "mobile login");
  const responseStatus = expectRecord(record.responseStatus, "mobile login responseStatus");
  const type = expectNonEmptyString(responseStatus.type, "mobile login responseStatus.type");
  switch (type) {
    case "SUCCESSFUL":
      return {
        kind: "success",
        serviceTicketId: expectNonEmptyString(record.serviceTicketId, "mobile login serviceTicketId")
      };
    case "MFA_REQUIRED": {
      const info = expectRecord(record.customerMfaInfo, "mobile login customerMfaInfo");
      return {
        kind: "mfa-required",
        method: expectNonEmptyString(info.mfaLastMethodUsed, "mobile login customerMfaInfo.mfaLastMethodUsed")
      };
    }
    case "INVALID_USERNAME_PASSWORD":
      return { kind: "invalid-credentials" };
    case "CAPTCHA_REQUIRED":
      return { kind: "captcha-required" };
    default:
      throw protocolChanged("mobile login", new Error(`Unknown response type ${type}`));
  }
}

export function decodeMfaVerificationResponse(input: unknown): MfaVerificationResult {
  const record = expectRecord(input, "MFA verification");
  const responseStatus = expectRecord(record.responseStatus, "MFA verification responseStatus");
  const type = expectNonEmptyString(responseStatus.type, "MFA verification responseStatus.type");
  if (type === "SUCCESSFUL") {
    return {
      kind: "success",
      serviceTicketId: expectNonEmptyString(record.serviceTicketId, "MFA verification serviceTicketId")
    };
  }
  return { kind: "rejected", responseType: type };
}

export function decodeDiTokenResponse(input: unknown): DecodedDiTokenResponse {
  const record = expectRecord(input, "DI token");
  const tokenType = record.token_type;
  if (tokenType !== undefined && expectNonEmptyString(tokenType, "DI token token_type").toLowerCase() !== "bearer") {
    throw protocolChanged("DI token", new Error("token_type must be bearer"));
  }
  return {
    accessToken: expectNonEmptyString(record.access_token, "DI token access_token"),
    refreshToken: optionalNonEmptyString(record.refresh_token, "DI token refresh_token"),
    expiresInSeconds: optionalPositiveInteger(record.expires_in, "DI token expires_in"),
    refreshExpiresInSeconds: optionalPositiveInteger(
      record.refresh_token_expires_in,
      "DI token refresh_token_expires_in"
    )
  };
}

export function decodeStoredDiTokenSet(input: unknown): DiTokenSet {
  const record = expectRecord(input, "stored DI session");
  expectExactKeys(record, [
    "schemaVersion",
    "backend",
    "accessToken",
    "refreshToken",
    "clientId",
    "accessExpiresAtEpochMs",
    "refreshExpiresAtEpochMs"
  ], "stored DI session");
  if (record.schemaVersion !== 1) throw protocolChanged("stored DI session", new Error("Unsupported schemaVersion"));
  if (record.backend !== PRIVATE_DI_AUTH_BACKEND) {
    throw protocolChanged("stored DI session", new Error("Unexpected auth backend"));
  }
  return {
    backend: PRIVATE_DI_AUTH_BACKEND,
    accessToken: expectNonEmptyString(record.accessToken, "stored DI session accessToken"),
    refreshToken: nullableNonEmptyString(record.refreshToken, "stored DI session refreshToken"),
    clientId: expectNonEmptyString(record.clientId, "stored DI session clientId"),
    accessExpiresAtEpochMs: nullablePositiveInteger(
      record.accessExpiresAtEpochMs,
      "stored DI session accessExpiresAtEpochMs"
    ),
    refreshExpiresAtEpochMs: nullablePositiveInteger(
      record.refreshExpiresAtEpochMs,
      "stored DI session refreshExpiresAtEpochMs"
    )
  };
}

export function encodeStoredDiTokenSet(tokens: DiTokenSet): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    backend: tokens.backend,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    clientId: tokens.clientId,
    accessExpiresAtEpochMs: tokens.accessExpiresAtEpochMs,
    refreshExpiresAtEpochMs: tokens.refreshExpiresAtEpochMs
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function expectRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isRecord(input)) throw protocolChanged(name);
  return input;
}

function expectNonEmptyString(input: unknown, name: string): string {
  if (typeof input !== "string" || input.trim() === "") throw protocolChanged(name);
  return input;
}

function optionalNonEmptyString(input: unknown, name: string): string | null {
  return input === undefined || input === null ? null : expectNonEmptyString(input, name);
}

function nullableNonEmptyString(input: unknown, name: string): string | null {
  return input === null ? null : expectNonEmptyString(input, name);
}

function optionalPositiveInteger(input: unknown, name: string): number | null {
  return input === undefined || input === null ? null : expectPositiveInteger(input, name);
}

function nullablePositiveInteger(input: unknown, name: string): number | null {
  return input === null ? null : expectPositiveInteger(input, name);
}

function expectPositiveInteger(input: unknown, name: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) throw protocolChanged(name);
  return input;
}

function expectExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[], name: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw protocolChanged(name, new Error("Unexpected stored fields"));
  }
}
