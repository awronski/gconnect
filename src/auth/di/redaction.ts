const SENSITIVE_KEY = /^(?:authorization|cookie|csrf|username|password|mfa(?:verification)?code|code|.*token.*|.*ticket.*|.*secret.*)$/i;

export const DI_REDACTED = "[REDACTED]";

export function redactDiAuthText(input: string): string {
  return input
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${DI_REDACTED}`)
    .replace(/\bST-[A-Za-z0-9._~+-]+\b/g, DI_REDACTED)
    .replace(
      /(["']?(?:access_token|refresh_token|service_ticket|password|username|mfaVerificationCode|client_secret)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,
      `$1${DI_REDACTED}`
    );
}

export function redactDiAuthValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redactDiAuthValue);
  if (input === null || typeof input !== "object") {
    return typeof input === "string" ? redactDiAuthText(input) : input;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? DI_REDACTED : redactDiAuthValue(value);
  }
  return redacted;
}
