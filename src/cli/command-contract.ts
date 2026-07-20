import { parseCalendarDate } from "../core/dates.js";
import { CliError } from "../core/errors.js";
import type { CommandResult } from "../core/result.js";
import type { FeatureContext } from "../features/context.js";

export type OptionType = "string" | "integer" | "boolean" | "date" | "enum";
export type OptionValue = string | number | boolean;

interface OptionContractBase {
  readonly description: string;
  readonly required?: boolean;
}

export type OptionContract =
  | (OptionContractBase & {
      readonly type: "string" | "date";
      readonly defaultValue?: string;
      readonly values?: never;
      readonly minimum?: never;
      readonly maximum?: never;
    })
  | (OptionContractBase & {
      readonly type: "integer";
      readonly defaultValue?: number;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly values?: never;
    })
  | (OptionContractBase & {
      readonly type: "boolean";
      readonly defaultValue?: boolean;
      readonly values?: never;
      readonly minimum?: never;
      readonly maximum?: never;
    })
  | (OptionContractBase & {
      readonly type: "enum";
      readonly values: readonly string[];
      readonly defaultValue?: string;
      readonly minimum?: never;
      readonly maximum?: never;
    });

export interface PositionalContract {
  readonly name: string;
  readonly description: string;
}

export interface CommandRules {
  readonly paired?: readonly (readonly [string, string])[];
  readonly exactlyOneOf?: readonly (readonly string[])[];
  readonly incompatible?: readonly (readonly [string, string])[];
}

export interface CommandContract {
  readonly id: string;
  readonly path: readonly [string, ...string[]];
  readonly summary: string;
  readonly options: Readonly<Record<string, OptionContract>>;
  readonly positionals?: readonly PositionalContract[];
  readonly rules?: CommandRules;
  readonly examples: readonly string[];
  readonly output: {
    readonly dataset: string;
    readonly shape: "document" | "collection";
  };
  readonly limitations?: readonly string[];
}

export interface ValidatedCommandInput {
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly positionals: Readonly<Record<string, string>>;
}

export interface CommandDefinition<Options, Data> {
  readonly contract: CommandContract;
  parse(input: ValidatedCommandInput): Options;
  execute(context: FeatureContext, options: Options): Promise<CommandResult<Data>>;
}

export interface RegisteredCommand {
  readonly contract: CommandContract;
  invoke(context: FeatureContext, input: ValidatedCommandInput): Promise<CommandResult<unknown>>;
}

export function defineCommand<Options, Data>(definition: CommandDefinition<Options, Data>): RegisteredCommand {
  return {
    contract: definition.contract,
    invoke: async (context, input) => {
      const output = await definition.execute(context, definition.parse(input));
      assertDeclaredResult(definition.contract, input, output);
      return output;
    }
  };
}

function assertDeclaredResult(
  contract: CommandContract,
  input: ValidatedCommandInput,
  output: CommandResult<unknown>
): void {
  if (output.meta.command !== contract.id || output.meta.dataset !== contract.output.dataset) {
    throw new CliError("INTERNAL_CONTRACT_ERROR", `Command ${contract.id} returned undeclared result metadata`, {
      expected: { command: contract.id, dataset: contract.output.dataset },
      actual: { command: output.meta.command, dataset: output.meta.dataset }
    }, 1);
  }
  if (Object.hasOwn(contract.options, "raw") && output.meta.raw !== (input.options.raw === true)) {
    throw new CliError("INTERNAL_CONTRACT_ERROR", `Command ${contract.id} returned an inconsistent raw mode`, {
      expectedRaw: input.options.raw === true,
      actualRaw: output.meta.raw
    }, 1);
  }
  if (output.data === undefined) {
    throw new CliError("INTERNAL_CONTRACT_ERROR", `Command ${contract.id} returned undefined data`, {}, 1);
  }
}

