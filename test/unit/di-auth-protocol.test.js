import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import test from "node:test";

import {
  DEFAULT_DI_CLIENT_IDS,
  DI_API_BASE_URL,
  DI_REDACTED,
  DI_SERVICE_TICKET_GRANT,
  DI_TOKEN_URL,
  DiTokenClient,
  FetchDiHttpClient,
  MOBILE_SSO_CLIENT_ID,
  MOBILE_SSO_LOGIN_URL,
  MOBILE_SSO_MFA_URL,
  MOBILE_SSO_SERVICE_URL,
  MobileSsoTicketProvider,
  PrivateDiAuthenticator,
  decodeDiTokenResponse,
  decodeMobileLoginResponse,
  redactDiAuthText,
  redactDiAuthValue
} from "../../dist/auth/di/index.js";
import { DiGarminDownloadService } from "../../dist/download/di-garmin-download-service.js";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

test("mobile SSO returns a service ticket and sends the exact iOS login contract", async () => {
  const http = new QueueHttp([
    jsonResponse(200, { responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-one-time" })
  ]);
  const provider = new MobileSsoTicketProvider({ http });

  const ticket = await provider.getTicket({ username: "person@example.test", password: "private-password" });

  assert.deepEqual(ticket, { value: "ST-one-time", serviceUrl: MOBILE_SSO_SERVICE_URL });
  assert.equal(http.requests.length, 1);
  const request = http.requests[0];
  const url = new URL(request.url);
  assert.equal(`${url.origin}${url.pathname}`, MOBILE_SSO_LOGIN_URL);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    clientId: MOBILE_SSO_CLIENT_ID,
    locale: "en-US",
    service: MOBILE_SSO_SERVICE_URL
  });
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Origin, "https://sso.garmin.com");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.deepEqual(request.body, {
    kind: "json",
    value: {
      username: "person@example.test",
      password: "private-password",
      rememberMe: true,
      captchaToken: ""
    }
  });
});

test("fetch adapter is injectable and preserves form encoding plus separate SSO cookies", async () => {
  const calls = [];
  const http = new FetchDiHttpClient(async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", {
      status: 200,
      headers: [["Content-Type", "application/json"], ["Set-Cookie", "first=1; Path=/"], ["Set-Cookie", "second=2; Path=/"]]
    });
  });

  const response = await http.request({
    method: "POST",
    url: "https://example.test/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: { kind: "form", value: { grant_type: "refresh_token", client_id: "client id" } },
    timeoutMs: 1_000,
    signal: undefined
  });

  assert.equal(calls[0].url, "https://example.test/token");
  assert.equal(calls[0].init.body, "grant_type=refresh_token&client_id=client+id");
  assert.deepEqual(response.setCookieHeaders, ["first=1; Path=/", "second=2; Path=/"]);
});

test("fetch adapter rejects a declared response larger than its byte limit", async () => {
  const http = new FetchDiHttpClient(async () => new Response("unused", {
    status: 200,
    headers: { "Content-Length": "6" }
  }), 5);

  await assert.rejects(
    http.request(getRequest()),
    (error) => error.code === "RESPONSE_TOO_LARGE" && error.details.maximumBytes === 5
  );
});

test("fetch adapter stops an undeclared streamed response at its byte limit", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("123"));
      controller.enqueue(new TextEncoder().encode("456"));
    },
    cancel() {
      cancelled = true;
    }
  });
  const http = new FetchDiHttpClient(async () => new Response(body, { status: 200 }), 5);

  await assert.rejects(
    http.request(getRequest()),
    (error) => error.code === "RESPONSE_TOO_LARGE" && error.details.maximumBytes === 5
  );
  assert.equal(cancelled, true);
});

test("fetch adapter never follows a redirect that could replay authentication secrets", async (t) => {
  let targetRequests = 0;
  const target = await listen(t, (_request, response) => {
    targetRequests += 1;
    response.end("unexpected");
  });
  const redirect = await listen(t, (_request, response) => {
    response.writeHead(307, { location: `${target}/stolen` });
    response.end();
  });
  const http = new FetchDiHttpClient();
  const response = await http.request({
    method: "POST",
    url: `${redirect}/login`,
    headers: { "Content-Type": "application/json" },
    body: { kind: "json", value: { username: "person@example.test", password: "private" } },
    timeoutMs: 1_000,
    signal: undefined
  });
  assert.equal(response.status, 307);
  assert.equal(targetRequests, 0);
});

