import { resolve } from "node:path";
import { gconnectPrivateDirectory } from "./auth/paths.js";
import { FileAuthState } from "./auth/auth-state.js";
import {
  FetchDiHttpClient,
  FileDiTokenStore,
  DiSessionManager,
  DiTokenClient,
  MobileSsoTicketProvider,
  PrivateDiAuthenticator
} from "./auth/di/index.js";
import { ProcessAuthInput } from "./auth/auth-input.js";
import { GarminAuthService } from "./auth/auth-service.js";
import { BrowserRecoveryRunner, WebCookieRecoveryVerifier } from "./auth/recovery/index.js";
import { FileWebSessionStore } from "./auth/web/web-session-store.js";
import { StoredWebSessionManager } from "./auth/web/web-session-manager.js";
import { CliApplication } from "./cli/application.js";
import { CommandRegistry } from "./cli/command-registry.js";
import { systemClock } from "./core/clock.js";
import { WebGarminDownloadService } from "./download/web-garmin-download-service.js";
import { DiGarminDownloadService } from "./download/di-garmin-download-service.js";
import { AutoGarminDownloadService } from "./download/auto-garmin-download-service.js";
import { apiFeature } from "./features/api/api-feature.js";
import { createAuthFeature } from "./features/auth/auth-feature.js";
import { activitiesFeature } from "./features/activities/index.js";
import type { FeatureModule } from "./features/feature.js";
import { healthFeature } from "./features/health/feature.js";
import { performanceFeature } from "./features/performance/feature.js";
import { createSystemFeature } from "./features/system/system-feature.js";
import { JsonOutputService, type TextSink } from "./output/output-service.js";
import { processingToolkit } from "./processing/processing-toolkit.js";
import { VERSION } from "./version.js";

export interface CompositionOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly stdout?: TextSink;
  readonly stderr?: TextSink;
}

export function createApplication(options: CompositionOptions = {}): CliApplication {
  const environment = options.environment ?? process.env;
  const fetchImplementation = options.fetch ?? fetch;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const configuredTestOrigin = environment.NODE_ENV === "test" ? environment.GCONNECT_TEST_ORIGIN : undefined;
  const testOrigin = configuredTestOrigin === undefined ? undefined : assertLoopbackTestOrigin(configuredTestOrigin);
  const privateDirectory = gconnectPrivateDirectory();
  const webStore = new FileWebSessionStore(resolve(privateDirectory, "web-session.json"));
  const diStore = new FileDiTokenStore(resolve(privateDirectory, "di-session.json"));
  const authState = new FileAuthState(
    resolve(privateDirectory, "active-backend.json"),
    resolve(privateDirectory, "auth-state.lock")
  );
  const diHttp = new FetchDiHttpClient(fetchImplementation);
  const diTokens = new DiTokenClient({
    http: diHttp,
    ...(testOrigin === undefined ? {} : {
      tokenUrl: `${testOrigin}/di-oauth2-service/oauth/token`,
      apiBaseUrl: testOrigin
    })
  });
  const diSessions = new DiSessionManager({ store: diStore, lifecycle: diTokens, authState });
  const webSessions = new StoredWebSessionManager({
    store: webStore,
    fetch: fetchImplementation,
    authState,
    ...(testOrigin === undefined ? {} : { applicationOrigin: testOrigin })
  });
  const webDownload = new WebGarminDownloadService({
    sessions: webSessions,
    fetch: fetchImplementation,
    ...(testOrigin === undefined ? {} : { origin: testOrigin })
  });
  const diDownload = new DiGarminDownloadService({
    sessions: diSessions,
    http: diHttp,
    ...(testOrigin === undefined ? {} : { apiBaseUrl: testOrigin })
  });
  const download = new AutoGarminDownloadService({
    di: diDownload,
    web: webDownload,
    authState
  });
  const authInput = new ProcessAuthInput({ environment });
  const recoveryVerifier = new WebCookieRecoveryVerifier({
    store: webStore,
    fetch: fetchImplementation,
    ...(testOrigin === undefined ? {} : { applicationOrigin: testOrigin })
  });
  const recovery = new BrowserRecoveryRunner({
    verifier: recoveryVerifier,
    stderr,
    environment
  });
  const auth = new GarminAuthService({
    input: authInput,
    authenticator: (passwordStdin) => new PrivateDiAuthenticator(
      new MobileSsoTicketProvider({
        http: diHttp,
        promptMfaCode: ({ method }) => authInput.readMfaCode(method, passwordStdin),
        ...(testOrigin === undefined ? {} : {
          loginUrl: `${testOrigin}/mobile/api/login`,
          mfaUrl: `${testOrigin}/mobile/api/mfa/verifyCode`
        })
      }),
      diTokens
    ),
    diStore,
    diSessions,
    diTokens,
    webSessions,
    authState,
    recovery,
    onBackendChanged: () => download.reset()
  });

  let registry: CommandRegistry;
  const systemFeature = createSystemFeature({ contracts: () => registry.contracts() });
  const features: readonly FeatureModule[] = [
    createAuthFeature(auth),
    activitiesFeature,
    healthFeature,
    performanceFeature,
    apiFeature,
    systemFeature
  ];
  registry = new CommandRegistry(features);
  return new CliApplication({
    registry,
    context: { download, processing: processingToolkit, clock: systemClock },
    output: new JsonOutputService(stdout, privateDirectory),
    version: VERSION,
    recoverAuth: async () => {
      await auth.recover({ timeoutMs: 300_000, openBrowser: false });
    },
    interactive: authInput.interactive
  });
}

function assertLoopbackTestOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("GCONNECT_TEST_ORIGIN is restricted to an HTTP loopback origin");
  }
  return url.origin;
}
