export type ErrorDetails = Readonly<Record<string, unknown>>;

export class CliError extends Error {
  public readonly code: string;
  public readonly details: ErrorDetails;
  public readonly exitCode: number;

  public constructor(code: string, message: string, details: ErrorDetails = {}, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export class ProtocolChangedError extends CliError {
  public constructor(details: ErrorDetails, cause?: unknown) {
    super("PROTOCOL_CHANGED", "Garmin returned data that does not match the expected contract", details, 1);
    this.name = "ProtocolChangedError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
