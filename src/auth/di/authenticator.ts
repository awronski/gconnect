import type { DiCredentials, DiTicketProvider, DiTokenLifecycle, DiTokenSet } from "./contracts.js";

export class PrivateDiAuthenticator {
  readonly #tickets: DiTicketProvider;
  readonly #tokens: Pick<DiTokenLifecycle, "exchange" | "validate">;

  public constructor(
    tickets: DiTicketProvider,
    tokens: Pick<DiTokenLifecycle, "exchange" | "validate">
  ) {
    this.#tickets = tickets;
    this.#tokens = tokens;
  }

  public async authenticate(credentials: DiCredentials, signal?: AbortSignal): Promise<DiTokenSet> {
    const ticket = await this.#tickets.getTicket(credentials, signal);
    const tokens = await this.#tokens.exchange(ticket, signal);
    await this.#tokens.validate(tokens, signal);
    return tokens;
  }
}
