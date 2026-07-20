export type DiAuthErrorCode =
  | "DI_NETWORK_ERROR"
  | "DI_SERVICE_UNAVAILABLE"
  | "DI_RATE_LIMITED"
  | "DI_BOT_CHALLENGE"
  | "DI_CAPTCHA_REQUIRED"
  | "DI_INVALID_CREDENTIALS"
  | "DI_MFA_REQUIRED"
  | "DI_MFA_REJECTED"
  | "DI_PROTOCOL_CHANGED"
  | "DI_TOKEN_EXCHANGE_FAILED"
  | "DI_REFRESH_REJECTED"
  | "DI_TOKEN_REJECTED"
  | "DI_SESSION_REQUIRED";

export interface DiAuthErrorOptions {
  readonly retryable?: boolean;
  readonly status?: number;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
  readonly cause?: unknown;
}

export class DiAuthError extends Error {
  public readonly code: DiAuthErrorCode;
  public readonly retryable: boolean;
  public readonly status: number | null;
  public readonly context: Readonly<Record<string, string | number | boolean>>;

  public constructor(code: DiAuthErrorCode, message: string, options: DiAuthErrorOptions = {}) {
    super(message);
    this.name = "DiAuthError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.context = options.context ?? {};
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isDiAuthError(error: unknown, code?: DiAuthErrorCode): error is DiAuthError {
  return error instanceof DiAuthError && (code === undefined || error.code === code);
}

export function protocolChanged(stage: string, cause?: unknown): DiAuthError {
  return new DiAuthError(
    "DI_PROTOCOL_CHANGED",
    `Garmin ${stage} response did not match the expected private-DI contract`,
    { context: { stage }, ...(cause === undefined ? {} : { cause }) }
  );
}

export function classifyHttpError(stage: string, status: number): DiAuthError {
  if (status === 429) {
    return new DiAuthError("DI_RATE_LIMITED", `Garmin rate limited ${stage}`, {
      retryable: true,
      status,
      context: { stage }
    });
  }
  if (status >= 500) {
    return new DiAuthError("DI_SERVICE_UNAVAILABLE", `Garmin ${stage} service is unavailable`, {
      retryable: true,
      status,
      context: { stage }
    });
  }
  return protocolChanged(stage, new Error(`Unexpected HTTP status ${status}`));
}
