import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AuthRecoveryRequest, AuthRecoveryRunner, PreparedAuthRecovery } from "../auth-service.js";
import { CliError } from "../../core/errors.js";
import type { TextSink } from "../../output/output-service.js";
import { startBrowserCompanionRecovery } from "./loopback-server.js";
import type { WebCookieRecoveryVerifier } from "./web-cookie-verifier.js";

const BROWSER_COMPANION_DIRECTORY = fileURLToPath(new URL("../../../browser-companion/", import.meta.url));

export interface BrowserRecoveryRunnerOptions {
  readonly verifier: WebCookieRecoveryVerifier;
  readonly stderr: TextSink;
  readonly environment?: NodeJS.ProcessEnv;
  readonly openUrl?: (url: string) => Promise<void>;
}

export class BrowserRecoveryRunner implements AuthRecoveryRunner {
  readonly #verifier: WebCookieRecoveryVerifier;
  readonly #stderr: TextSink;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #openUrl: (url: string) => Promise<void>;
  #running = false;

  public constructor(options: BrowserRecoveryRunnerOptions) {
    this.#verifier = options.verifier;
    this.#stderr = options.stderr;
    this.#environment = options.environment ?? process.env;
    this.#openUrl = options.openUrl ?? openWithOperatingSystem;
  }

  public async recover(request: AuthRecoveryRequest): Promise<PreparedAuthRecovery> {
    if (this.#running) {
      throw new CliError("AUTH_RECOVERY_IN_PROGRESS", "Authentication recovery is already running in this process", {}, 3);
    }
    this.#running = true;
    try {
      const handle = await startBrowserCompanionRecovery({
        timeoutMs: request.timeoutMs,
        prepare: (transfer, signal) => this.#verifier.prepare(transfer, signal)
      });
      const cancel = (): void => {
        void handle.cancel();
      };
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        this.#stderr.write("Garmin authentication requires browser recovery.\n\n");
        this.#stderr.write("If the GConnect Browser Companion is not installed, open chrome://extensions, choose Load unpacked, and select:\n");
        this.#stderr.write(`${BROWSER_COMPANION_DIRECTORY}\n\n`);
        this.#stderr.write("Open this one-time link in Chrome with the GConnect Browser Companion installed:\n");
        this.#stderr.write(`${handle.url}\n\n`);
        this.#stderr.write("With the recovery page active, click the GConnect Browser Companion action to approve the cookie transfer (find it in Chrome's Extensions/puzzle menu if it is not pinned).\n\n");
        if (isSsh(this.#environment)) {
          const port = new URL(handle.url).port;
          this.#stderr.write("SSH detected. From your local machine, forward the recovery port first:\n");
          this.#stderr.write(`ssh -L ${port}:127.0.0.1:${port} <remote-host>\n\n`);
        }
        if (request.openBrowser) {
          try {
            await this.#openUrl(handle.url);
          } catch {
            this.#stderr.write("Could not open a browser automatically; copy the link above manually.\n\n");
          }
        }
        this.#stderr.write("Waiting for Garmin Connect... Press Ctrl-C to cancel.\n");
        const completed = await handle.completion;
        this.#stderr.write("Garmin browser session verified; committing authentication state.\n");
        return Object.freeze({
          mechanism: completed.mechanism,
          commit: () => completed.session.commit()
        });
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
    } finally {
      this.#running = false;
    }
  }
}

function isSsh(environment: NodeJS.ProcessEnv): boolean {
  return environment.SSH_CONNECTION !== undefined || environment.SSH_CLIENT !== undefined || environment.SSH_TTY !== undefined;
}

function openWithOperatingSystem(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? { executable: "open", arguments: [url] }
    : process.platform === "win32"
      ? { executable: "cmd", arguments: ["/c", "start", "", url] }
      : { executable: "xdg-open", arguments: [url] };
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.arguments, {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
