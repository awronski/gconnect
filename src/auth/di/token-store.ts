import { SecureJsonFile } from "../../storage/secure-json-file.js";
import type { DiTokenSet, DiTokenStore } from "./contracts.js";
import { decodeStoredDiTokenSet, encodeStoredDiTokenSet } from "./protocol.js";

export class FileDiTokenStore implements DiTokenStore {
  readonly #file: SecureJsonFile<Readonly<Record<string, unknown>>>;

  public constructor(path: string) {
    this.#file = new SecureJsonFile(path, (input) => encodeStoredDiTokenSet(decodeStoredDiTokenSet(input)));
  }

  public path(): string {
    return this.#file.path();
  }

  public async load(): Promise<DiTokenSet | null> {
    const stored = await this.#file.load();
    return stored === null ? null : decodeStoredDiTokenSet(stored);
  }

  public async save(tokens: DiTokenSet): Promise<void> {
    const encoded = encodeStoredDiTokenSet(tokens);
    decodeStoredDiTokenSet(encoded);
    await this.#file.save(encoded);
  }

  public async delete(): Promise<void> {
    await this.#file.delete();
  }
}