test("mobile SSO preserves response-size classification instead of reporting a network failure", async () => {
  const http = new FetchDiHttpClient(async () => new Response(
    "{\"responseStatus\":{\"type\":\"SUCCESSFUL\"}}",
    { status: 200 }
  ), 8);
  const provider = new MobileSsoTicketProvider({ http });

  await assert.rejects(
    provider.getTicket({ username: "person@example.test", password: "pw" }),
    (error) => error.code === "RESPONSE_TOO_LARGE"
  );
});

test("DI downloads do not retry or rewrite response-size failures", async () => {
  let calls = 0;
  const http = new FetchDiHttpClient(async () => {
    calls += 1;
    return new Response("123456", { status: 200 });
  }, 5);
  const service = new DiGarminDownloadService({
    http,
    sessions: { async runWithSession(operation) { return operation(tokenSet()); } }
  });

  await assert.rejects(
    service.json({ path: "/gc-api/example-service/data", decode: (value) => value }),
    (error) => error.code === "RESPONSE_TOO_LARGE"
  );
  assert.equal(calls, 1);
});

test("DI downloader rejects unsafe profile path segments and preserves 404 failures", async () => {
  const sessions = { async runWithSession(operation) { return operation(tokenSet()); } };
  const unsafeProfile = new DiGarminDownloadService({
    sessions,
    http: new QueueHttp([jsonResponse(200, { displayName: "../escaped?path" })])
  });
  await assert.rejects(
    unsafeProfile.optionalJson({
      path: "/gc-api/sleep-service/sleep/dailySleepData",
      diPath: "/wellness-service/wellness/dailySleepData/{profileId}",
      decode: (value) => value
    }),
    (error) => error.code === "PROTOCOL_CHANGED"
  );

  const missing = new DiGarminDownloadService({
    sessions,
    http: new QueueHttp([jsonResponse(404, {})])
  });
  await assert.rejects(
    missing.optionalJson({ path: "/gc-api/example-service/missing", decode: (value) => value }),
    (error) => error.code === "NOT_FOUND"
  );
});

test("DI downloader expands only feature-declared generic profile routes", async () => {
  const http = new QueueHttp([
    jsonResponse(200, { displayName: "profile_12345678" }),
    jsonResponse(200, { ok: true })
  ]);
  const service = new DiGarminDownloadService({
    sessions: { async runWithSession(operation) { return operation(tokenSet()); } },
    http
  });
  assert.deepEqual(await service.json({
    path: "/gc-api/example-service/data",
    diPath: "/example-service/profile/{profileId}/data",
    decode: (value) => value
  }), { ok: true });
  assert.equal(new URL(http.requests[1].url).pathname, "/example-service/profile/profile_12345678/data");

  await assert.rejects(
    service.json({
      path: "/gc-api/example-service/data",
      diPath: "/example-service/{unknown}/data",
      decode: (value) => value
    }),
    (error) => error.code === "INTERNAL_CONTRACT_ERROR"
  );
});

test("DI non-optional 204 responses are decoded as null like web responses", async () => {
  const service = new DiGarminDownloadService({
    sessions: { async runWithSession(operation) { return operation(tokenSet()); } },
    http: new QueueHttp([textResponse(204, "")])
  });
  assert.equal(
    await service.json({ path: "/gc-api/example-service/empty", decode: (value) => value }),
    null
  );
});

