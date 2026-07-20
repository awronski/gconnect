import { CliError } from "../core/errors.js";
import { parseCalendarDate } from "../core/dates.js";
import type { FeatureModule } from "../features/feature.js";
import type { CommandContract, OptionContract, RegisteredCommand } from "./command-contract.js";
import { GLOBAL_OPTIONS, ROOT_OPTIONS } from "./global-options.js";

export interface ResolvedCommand {
  readonly command: RegisteredCommand;
  readonly additionalPositionals: readonly string[];
}

export class CommandRegistry {
  readonly #commands: readonly RegisteredCommand[];

  public constructor(features: readonly FeatureModule[]) {
    const featureIds = new Set<string>();
    const commandIds = new Set<string>();
    const paths = new Set<string>();
    const commands: RegisteredCommand[] = [];

    for (const [name, option] of Object.entries(ROOT_OPTIONS)) {
      validateOptionContract("global", name, option);
    }

    for (const feature of features) {
      if (featureIds.has(feature.id)) {
        throw new Error(`Duplicate feature id: ${feature.id}`);
      }
      featureIds.add(feature.id);
      if (feature.commands.length === 0) {
        throw new Error(`Feature ${feature.id} has no commands`);
      }
      for (const command of feature.commands) {
        const path = command.contract.path.join(" ");
        if (commandIds.has(command.contract.id)) throw new Error(`Duplicate command id: ${command.contract.id}`);
        if (paths.has(path)) throw new Error(`Duplicate command path: ${path}`);
        validateContract(command.contract);
        commandIds.add(command.contract.id);
        paths.add(path);
        commands.push(command);
      }
    }
    this.#commands = Object.freeze(commands);
  }

  public contracts(): readonly CommandContract[] {
    return this.#commands.map((command) => command.contract);
  }

  public resolve(positionals: readonly string[]): ResolvedCommand {
    if (positionals.length === 0) {
      throw new CliError("MISSING_COMMAND", "Expected a command", {
        commands: this.topLevelCommands()
      });
    }
    const matches = this.#commands
      .filter((command) => startsWithPath(positionals, command.contract.path))
      .sort((left, right) => right.contract.path.length - left.contract.path.length);
    const command = matches[0];
    if (command === undefined) {
      throw new CliError("UNKNOWN_COMMAND", `Unknown command: ${positionals.join(" ")}`, {
        commands: this.topLevelCommands()
      });
    }
    return {
      command,
      additionalPositionals: positionals.slice(command.contract.path.length)
    };
  }

  private topLevelCommands(): readonly string[] {
    return [...new Set(this.#commands.map((command) => command.contract.path[0]))].sort();
  }
}

function startsWithPath(positionals: readonly string[], path: readonly string[]): boolean {
  return path.every((part, index) => positionals[index] === part);
}

function validateContract(contract: CommandContract): void {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(contract.id)
    || contract.path.length === 0
    || contract.path.some((part) => !/^[a-z][a-z0-9-]*$/.test(part))
    || contract.summary.trim().length === 0) {
    throw new Error("Command contracts require id, path, and summary");
  }
  if (contract.examples.length === 0) {
    throw new Error(`Command ${contract.id} must provide an example`);
  }
  if (contract.examples.some((example) => !example.includes("gconnect "))) {
    throw new Error(`Command ${contract.id} examples must be directly executable with gconnect`);
  }
  if (contract.output.dataset.trim().length === 0) throw new Error(`Command ${contract.id} needs an output dataset`);
  for (const [name, option] of Object.entries(contract.options)) {
    validateOptionContract(contract.id, name, option);
    if (ROOT_OPTIONS[name] !== undefined) throw new Error(`Command ${contract.id} redeclares reserved option --${name}`);
  }
  const declaredNames = new Set([...Object.keys(GLOBAL_OPTIONS), ...Object.keys(contract.options)]);
  for (const positional of contract.positionals ?? []) {
    if (!/^[a-z][a-z0-9-]*$/.test(positional.name) || positional.description.trim().length === 0) {
      throw new Error(`Command ${contract.id} has an invalid positional contract`);
    }
    if (declaredNames.has(positional.name)) {
      throw new Error(`Command ${contract.id} reuses ${positional.name} as an option and positional`);
    }
    declaredNames.add(positional.name);
  }
  for (const group of [
    ...(contract.rules?.paired ?? []),
    ...(contract.rules?.exactlyOneOf ?? []),
    ...(contract.rules?.incompatible ?? [])
  ]) {
    if (group.length < 2 || new Set(group).size !== group.length) {
      throw new Error(`Command ${contract.id} has an invalid option rule group`);
    }
    for (const name of group) {
      if (!declaredNames.has(name)) throw new Error(`Command ${contract.id} rule references unknown option ${name}`);
    }
  }
}

function validateOptionContract(owner: string, name: string, option: OptionContract): void {
  const label = `${owner}.--${name}`;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Option ${label} has an invalid name`);
  if (option.description.trim().length === 0) throw new Error(`Option ${label} needs a description`);
  if (option.required === true && option.defaultValue !== undefined) {
    throw new Error(`Option ${label} cannot be required and have a default`);
  }
  switch (option.type) {
    case "boolean":
      if (option.defaultValue !== undefined && typeof option.defaultValue !== "boolean") {
        throw new Error(`Option ${label} has an invalid boolean default`);
      }
      return;
    case "integer": {
      const { minimum, maximum, defaultValue } = option;
      if (minimum !== undefined && !Number.isSafeInteger(minimum)) throw new Error(`Option ${label} has an invalid minimum`);
      if (maximum !== undefined && !Number.isSafeInteger(maximum)) throw new Error(`Option ${label} has an invalid maximum`);
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
        throw new Error(`Option ${label} has minimum greater than maximum`);
      }
      if (defaultValue !== undefined && (!Number.isSafeInteger(defaultValue)
        || (minimum !== undefined && defaultValue < minimum)
        || (maximum !== undefined && defaultValue > maximum))) {
        throw new Error(`Option ${label} has an invalid integer default`);
      }
      return;
    }
    case "enum": {
      const values = option.values;
      if (values.length === 0 || values.some((value) => value.length === 0) || new Set(values).size !== values.length) {
        throw new Error(`Option ${label} has invalid enum values`);
      }
      if (option.defaultValue !== undefined && !values.includes(option.defaultValue)) {
        throw new Error(`Option ${label} has an invalid enum default`);
      }
      return;
    }
    case "date":
      if (option.defaultValue !== undefined) {
        try {
          parseCalendarDate(option.defaultValue, name);
        } catch {
          throw new Error(`Option ${label} has an invalid date default`);
        }
      }
      return;
    case "string":
      if (option.defaultValue !== undefined && option.defaultValue.length === 0) {
        throw new Error(`Option ${label} has an invalid string default`);
      }
  }
}
