const SECRET_KEY = /(authorization|cookie|csrf|password|secret|token|ticket|credential|mfa|otp|passcode|verificationcode)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecretText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) && !isSafeBooleanMetadata(key, item)
      ? "[REDACTED]"
      : redactSecrets(item, seen);
  }
  return output;
}

function isSafeBooleanMetadata(key: string, value: unknown): boolean {
  return (key === "credentialCleanupCompleted" || key === "credentialsMayRemain")
    && typeof value === "boolean";
}

export function redactSecretText(value: string): string {
  return value
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]+/gi, "Basic [REDACTED]")
    .replace(/\bST-[A-Za-z0-9._~+-]+\b/g, "[REDACTED]")
    .replace(/\b(MFA|OTP|passcode)(?:\s+verification)?\s+code\s*[:=]\s*\S+/gi, "$1 code: [REDACTED]")
    .replace(/\b(Cookie|Set-Cookie|Connect-Csrf-Token)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]")
    .replace(
      /([?&\s"'](?:access_token|refresh_token|service_ticket|password|mfaVerificationCode|mfaCode|mfa_code|otp|passcode|csrf-token|cookie)=)[^&\s"']+/gi,
      "$1[REDACTED]"
    );
}
