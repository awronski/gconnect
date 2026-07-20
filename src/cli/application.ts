import { CliError } from "../core/errors.js";
import { result, type CommandResult } from "../core/result.js";
import type { FeatureContext } from "../features/context.js";
import type { OutputService } from "../output/output-service.js";
import { validateCommandInput, type CommandContract, type OptionValue } from "./command-contract.js";
import { CommandRegistry } from "./command-registry.js";
import { GLOBAL_OPTIONS, ROOT_OPTIONS } from "./global-options.js";
import { parseArgv } from "./parser.js";

const ROOT_COMMAND_CONTRACT: CommandContract = Object.freeze({
  id: "system.root",
  path: ["gconnect"] as const,
  summary: "Describe the CLI or report its version.",
  options: ROOT_OPTIONS,
  examples: ["gconnect --help", "gconnect --version"],
  output: { dataset: "system.command-catalogue", shape: "document" as const }
});

export interface CliApplicationDependencies {
  readonly registry: CommandRegistry;
  readonly context: FeatureContext;
  readonly output: OutputService;
  readonly version: string;
  readonly recoverAuth?: () => Promise<void>;
  readonly interactive?: boolean;
}

export class CliApplication {
  readonly #registry: CommandRegistry;
  readonly #context: FeatureContext;
  readonly #output: OutputService;
  readonly #version: string;
  readonly #recoverAuth: (() => Promise<void>) | null;
  readonly #interactive: boolean;

  public constructor(dependencies: CliApplicationDependencies) {
    this.#registry = dependencies.registry;
    this.#context = dependencies.context;
    this.#output = dependencies.output;
    this.#version = dependencies.version;
    this.#recoverAuth = dependencies.recoverAuth ?? null;
    this.#interactive = dependencies.interactive ?? false;
  }

  public async run(argv: readonly string[]): Promise<void> {
    const parsed = parseArgv(argv);
    if (parsed.positionals.length === 0) {
      await this.#runRootOption(parsed.options);
      return;
    }

    const resolved = this.#registry.resolve(parsed.positionals);
    if (isRawTrue(parsed.options.help)) {
      const outputPath = validateHelpRequest(resolved.command.contract, parsed.options);
      await this.#output.write(commandDescription(resolved.command.contract, this.#context.clock.now()), outputRequest(outputPath));
      return;
    }
    const input = validateCommandInput(
      resolved.command.contract,
      parsed.options,
      resolved.additionalPositionals,
      GLOBAL_OPTIONS
    );
    const outputPath = stringOption(input.options, "output");

    if (input.options.help === true) {
      await this.#output.write(commandDescription(resolved.command.contract, this.#context.clock.now()), outputRequest(outputPath));
      return;
    }
    let commandResult;
    try {
      commandResult = await resolved.command.invoke(this.#context, input);
    } catch (error) {
      const supportsRecovery = Object.hasOwn(resolved.command.contract.options, "recover-auth");
      const recoveryEnabled = supportsRecovery && (input.options["recover-auth"] === true
        || (this.#interactive && input.options["no-auth-recovery"] !== true));
      if (
        !recoveryEnabled
        || this.#recoverAuth === null
        || !isAuthenticationFailure(error)
      ) {
        throw error;
      }
      await this.#recoverAuth();
      commandResult = await resolved.command.invoke(this.#context, input);
    }
    await this.#output.write(commandResult, outputRequest(outputPath));
  }

  async #runRootOption(options: Readonly<Record<string, string | boolean>>): Promise<void> {
    const input = validateCommandInput(ROOT_COMMAND_CONTRACT, options, [], {});
    const outputPath = stringOption(input.options, "output");
    if (input.options.help === true && input.options.version === true) {
      throw new CliError("INVALID_OPTION_COMBINATION", "--help cannot be used with --version", {
        command: ROOT_COMMAND_CONTRACT.id,
        options: ["help", "version"]
      });
    }
    if (input.options.version === true) {
      await this.#output.write(
        result({
          command: "version",
          dataset: "system.version",
          generatedAt: this.#context.clock.now().toISOString(),
          sourceEndpoints: [],
          appliedOptions: {},
          data: { version: this.#version }
        }),
        outputRequest(outputPath)
      );
      return;
    }
    if (input.options.help === true) {
      await this.#output.write(commandCatalogue(this.#registry.contracts(), this.#context.clock.now()), outputRequest(outputPath));
      return;
    }
    throw new CliError("MISSING_COMMAND", "Expected a command", {
      commands: topLevelCommands(this.#registry.contracts()),
      hint: "Run gconnect --help or gconnect system describe"
    });
  }
}

function isRawTrue(value: string | boolean | undefined): boolean {
  return value === true || value === "true" || value === "1";
}

function validateHelpRequest(
  contract: CommandContract,
  rawOptions: Readonly<Record<string, string | boolean>>
): string | undefined {
  const allowed = new Set([...Object.keys(GLOBAL_OPTIONS), ...Object.keys(contract.options)]);
  for (const name of Object.keys(rawOptions)) {
    if (!allowed.has(name)) {
      throw new CliError("UNKNOWN_OPTION", `Unknown option for ${contract.path.join(" ")}: --${name}`, {
        command: contract.id,
        option: name,
        allowed: [...allowed].sort()
      });
    }
  }
  const output = rawOptions.output;
  if (output === undefined) return undefined;
  if (typeof output !== "string" || output.length === 0) {
    throw new CliError("INVALID_OPTION", "--output requires a file path", { option: "output" });
  }
  return output;
}

function isAuthenticationFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = String((error as { readonly code?: unknown }).code);
  return code === "AUTH_REQUIRED" || code === "AUTH_FORBIDDEN" || code === "AUTH_BROWSER_RECOVERY_REQUIRED";
}

function stringOption(options: Readonly<Record<string, OptionValue>>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function outputRequest(outputPath: string | undefined): { readonly outputPath?: string } {
  return outputPath === undefined ? {} : { outputPath };
}

function topLevelCommands(contracts: readonly CommandContract[]): readonly string[] {
  return [...new Set(contracts.map((contract) => contract.path[0]))].sort();
}

export function commandCatalogue(contracts: readonly CommandContract[], now: Date): CommandResult<unknown> {
  return result({
    command: "help",
    dataset: "system.command-catalogue",
    generatedAt: now.toISOString(),
    sourceEndpoints: [],
    appliedOptions: {},
    data: {
      usage: "gconnect <command> [options]",
      globalOptions: GLOBAL_OPTIONS,
      rootOptions: ROOT_OPTIONS,
      commands: [...contracts].sort((left, right) => left.id.localeCompare(right.id))
    }
  });
}

function commandDescription(contract: CommandContract, now: Date): CommandResult<unknown> {
  return result({
    command: "help",
    dataset: "system.command-description",
    generatedAt: now.toISOString(),
    sourceEndpoints: [],
    appliedOptions: { command: contract.id },
    data: { globalOptions: GLOBAL_OPTIONS, rootOptions: ROOT_OPTIONS, command: contract }
  });
}
