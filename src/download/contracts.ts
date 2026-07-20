export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];

export interface JsonRequest<T> {
  readonly path: `/gc-api/${string}`;
  readonly diPath?: `/${string}`;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly decode: (input: unknown) => T;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GarminDownloadService {
  json<T>(request: JsonRequest<T>): Promise<T>;
  optionalJson<T>(request: JsonRequest<T>): Promise<T | null>;
  profileId(): Promise<string>;
}
