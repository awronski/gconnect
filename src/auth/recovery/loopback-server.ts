import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CliError } from "../../core/errors.js";
import {
  decodeBrowserSessionTransfer,
  type BrowserSessionTransferV2
} from "./companion-protocol.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 300_000;
const MINIMUM_TIMEOUT_MS = 10;
const MAXIMUM_TIMEOUT_MS = 900_000;
const DEFAULT_MAXIMUM_BODY_BYTES = 65_536;
const MAXIMUM_ALLOWED_BODY_BYTES = 1_048_576;
const MAXIMUM_HEADER_BYTES = 8_192;
const TERMINAL_STATUS_GRACE_MS = 5_000;

export type BrowserCompanionRecoveryStage =
  | "waiting"
  | "verifying"
  | "complete"
  | "failed"
  | "cancelled";

export interface BrowserCompanionRecoveryResult<Session> {
  readonly session: Session;
  readonly mechanism: "browser_companion";
}

export interface BrowserCompanionRecoveryOptions<Session> {
  readonly prepare: (transfer: BrowserSessionTransferV2, signal: AbortSignal) => Promise<Session>;
  readonly timeoutMs?: number;
  readonly port?: number;
  readonly maximumBodyBytes?: number;
}

export interface BrowserCompanionRecoveryHandle<Session> {
  readonly url: string;
  readonly completion: Promise<BrowserCompanionRecoveryResult<Session>>;
  status(): BrowserCompanionRecoveryStage;
  cancel(): Promise<void>;
}

