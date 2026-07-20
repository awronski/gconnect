export interface ResultMeta {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly dataset: string;
  readonly generatedAt: string;
  readonly sourceEndpoints: readonly string[];
  readonly warnings: readonly string[];
  readonly appliedOptions: Readonly<Record<string, unknown>>;
  readonly raw: boolean;
}

export interface CommandResult<Data = unknown> {
  readonly meta: ResultMeta;
  readonly data: Data;
}

export interface ResultInput<Data> {
  readonly command: string;
  readonly dataset: string;
  readonly sourceEndpoints: readonly string[];
  readonly appliedOptions: Readonly<Record<string, unknown>>;
  readonly data: Data;
  readonly raw?: boolean;
  readonly warnings?: readonly string[];
  readonly generatedAt?: string;
}

export function result<Data>(input: ResultInput<Data>): CommandResult<Data> {
  return {
    meta: {
      schemaVersion: 1,
      command: input.command,
      dataset: input.dataset,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      sourceEndpoints: [...input.sourceEndpoints],
      warnings: [...(input.warnings ?? [])],
      appliedOptions: input.appliedOptions,
      raw: input.raw ?? false
    },
    data: input.data
  };
}
