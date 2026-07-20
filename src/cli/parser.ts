import { CliError } from "../core/errors.js";

export interface ParsedArgv {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const option = token.slice(2);
    if (option.length === 0) {
      throw new CliError("INVALID_OPTION", "Empty option name");
    }
    const equalsIndex = option.indexOf("=");
    if (equalsIndex >= 0) {
      setOption(options, option.slice(0, equalsIndex), option.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      setOption(options, option, true);
      continue;
    }
    setOption(options, option, next);
    index += 1;
  }

  return { positionals, options };
}

function setOption(
  options: Record<string, string | boolean>,
  key: string,
  value: string | boolean
): void {
  if (!/^[a-z][a-z0-9-]*$/.test(key)) {
    throw new CliError("INVALID_OPTION", `Invalid option name: --${key}`, { option: key });
  }
  if (Object.hasOwn(options, key)) {
    throw new CliError("DUPLICATE_OPTION", `Option --${key} was provided more than once`, { option: key });
  }
  options[key] = value;
}