test("mobile SSO completes MFA with the injected prompt and same SSO service", async () => {
  const prompts = [];
  const http = new QueueHttp([
    jsonResponse(200, {
      responseStatus: { type: "MFA_REQUIRED" },
      customerMfaInfo: { mfaLastMethodUsed: "email" }
    }, {}, ["GARMIN-SSO=session-secret; Path=/; Secure; HttpOnly"]),
    jsonResponse(200, { responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-after-mfa" })
  ]);
  const provider = new MobileSsoTicketProvider({
    http,
    async promptMfaCode(challenge) {
      prompts.push(challenge);
      return " 123456 ";
    }
  });

  const ticket = await provider.getTicket({ username: "person@example.test", password: "pw" });

  assert.equal(ticket.value, "ST-after-mfa");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].method, "email");
  const request = http.requests[1];
  const url = new URL(request.url);
  assert.equal(`${url.origin}${url.pathname}`, MOBILE_SSO_MFA_URL);
  assert.equal(url.searchParams.get("service"), MOBILE_SSO_SERVICE_URL);
  assert.equal(request.headers.Cookie, "GARMIN-SSO=session-secret");
  assert.deepEqual(request.body, {
    kind: "json",
    value: {
      mfaMethod: "email",
      mfaVerificationCode: "123456",
      rememberMyBrowser: true,
      reconsentList: [],
      mfaSetup: false
    }
  });
});

test("mobile SSO preserves CAPTCHA classification when it appears after MFA", async () => {
  const http = new QueueHttp([
    jsonResponse(200, {
      responseStatus: { type: "MFA_REQUIRED" },
      customerMfaInfo: { mfaLastMethodUsed: "email" }
    }),
    jsonResponse(200, { responseStatus: { type: "CAPTCHA_REQUIRED" } })
  ]);
  const provider = new MobileSsoTicketProvider({ http, async promptMfaCode() { return "123456"; } });

  await assert.rejects(
    provider.getTicket({ username: "person@example.test", password: "pw" }),
    (error) => error.code === "DI_CAPTCHA_REQUIRED"
  );
});

test("mobile SSO classifies credential, MFA, CAPTCHA, rate-limit, challenge, and network failures", async (t) => {
  const cases = [
    {
      name: "invalid credentials",
      response: jsonResponse(200, { responseStatus: { type: "INVALID_USERNAME_PASSWORD" } }),
      code: "DI_INVALID_CREDENTIALS"
    },
    {
      name: "CAPTCHA",
      response: jsonResponse(200, { responseStatus: { type: "CAPTCHA_REQUIRED" } }),
      code: "DI_CAPTCHA_REQUIRED"
    },
    {
      name: "MFA without a prompt",
      response: jsonResponse(200, {
        responseStatus: { type: "MFA_REQUIRED" },
        customerMfaInfo: { mfaLastMethodUsed: "email" }
      }),
      code: "DI_MFA_REQUIRED"
    },
    { name: "HTTP rate limit", response: textResponse(429, "slow down"), code: "DI_RATE_LIMITED" },
    { name: "nested rate limit", response: jsonResponse(200, { error: { "status-code": "429" } }), code: "DI_RATE_LIMITED" },
    { name: "HTTP challenge", response: textResponse(403, "blocked"), code: "DI_BOT_CHALLENGE" },
    {
      name: "HTML challenge",
      response: textResponse(200, "<!doctype html><title>challenge</title>", { "content-type": "text/html" }),
      code: "DI_BOT_CHALLENGE"
    },
    { name: "server failure", response: textResponse(503, "unavailable"), code: "DI_SERVICE_UNAVAILABLE" }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const provider = new MobileSsoTicketProvider({ http: new QueueHttp([item.response]) });
      await assert.rejects(
        provider.getTicket({ username: "person@example.test", password: "pw" }),
        (error) => error.code === item.code
      );
    });
  }

  await t.test("network failure", async () => {
    const provider = new MobileSsoTicketProvider({
      http: { async request() { throw new Error("socket closed"); } }
    });
    await assert.rejects(
      provider.getTicket({ username: "person@example.test", password: "pw" }),
      (error) => error.code === "DI_NETWORK_ERROR" && error.retryable === true
    );
  });
});

