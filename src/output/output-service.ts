import { chmod, lstat, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { CliError } from "../core/errors.js";
import type { CommandResult } from "../core/result.js";
import { redactSecrets, redactSecretText } from "../core/redaction.js";

const OUTPUT_DIRECTORY = "outputs";

export interface TextSink {
  write(value: string): void;
}

export interface OutputRequest {
  readonly outputPath?: string;
}

export interface OutputService {
  write(result: CommandResult<unknown>, request: OutputRequest): Promise<void>;
}

export class JsonOutputService implements OutputService {
  readonly #stdout: TextSink;
  readonly #privateDirectory: string;

  public constructor(stdout: TextSink, privateDirectory: string) {
    this.#stdout = stdout;
    this.#privateDirectory = resolve(privateDirectory);
  }

  public async write(result: CommandResult<unknown>, request: OutputRequest): Promise<void> {
    const content = `${JSON.stringify(result, null, 2)}\n`;
    if (request.outputPath === undefined) {
      this.#stdout.write(content);
      return;
    }
    const filename = validateOutputFilename(request.outputPath);
    const outputDirectory = resolve(this.#privateDirectory, OUTPUT_DIRECTORY);
    await preparePrivateDirectory(this.#privateDirectory);
    await preparePrivateDirectory(outputDirectory);
    const target = resolve(outputDirectory, filename);
    const temporary = `${outputDirectory}/.${filename}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function validateOutputFilename(value: string): string {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || basename(value) !== value
    || value.includes("/")
    || value.includes("\\")
  ) {
    throw new CliError(
      "INVALID_OUTPUT_PATH",
      "--output must be a filename inside the GConnect private output directory",
      { option: "output" },
      2
    );
  }
  return value;
}

async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new CliError(
      "INSECURE_PRIVATE_DIRECTORY",
      "GConnect private data directory must not be a symbolic link",
      {},
      1
    );
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export function renderError(error: unknown): string {
  const payload = error instanceof Error && "code" in error
    ? {
        error: {
          schemaVersion: 1,
          code: String((error as { code: unknown }).code),
          message: redactSecretText(error.message),
          retryable: isRetryableError(error),
          details: redactSecrets("details" in error ? (error as { details: unknown }).details : {})
        }
      }
    : {
        error: {
          schemaVersion: 1,
          code: "INTERNAL_ERROR",
          message: redactSecretText(error instanceof Error ? error.message : String(error)),
          retryable: false,
          details: {}
        }
      };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function isRetryableError(error: Error & { readonly code: unknown }): boolean {
  if ("details" in error) {
    const details = (error as { readonly details?: unknown }).details;
    if (details !== null && typeof details === "object" && "retryable" in details) {
      const retryable = (details as { readonly retryable?: unknown }).retryable;
      if (typeof retryable === "boolean") return retryable;
    }
  }
  const code = String(error.code);
  return code === "NETWORK_ERROR" || code === "GARMIN_UNAVAILABLE" || code === "RATE_LIMITED";
}
