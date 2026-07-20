import { booleanOption, defineCommand, integerOption, optionalStringOption } from "../../cli/command-contract.js";
import { result } from "../../core/result.js";
import type { AuthService } from "../../auth/auth-service.js";
import type { FeatureModule } from "../feature.js";
import { NO_AUTH_RECOVERY_OPTION } from "../auth-recovery-options.js";

export function createAuthFeature(auth: AuthService): FeatureModule {
  return {
    id: "auth",
    commands: [
      defineCommand({
        contract: {
          id: "auth.login",
          path: ["auth", "login"],
          summary: "Create a renewable browserless Garmin private-DI session.",
          options: {
            username: { type: "string", description: "Garmin email; otherwise use GARMIN_USERNAME or an interactive prompt." },
            "password-stdin": { type: "boolean", defaultValue: false, description: "Read password from the first stdin line and MFA from the second." },
            "no-auth-recovery": NO_AUTH_RECOVERY_OPTION
          },
          examples: [
            "gconnect auth login --username user@example.com",
            "printf 'password\\n' | gconnect auth login --username user@example.com --password-stdin"
          ],
          output: { dataset: "auth.status", shape: "document" },
          limitations: ["Garmin CAPTCHA/bot challenges automatically fall back to browser recovery unless --no-auth-recovery is set."]
        },
        parse: (input) => {
          const username = optionalStringOption(input, "username");
          return {
            ...(username === undefined ? {} : { username }),
            passwordStdin: booleanOption(input, "password-stdin"),
            browserRecovery: input.options["no-auth-recovery"] !== true
          };
        },
        execute: async (context, options) => {
          let recovered = false;
          let status: Awaited<ReturnType<AuthService["login"]>>;
          try {
            status = await auth.login(options);
          } catch (error) {
            if (!options.browserRecovery || !hasErrorCode(error, "AUTH_BROWSER_RECOVERY_REQUIRED")) {
              throw error;
            }
            await auth.recover({ timeoutMs: 300_000, openBrowser: false });
            status = await auth.status(false);
            recovered = true;
          }
          return result({
            command: "auth.login",
            dataset: "auth.status",
            generatedAt: context.clock.now().toISOString(),
            sourceEndpoints: ["https://sso.garmin.com/mobile/api/login", "https://diauth.garmin.com/di-oauth2-service/oauth/token"],
            appliedOptions: {
              usernameProvided: options.username !== undefined,
              passwordStdin: options.passwordStdin,
              browserRecovery: options.browserRecovery,
              recovered
            },
            data: status
          });
        }
      }),
      defineCommand({
        contract: {
          id: "auth.status",
          path: ["auth", "status"],
          summary: "Report stored authentication state without exposing credentials.",
          options: {
            verify: { type: "boolean", defaultValue: false, description: "Make a read-only Garmin request to verify or refresh the session." }
          },
          examples: ["gconnect auth status", "gconnect auth status --verify"],
          output: { dataset: "auth.status", shape: "document" }
        },
        parse: (input) => ({ verify: booleanOption(input, "verify") }),
        execute: async (context, options) => result({
          command: "auth.status",
          dataset: "auth.status",
          generatedAt: context.clock.now().toISOString(),
          sourceEndpoints: options.verify ? ["Garmin authentication probe"] : [],
          appliedOptions: options,
          data: await auth.status(options.verify)
        })
      }),
      defineCommand({
        contract: {
          id: "auth.recover",
          path: ["auth", "recover"],
          summary: "Start one-shot browser-companion recovery and print a safe loopback link.",
          options: {
            timeout: { type: "integer", defaultValue: 300, minimum: 60, maximum: 900, description: "Recovery timeout in seconds (60-900)." },
            open: { type: "boolean", defaultValue: false, description: "Also ask the operating system to open the recovery link." }
          },
          examples: ["gconnect auth recover", "gconnect auth recover --open --timeout 300"],
          output: { dataset: "auth.recovery", shape: "document" },
          limitations: ["Requires the bundled Garmin browser companion extension in the browser that opens the link."]
        },
        parse: (input) => ({
          timeoutMs: integerOption(input, "timeout") * 1_000,
          openBrowser: booleanOption(input, "open")
        }),
        execute: async (context, options) => result({
          command: "auth.recover",
          dataset: "auth.recovery",
          generatedAt: context.clock.now().toISOString(),
          sourceEndpoints: [],
          appliedOptions: { timeoutSeconds: options.timeoutMs / 1_000, open: options.openBrowser },
          data: await auth.recover(options)
        })
      }),
      defineCommand({
        contract: {
          id: "auth.disconnect",
          path: ["auth", "disconnect"],
          summary: "Delete all locally stored Garmin sessions.",
          options: {},
          examples: ["gconnect auth disconnect"],
          output: { dataset: "auth.status", shape: "document" }
        },
        parse: () => ({}),
        execute: async (context) => {
          await auth.disconnect();
          return result({
            command: "auth.disconnect",
            dataset: "auth.status",
            generatedAt: context.clock.now().toISOString(),
            sourceEndpoints: [],
            appliedOptions: {},
            data: { connected: false }
          });
        }
      })
    ]
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && String((error as { readonly code?: unknown }).code) === code;
}
