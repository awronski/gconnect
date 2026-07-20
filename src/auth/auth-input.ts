import { createInterface } from "node:readline/promises";
import { CliError } from "../core/errors.js";

export interface AuthInput {
  readonly interactive: boolean;
  readUsername(explicit: string | undefined): Promise<string>;
  readPassword(fromStdin: boolean): Promise<string>;
  readMfaCode(method: string, fromStdin: boolean): Promise<string>;
}

export interface ProcessAuthInputOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadStream;
  readonly stderr?: NodeJS.WriteStream;
}

export class ProcessAuthInput implements AuthInput {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #stdin: NodeJS.ReadStream;
  readonly #stderr: NodeJS.WriteStream;
  #lines: AsyncIterator<string> | null = null;

  public constructor(options: ProcessAuthInputOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#stdin = options.stdin ?? process.stdin;
    this.#stderr = options.stderr ?? process.stderr;
  }

  public get interactive(): boolean {
    return this.#stdin.isTTY === true && this.#stderr.isTTY === true;
  }

  public async readUsername(explicit: string | undefined): Promise<string> {
    const configured = explicit ?? this.#environment.GARMIN_USERNAME;
    if (configured !== undefined && configured.trim().length > 0) return configured.trim();
    if (!this.interactive) {
      throw new CliError("MISSING_USERNAME", "Garmin username is required in non-interactive mode", {
        hint: "Use --username or GARMIN_USERNAME"
      });
    }
    const readline = createInterface({ input: this.#stdin, output: this.#stderr });
    try {
      const value = (await readline.question("Garmin email: ")).trim();
      if (value.length === 0) throw new CliError("MISSING_USERNAME", "Garmin username cannot be empty");
      return value;
    } finally {
      readline.close();
    }
  }

  public async readPassword(fromStdin: boolean): Promise<string> {
    const configured = this.#environment.GARMIN_PASSWORD;
    if (configured !== undefined && configured.length > 0) return configured;
    if (fromStdin) return this.#requireLine("password");
    if (!this.interactive) {
      throw new CliError("MISSING_PASSWORD", "Garmin password is required in non-interactive mode", {
        hint: "Use --password-stdin or GARMIN_PASSWORD; passwords are never accepted as command arguments"
      });
    }
    return this.#readHidden("Garmin password: ");
  }

  public async readMfaCode(method: string, fromStdin: boolean): Promise<string> {
    const configured = this.#environment.GARMIN_MFA_CODE;
    if (configured !== undefined && configured.trim().length > 0) return configured.trim();
    if (fromStdin) return this.#requireLine("MFA code");
    if (!this.interactive) {
      throw new CliError("MFA_INPUT_REQUIRED", "Garmin MFA requires an input code", {
        method,
        hint: "Set GARMIN_MFA_CODE or provide the second stdin line with --password-stdin"
      }, 3);
    }
    const readline = createInterface({ input: this.#stdin, output: this.#stderr });
    try {
      const value = (await readline.question(`Garmin MFA code (${method}): `)).trim();
      if (value.length === 0) throw new CliError("MFA_INPUT_REQUIRED", "Garmin MFA code cannot be empty", { method }, 3);
      return value;
    } finally {
      readline.close();
    }
  }

  async #requireLine(name: string): Promise<string> {
    this.#lines ??= createInterface({ input: this.#stdin, terminal: false })[Symbol.asyncIterator]();
    const next = await this.#lines.next();
    const value = next.done ? "" : next.value;
    if (value.length === 0) throw new CliError("MISSING_AUTH_INPUT", `Garmin ${name} was not provided on stdin`);
    return value;
  }

  async #readHidden(prompt: string): Promise<string> {
    this.#stderr.write(prompt);
    const input = this.#stdin;
    const previousRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    try {
      return await new Promise<string>((resolve, reject) => {
        const bytes: number[] = [];
        const onData = (chunk: Buffer): void => {
          for (const byte of chunk) {
            if (byte === 3) {
              cleanup();
              erase();
              reject(new CliError("CANCELLED", "Authentication was cancelled", {}, 130));
              return;
            }
            if (byte === 10 || byte === 13) {
              cleanup();
              this.#stderr.write("\n");
              if (bytes.length === 0) {
                reject(new CliError("MISSING_PASSWORD", "Garmin password cannot be empty"));
                return;
              }
              try {
                const value = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
                erase();
                resolve(value);
              } catch {
                erase();
                reject(new CliError("INVALID_AUTH_INPUT", "Garmin password was not valid UTF-8"));
              }
              return;
            }
            if (byte === 8 || byte === 127) removeLastUtf8CodePoint(bytes);
            else bytes.push(byte);
          }
        };
        const cleanup = (): void => {
          input.off("data", onData);
        };
        const erase = (): void => {
          bytes.fill(0);
          bytes.length = 0;
        };
        input.on("data", onData);
      });
    } finally {
      input.setRawMode?.(previousRaw);
      input.pause();
    }
  }
}

function removeLastUtf8CodePoint(bytes: number[]): void {
  if (bytes.length === 0) return;
  let start = bytes.length - 1;
  while (start > 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1;
  bytes.fill(0, start);
  bytes.length = start;
}