export async function startBrowserCompanionRecovery<Session>(
  options: BrowserCompanionRecoveryOptions<Session>
): Promise<BrowserCompanionRecoveryHandle<Session>> {
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MINIMUM_TIMEOUT_MS,
    MAXIMUM_TIMEOUT_MS,
    "timeoutMs"
  );
  const port = boundedInteger(options.port ?? 0, 0, 65_535, "port");
  const maximumBodyBytes = boundedInteger(
    options.maximumBodyBytes ?? DEFAULT_MAXIMUM_BODY_BYTES,
    1,
    MAXIMUM_ALLOWED_BODY_BYTES,
    "maximumBodyBytes"
  );
  const nonce = randomBytes(32).toString("base64url");

  let stage: BrowserCompanionRecoveryStage = "waiting";
  let expectedHost = "";
  let submissionInProgress = false;
  let terminal = false;
  let timer: NodeJS.Timeout | undefined;
  let terminalCloseTimer: NodeJS.Timeout | undefined;
  let resolveCompletion!: (result: BrowserCompanionRecoveryResult<Session>) => void;
  let rejectCompletion!: (error: CliError) => void;
  const lifecycle = new AbortController();
  const completion = new Promise<BrowserCompanionRecoveryResult<Session>>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);

  const server = createServer({ maxHeaderSize: MAXIMUM_HEADER_BYTES }, (request, response) => {
    request.setTimeout(10_000, () => {
      if (!response.headersSent) respondJson(response, 408, { error: { code: "REQUEST_TIMEOUT" } });
      request.destroy();
    });
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) respondJson(response, 500, { error: { code: "INTERNAL_ERROR" } });
      else response.destroy();
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 8;

  try {
    await listen(server, port);
  } catch {
    throw new CliError("RECOVERY_LISTENER_FAILED", "Could not start the loopback recovery listener", {
      port: port === 0 ? "automatic" : port
    }, 1);
  }
  const address = server.address() as AddressInfo | null;
  if (address === null || address.address !== LOOPBACK_HOST) {
    await closeServer(server, true);
    throw new CliError("RECOVERY_LISTENER_FAILED", "Recovery listener did not bind to IPv4 loopback", {}, 1);
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  const url = `http://${expectedHost}/recover/${nonce}`;
  const expiresAt = Date.now() + timeoutMs;
  timer = setTimeout(() => {
    void fail(
      new CliError("AUTH_RECOVERY_TIMEOUT", "Browser-assisted authentication recovery timed out", {}, 3),
      "failed"
    );
  }, timeoutMs);
  timer.unref();

  return Object.freeze({
    url,
    completion,
    status: () => stage,
    cancel: () => fail(
      new CliError("AUTH_RECOVERY_CANCELLED", "Browser-assisted authentication recovery was cancelled", {}, 3),
      "cancelled"
    )
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySafeHeaders(response);
    if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      respondJson(response, 403, { error: { code: "LOOPBACK_REQUIRED" } });
      return;
    }
    if (request.headers.host !== expectedHost) {
      respondJson(response, 403, { error: { code: "INVALID_HOST" } });
      return;
    }

    const requestUrl = parseRequestUrl(request.url, expectedHost);
    if (requestUrl === null) {
      respondJson(response, 400, { error: { code: "INVALID_REQUEST_TARGET" } });
      return;
    }
    const recoveryPath = `/recover/${nonce}`;
    if (requestUrl.search.length > 0 || !requestUrl.pathname.startsWith(`${recoveryPath}`)) {
      respondJson(response, 404, { error: { code: "NOT_FOUND" } });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === recoveryPath) {
      respondHtml(response, progressPage(expiresAt));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === `${recoveryPath}/status`) {
      respondJson(response, 200, { status: publicStatus(stage), expiresAt }, () => {
        if (terminal) void closeTerminalServer();
      });
      return;
    }
    if (request.method !== "POST" || requestUrl.pathname !== `${recoveryPath}/session`) {
      respondJson(response, request.method === "GET" ? 404 : 405, {
        error: { code: request.method === "GET" ? "NOT_FOUND" : "METHOD_NOT_ALLOWED" }
      });
      return;
    }
    if (terminal) {
      respondJson(response, 410, { error: { code: "RECOVERY_EXPIRED" } });
      return;
    }
    if (submissionInProgress) {
      respondJson(response, 409, { error: { code: "RECOVERY_IN_PROGRESS" } });
      return;
    }
    if (!isSupportedContentType(request.headers["content-type"])) {
      respondJson(response, 415, { error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
      return;
    }

    submissionInProgress = true;
    stage = "verifying";
    let transfer: BrowserSessionTransferV2;
    try {
      const parsed = await readJson(request, maximumBodyBytes);
      transfer = decodeBrowserSessionTransfer(parsed, nonce);
    } catch (error) {
      if (terminal) return;
      submissionInProgress = false;
      stage = "waiting";
      const cliError = error instanceof CliError
        ? error
        : new CliError("INVALID_RECOVERY_TRANSFER", "Browser companion sent invalid JSON", {}, 2);
      const status = cliError.code === "PAYLOAD_TOO_LARGE"
        ? 413
        : cliError.code === "RECOVERY_NONCE_MISMATCH"
          ? 403
          : 400;
      respondJson(response, status, { error: { code: cliError.code } });
      return;
    }

    if (terminal) return;
    response.setHeader("Connection", "close");
    respondJson(response, 202, { status: "verifying" });
    setImmediate(() => void finishVerification(transfer));
  }

  async function finishVerification(transfer: BrowserSessionTransferV2): Promise<void> {
    let session: Session;
    try {
      session = await options.prepare(transfer, lifecycle.signal);
    } catch (cause) {
      if (terminal) return;
      terminal = true;
      stage = "failed";
      clearRecoveryTimer();
      scheduleTerminalClose();
      rejectCompletion(classifyRecoveryFailure(cause));
      return;
    }

    if (terminal) return;
    terminal = true;
    stage = "complete";
    clearRecoveryTimer();
    scheduleTerminalClose();
    resolveCompletion({ session, mechanism: "browser_companion" });
  }

  async function fail(error: CliError, nextStage: "failed" | "cancelled"): Promise<void> {
    if (terminal) return;
    terminal = true;
    stage = nextStage;
    lifecycle.abort();
    clearRecoveryTimer();
    clearTerminalCloseTimer();
    await closeServer(server, true);
    rejectCompletion(error);
  }

  function scheduleTerminalClose(): void {
    // Keep the listener referenced briefly so the browser's next poll can observe
    // the terminal state. That poll closes it immediately; the timer is the fallback.
    terminalCloseTimer = setTimeout(() => {
      void closeTerminalServer();
    }, TERMINAL_STATUS_GRACE_MS);
  }

  async function closeTerminalServer(): Promise<void> {
    clearTerminalCloseTimer();
    await closeServer(server, false);
  }

  function clearRecoveryTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function clearTerminalCloseTimer(): void {
    if (terminalCloseTimer !== undefined) {
      clearTimeout(terminalCloseTimer);
      terminalCloseTimer = undefined;
    }
  }
}

function classifyRecoveryFailure(cause: unknown): CliError {
  if (cause instanceof CliError) {
    if (cause.code === "AUTH_RECOVERY_VERIFICATION_FAILED") {
      const stage = safeVerificationDetail(cause.details.stage, "unknown");
      const reasonCode = safeVerificationDetail(cause.details.reasonCode, "INTERNAL_ERROR");
      const status = safeVerificationStatus(cause.details.status);
      if (reasonCode === "NETWORK_ERROR" || reasonCode === "GARMIN_UNAVAILABLE" || reasonCode === "RATE_LIMITED") {
        return new CliError(reasonCode, "Garmin could not be reached while verifying the browser session", {
          retryable: true,
          stage
        }, cause.exitCode);
      }
      if (reasonCode === "PROTOCOL_CHANGED") {
        return new CliError(
          "PROTOCOL_CHANGED",
          "Garmin recovery verification no longer matches the expected contract",
          { stage },
          1
        );
      }
      return new CliError(
        "AUTH_RECOVERY_FAILED",
        "The transferred Garmin session could not be verified",
        { stage, reasonCode, ...(status === undefined ? {} : { status }) },
        3
      );
    }
    if (cause.code === "NETWORK_ERROR" || cause.code === "GARMIN_UNAVAILABLE" || cause.code === "RATE_LIMITED") {
      return new CliError(cause.code, "Garmin could not be reached while verifying the browser session", {
        retryable: true
      }, cause.exitCode);
    }
    if (cause.code === "PROTOCOL_CHANGED") {
      return new CliError("PROTOCOL_CHANGED", "Garmin recovery verification no longer matches the expected contract", {}, 1);
    }
  }
  return new CliError(
    "AUTH_RECOVERY_FAILED",
    "The transferred Garmin session could not be verified",
    {},
    3
  );
}

function safeVerificationDetail(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : fallback;
}

function safeVerificationStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CliError("INVALID_RECOVERY_OPTION", `${name} must be an integer from ${minimum} to ${maximum}`, {
      option: name,
      minimum,
      maximum
    });
  }
  return value;
}

function parseRequestUrl(raw: string | undefined, expectedHost: string): URL | null {
  if (raw === undefined) return null;
  const base = `http://${expectedHost}`;
  try {
    const url = new URL(raw, base);
    return url.origin === base ? url : null;
  } catch {
    return null;
  }
}

function isSupportedContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType === "text/plain";
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new CliError("INVALID_RECOVERY_TRANSFER", "Invalid Content-Length", {}, 2);
    }
    if (parsedLength > maximumBytes) {
      request.resume();
      throw new CliError("PAYLOAD_TOO_LARGE", "Recovery transfer exceeded the size limit", {
        maximumBytes
      }, 2);
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const erase = (): void => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const onData = (value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.byteLength;
      if (size > maximumBytes) {
        cleanup();
        erase();
        request.resume();
        reject(new CliError("PAYLOAD_TOO_LARGE", "Recovery transfer exceeded the size limit", {
          maximumBytes
        }, 2));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => {
      cleanup();
      const combined = Buffer.concat(chunks, size);
      erase();
      resolve(combined);
    };
    const onError = (): void => {
      cleanup();
      erase();
      reject(new CliError("INVALID_RECOVERY_TRANSFER", "Recovery transfer could not be read", {}, 2));
    };
    const onAborted = (): void => {
      cleanup();
      erase();
      reject(new CliError("INVALID_RECOVERY_TRANSFER", "Recovery transfer was aborted", {}, 2));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });

  let text = "";
  try {
    text = buffer.toString("utf8");
    return JSON.parse(text) as unknown;
  } finally {
    text = "";
    buffer.fill(0);
  }
}

function publicStatus(stage: BrowserCompanionRecoveryStage): "waiting" | "verifying" | "complete" | "failed" {
  if (stage === "verifying" || stage === "complete" || stage === "failed") return stage;
  return stage === "cancelled" ? "failed" : "waiting";
}

function progressPage(expiresAt: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="gconnect-recovery-expires-at" content="${expiresAt}"><title>GConnect recovery</title></head><body><main><h1>Reconnect Garmin Connect</h1><p>With this recovery page active, click the GConnect Browser Companion action to approve this one-time recovery. If it is not pinned, find it in Chrome's Extensions (puzzle) menu. Complete sign-in on Garmin's page, then return to your terminal.</p><p id="gconnect-recovery-status" role="status">Waiting for your approval in the browser companion.</p><p>No Garmin password or cookie is shown on this page.</p></main></body></html>`;
}

function applySafeHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=()");
}

function respondHtml(response: ServerResponse, body: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function respondJson(
  response: ServerResponse,
  status: number,
  payload: Readonly<Record<string, unknown>>,
  callback?: () => void
): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body, callback);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server, force: boolean): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (force) server.closeAllConnections();
  });
}