test("strict mobile and token decoders reject malformed or unknown contracts", () => {
  assert.throws(
    () => decodeMobileLoginResponse({ responseStatus: { type: "NEW_FLOW" } }),
    (error) => error.code === "DI_PROTOCOL_CHANGED"
  );
  assert.throws(
    () => decodeMobileLoginResponse({ responseStatus: { type: "SUCCESSFUL" } }),
    (error) => error.code === "DI_PROTOCOL_CHANGED"
  );
  assert.throws(
    () => decodeDiTokenResponse({ access_token: "token", token_type: "mac" }),
    (error) => error.code === "DI_PROTOCOL_CHANGED"
  );
  assert.throws(
    () => decodeDiTokenResponse({ access_token: "", expires_in: -1 }),
    (error) => error.code === "DI_PROTOCOL_CHANGED"
  );
});

test("ticket exchange tries candidate client IDs and returns a strict token set", async () => {
  const issuedToken = jwt({ client_id: "issued-client-id", exp: Math.floor((NOW + 7_200_000) / 1_000) });
  const http = new QueueHttp([
    jsonResponse(400, { error: "unsupported_client" }),
    jsonResponse(200, {
      access_token: issuedToken,
      refresh_token: "refresh-one",
      expires_in: 3600,
      refresh_token_expires_in: 7200,
      token_type: "bearer"
    })
  ]);
  const client = new DiTokenClient({ http, now: () => NOW });

  const tokens = await client.exchange({ value: "ST-ticket", serviceUrl: MOBILE_SSO_SERVICE_URL });

  assert.equal(http.requests.length, 2);
  for (const [index, request] of http.requests.entries()) {
    const expectedClientId = DEFAULT_DI_CLIENT_IDS[index];
    assert.equal(request.url, DI_TOKEN_URL);
    assert.equal(
      request.headers.Authorization,
      `Basic ${Buffer.from(`${expectedClientId}:`, "utf8").toString("base64")}`
    );
    assert.deepEqual(request.body, {
      kind: "form",
      value: {
        client_id: expectedClientId,
        service_ticket: "ST-ticket",
        grant_type: DI_SERVICE_TICKET_GRANT,
        service_url: MOBILE_SSO_SERVICE_URL
      }
    });
  }
  assert.deepEqual(tokens, {
    backend: "private-di",
    accessToken: issuedToken,
    refreshToken: "refresh-one",
    clientId: "issued-client-id",
    accessExpiresAtEpochMs: NOW + 3_600_000,
    refreshExpiresAtEpochMs: NOW + 7_200_000
  });
});

test("private authenticator composes ticket acquisition, exchange, and API-tier validation", async () => {
  const events = [];
  const tickets = {
    async getTicket(credentials) {
      events.push(["ticket", credentials.username]);
      return { value: "ST-ticket", serviceUrl: MOBILE_SSO_SERVICE_URL };
    }
  };
  const expected = tokenSet();
  const tokens = {
    async exchange(ticket) {
      events.push(["exchange", ticket.value]);
      return expected;
    },
    async validate(value) {
      events.push(["validate", value.accessToken]);
    }
  };
  const authenticator = new PrivateDiAuthenticator(tickets, tokens);

  assert.equal(
    await authenticator.authenticate({ username: "person@example.test", password: "pw" }),
    expected
  );
  assert.deepEqual(events, [
    ["ticket", "person@example.test"],
    ["exchange", "ST-ticket"],
    ["validate", "access-token"]
  ]);
});

test("refresh uses the stored client and refresh token, accepts rotation, and validation uses DI bearer", async () => {
  const http = new QueueHttp([
    jsonResponse(200, {
      access_token: jwt({ client_id: "client-id", exp: Math.floor((NOW + 3_600_000) / 1_000) }),
      refresh_token: "rotated-refresh",
      expires_in: 1800,
      token_type: "bearer"
    }),
    jsonResponse(200, { displayName: "profile" })
  ]);
  const client = new DiTokenClient({ http, now: () => NOW });
  const old = tokenSet({ refreshToken: "old-refresh", clientId: "client-id" });

  const refreshed = await client.refresh(old);
  await client.validate(refreshed);

  assert.deepEqual(http.requests[0].body, {
    kind: "form",
    value: { grant_type: "refresh_token", client_id: "client-id", refresh_token: "old-refresh" }
  });
  assert.equal(refreshed.refreshToken, "rotated-refresh");
  assert.equal(refreshed.accessExpiresAtEpochMs, NOW + 1_800_000);
  assert.equal(http.requests[1].url, `${DI_API_BASE_URL}/userprofile-service/socialProfile`);
  assert.equal(http.requests[1].headers.Authorization, `Bearer ${refreshed.accessToken}`);
  assert.equal(http.requests[1].headers["X-Garmin-Client-Platform"], "Android");
});