export function validateCommandInput(
  contract: CommandContract,
  rawOptions: Readonly<Record<string, string | boolean>>,
  rawPositionals: readonly string[],
  globalOptions: Readonly<Record<string, OptionContract>>
): ValidatedCommandInput {
  const optionContracts = { ...globalOptions, ...contract.options };
  const options: Record<string, OptionValue> = {};

  for (const name of Object.keys(rawOptions)) {
    if (optionContracts[name] === undefined) {
      throw new CliError("UNKNOWN_OPTION", `Unknown option for ${contract.path.join(" ")}: --${name}`, {
        command: contract.id,
        option: name,
        allowed: Object.keys(optionContracts).sort()
      });
    }
  }

  for (const [name, descriptor] of Object.entries(optionContracts)) {
    const raw = rawOptions[name];
    if (raw === undefined) {
      if (descriptor.defaultValue !== undefined) {
        options[name] = descriptor.defaultValue;
      } else if (descriptor.required) {
        throw new CliError("MISSING_OPTION", `Missing required option --${name}`, { command: contract.id, option: name });
      }
      continue;
    }
    options[name] = normalizeOption(name, raw, descriptor);
  }

  const positionalContracts = contract.positionals ?? [];
  if (rawPositionals.length !== positionalContracts.length) {
    throw new CliError("INVALID_POSITIONALS", `Expected ${positionalContracts.length} positional argument(s) after ${contract.path.join(" ")}`, {
      command: contract.id,
      expected: positionalContracts.map((item) => item.name),
      received: rawPositionals
    });
  }
  const positionals: Record<string, string> = {};
  for (const [index, descriptor] of positionalContracts.entries()) {
    const value = rawPositionals[index];
    if (value !== undefined) positionals[descriptor.name] = value;
  }

  validateRules(contract, options);
  return { options: Object.freeze(options), positionals: Object.freeze(positionals) };
}

function normalizeOption(name: string, raw: string | boolean, descriptor: OptionContract): OptionValue {
  switch (descriptor.type) {
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      break;
    case "integer": {
      if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) break;
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) break;
      if (descriptor.minimum !== undefined && value < descriptor.minimum) break;
      if (descriptor.maximum !== undefined && value > descriptor.maximum) break;
      return value;
    }
    case "date":
      if (typeof raw === "string") return parseCalendarDate(raw, name);
      break;
    case "enum":
      if (typeof raw === "string" && descriptor.values?.includes(raw)) return raw;
      break;
    case "string":
      if (typeof raw === "string" && raw.length > 0) return raw;
      break;
  }
  throw new CliError("INVALID_OPTION", `Invalid value for --${name}`, {
    option: name,
    value: typeof raw === "boolean" ? raw : "[provided]",
    type: descriptor.type,
    values: descriptor.values
  });
}

function validateRules(contract: CommandContract, options: Readonly<Record<string, OptionValue>>): void {
  for (const [left, right] of contract.rules?.paired ?? []) {
    if (isSelected(options[left]) !== isSelected(options[right])) {
      throw new CliError("INCOMPLETE_OPTION_GROUP", `--${left} and --${right} must be used together`, {
        command: contract.id,
        options: [left, right]
      });
    }
  }
  for (const group of contract.rules?.exactlyOneOf ?? []) {
    const count = group.filter((name) => isSelected(options[name])).length;
    if (count !== 1) {
      throw new CliError("INVALID_OPTION_COMBINATION", `Exactly one of ${group.map((name) => `--${name}`).join(", ")} is required`, {
        command: contract.id,
        options: group
      });
    }
  }
  for (const [left, right] of contract.rules?.incompatible ?? []) {
    if (isSelected(options[left]) && isSelected(options[right])) {
      throw new CliError("INVALID_OPTION_COMBINATION", `--${left} cannot be used with --${right}`, {
        command: contract.id,
        options: [left, right]
      });
    }
  }
}

function isSelected(value: OptionValue | undefined): boolean {
  return value !== undefined && value !== false;
}

export function requiredString(input: ValidatedCommandInput, name: string): string {
  const value = input.options[name] ?? input.positionals[name];
  if (typeof value !== "string") {
    throw new CliError("INTERNAL_CONTRACT_ERROR", `Expected validated string ${name}`, { name }, 1);
  }
  return value;
}

export function optionalStringOption(input: ValidatedCommandInput, name: string): string | undefined {
  const value = input.options[name];
  return typeof value === "string" ? value : undefined;
}

export function integerOption(input: ValidatedCommandInput, name: string, fallback?: number): number {
  const value = input.options[name] ?? fallback;
  if (typeof value !== "number") {
    throw new CliError("INTERNAL_CONTRACT_ERROR", `Expected validated integer ${name}`, { name }, 1);
  }
  return value;
}

export function booleanOption(input: ValidatedCommandInput, name: string): boolean {
  return input.options[name] === true;
}