test("token client classifies exhausted clients, rejected refresh, rejected bearer, and rate limiting", async (t) => {
  await t.test("all candidate clients rejected", async () => {
    const client = new DiTokenClient({
      http: new QueueHttp([jsonResponse(400, {}), jsonResponse(401, {})]),
      clientIds: ["first", "second"]
    });
    await assert.rejects(
      client.exchange({ value: "ST-ticket", serviceUrl: MOBILE_SSO_SERVICE_URL }),
      (error) => error.code === "DI_TOKEN_EXCHANGE_FAILED" && error.context.candidateCount === 2
    );
  });
  await t.test("refresh rejected", async () => {
    const client = new DiTokenClient({ http: new QueueHttp([jsonResponse(400, {})]) });
    await assert.rejects(client.refresh(tokenSet()), (error) => error.code === "DI_REFRESH_REJECTED");
  });
  await t.test("access token rejected", async () => {
    const client = new DiTokenClient({ http: new QueueHttp([jsonResponse(401, {})]) });
    await assert.rejects(client.validate(tokenSet()), (error) => error.code === "DI_TOKEN_REJECTED");
  });
  await t.test("exchange rate limited", async () => {
    const client = new DiTokenClient({ http: new QueueHttp([jsonResponse(429, {})]) });
    await assert.rejects(
      client.exchange({ value: "ST-ticket", serviceUrl: MOBILE_SSO_SERVICE_URL }),
      (error) => error.code === "DI_RATE_LIMITED" && error.retryable === true
    );
  });
});

test("DI redaction removes headers, tickets, credentials, codes, and nested tokens", () => {
  const text = redactDiAuthText(
    "Authorization: Bearer abc.def service_ticket=ST-secret username=user@example.test password=hunter2"
  );
  assert.doesNotMatch(text, /abc\.def|ST-secret|user@example\.test|hunter2/);
  assert.match(text, /\[REDACTED\]/);

  assert.deepEqual(
    redactDiAuthValue({
      Authorization: "Basic encoded-secret",
      profile: { username: "person@example.test", harmless: "visible" },
      access_token: "access-secret",
      mfaVerificationCode: "123456"
    }),
    {
      Authorization: DI_REDACTED,
      profile: { username: DI_REDACTED, harmless: "visible" },
      access_token: DI_REDACTED,
      mfaVerificationCode: DI_REDACTED
    }
  );
});

class QueueHttp {
  constructor(responses) {
    this.responses = [...responses];
    this.requests = [];
  }

  async request(request) {
    this.requests.push(request);
    const response = this.responses.shift();
    assert.ok(response, "unexpected HTTP request");
    return response;
  }
}

function jsonResponse(status, value, headers = {}, setCookieHeaders = []) {
  return textResponse(status, JSON.stringify(value), { "content-type": "application/json", ...headers }, setCookieHeaders);
}

function textResponse(status, bodyText, headers = {}, setCookieHeaders = []) {
  return { status, headers, setCookieHeaders, bodyText };
}

function jwt(payload) {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedHeader}.${encodedPayload}.signature`;
}

function tokenSet(overrides = {}) {
  return {
    backend: "private-di",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    clientId: "client-id",
    accessExpiresAtEpochMs: NOW + 3_600_000,
    refreshExpiresAtEpochMs: NOW + 7_200_000,
    ...overrides
  };
}

function getRequest() {
  return {
    method: "GET",
    url: "https://example.test/data",
    headers: {},
    body: null,
    timeoutMs: 1_000,
    signal: undefined
  };
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}
