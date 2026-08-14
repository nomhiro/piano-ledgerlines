import path from "node:path";

export type BackendKind = "local" | "azure";
export type AuthMode = "development" | "entra" | "google";

export interface AppConfig {
  nodeEnv: string;
  authMode: AuthMode;
  repositoryBackend: BackendKind;
  storageBackend: BackendKind;
  queueBackend: BackendKind;
  dataDir: string;
  devUserId: string;
  entraIssuer?: string;
  entraAudience?: string;
  entraJwksUrl?: string;
  cosmosEndpoint?: string;
  cosmosKey?: string;
  cosmosDatabase: string;
  cosmosUsersContainer: string;
  cosmosClassroomsContainer: string;
  cosmosClassroomMembersContainer: string;
  cosmosClassroomInvitationsContainer: string;
  cosmosBillingEventsContainer: string;
  cosmosSongsContainer: string;
  cosmosTakesContainer: string;
  storageAccountUrl?: string;
  storageQueueUrl?: string;
  storageAccountName?: string;
  storageAccountKey?: string;
  storageConnectionString?: string;
  azureEmulator: boolean;
  deterministicAnalysis: boolean;
  scoresContainer: string;
  audioContainer: string;
  derivedContainer: string;
  analysisQueueName: string;
  sasLifetimeSeconds: number;
  foundryEnabled: boolean;
  foundryEndpoint?: string;
  foundryDeployment?: string;
  foundryModel: string;
  foundryApiVersion: string;
  coachPromptVersion: string;
  pipelineVersion: string;
  telemetryBackend: "none" | "console";
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripeClassroomBasePriceId?: string;
  stripeClassroomStudentPriceId?: string;
  ledgerlinesAppBaseUrl?: string;
}

let cachedConfig: AppConfig | undefined;

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

function backend(name: string, fallback: BackendKind): BackendKind {
  const value = process.env[name] ?? fallback;
  if (value !== "local" && value !== "azure") {
    throw new Error(`${name} must be "local" or "azure"`);
  }
  return value;
}

/**
 * Server-only configuration. Azure settings are required only when an Azure
 * backend is selected, so local development remains usable without secrets.
 */
export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const nodeEnv = process.env.NODE_ENV ?? "development";
  // Production deployments must explicitly opt into Entra. Next's build phase
  // is allowed to render local static pages without runtime credentials.
  const defaultAuthMode = nodeEnv === "production" && process.env.NEXT_PHASE !== "phase-production-build"
    ? "entra"
    : "development";
  const authMode = (process.env.LEDGERLINES_AUTH_MODE ?? defaultAuthMode) as AuthMode;
  if (authMode !== "development" && authMode !== "entra" && authMode !== "google") {
    throw new Error('LEDGERLINES_AUTH_MODE must be "development", "entra", or "google"');
  }

  const repositoryBackend = backend("LEDGERLINES_REPOSITORY", "local");
  const storageBackend = backend("LEDGERLINES_STORAGE", repositoryBackend);
  const queueBackend = backend("LEDGERLINES_QUEUE", "local");
  const azureRequired = repositoryBackend === "azure" || storageBackend === "azure" || queueBackend === "azure";
  const foundryEnabled = process.env.LEDGERLINES_FOUNDRY_ENABLED === "true";

  const config: AppConfig = {
    nodeEnv,
    authMode,
    repositoryBackend,
    storageBackend,
    queueBackend,
    dataDir: path.resolve(process.env.LEDGERLINES_DATA_DIR ?? path.join(process.cwd(), ".data")),
    devUserId: process.env.LEDGERLINES_DEV_USER_ID ?? "usr_local_dev",
    entraIssuer: process.env.ENTRA_ISSUER?.trim(),
    entraAudience: process.env.ENTRA_AUDIENCE?.trim(),
    entraJwksUrl: process.env.ENTRA_JWKS_URL?.trim(),
    cosmosEndpoint: process.env.AZURE_COSMOS_ENDPOINT?.trim(),
    cosmosKey: process.env.AZURE_COSMOS_KEY?.trim(),
    cosmosDatabase: process.env.AZURE_COSMOS_DATABASE ?? "ledgerlines",
    cosmosUsersContainer: process.env.AZURE_COSMOS_USERS_CONTAINER ?? "users",
    cosmosClassroomsContainer: process.env.AZURE_COSMOS_CLASSROOMS_CONTAINER ?? "classrooms",
    cosmosClassroomMembersContainer:
      process.env.AZURE_COSMOS_CLASSROOM_MEMBERS_CONTAINER ?? "classroom-members",
    cosmosClassroomInvitationsContainer:
      process.env.AZURE_COSMOS_CLASSROOM_INVITATIONS_CONTAINER ?? "classroom-invitations",
    cosmosBillingEventsContainer:
      process.env.AZURE_COSMOS_BILLING_EVENTS_CONTAINER ?? "billing-events",
    cosmosSongsContainer: process.env.AZURE_COSMOS_SONGS_CONTAINER ?? "songs",
    cosmosTakesContainer: process.env.AZURE_COSMOS_TAKES_CONTAINER ?? "takes",
    storageAccountUrl: process.env.AZURE_STORAGE_ACCOUNT_URL?.trim(),
    storageQueueUrl: process.env.AZURE_STORAGE_QUEUE_URL?.trim(),
    storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME?.trim(),
    storageAccountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY?.trim(),
    storageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING?.trim(),
    azureEmulator: process.env.LEDGERLINES_AZURE_EMULATOR === "true",
    deterministicAnalysis: process.env.LEDGERLINES_DETERMINISTIC_ANALYSIS === "true",
    scoresContainer: process.env.AZURE_STORAGE_SCORES_CONTAINER ?? "scores",
    audioContainer: process.env.AZURE_STORAGE_AUDIO_CONTAINER ?? "audio",
    derivedContainer: process.env.AZURE_STORAGE_DERIVED_CONTAINER ?? "derived",
    analysisQueueName: process.env.AZURE_ANALYSIS_QUEUE ?? "analysis-jobs",
    sasLifetimeSeconds: Number(process.env.AZURE_SAS_LIFETIME_SECONDS ?? "900"),
    foundryEnabled,
    foundryEndpoint: process.env.AZURE_FOUNDRY_ENDPOINT?.trim(),
    foundryDeployment: process.env.AZURE_FOUNDRY_DEPLOYMENT?.trim(),
    foundryModel: process.env.AZURE_FOUNDRY_MODEL ?? "configured-deployment",
    foundryApiVersion: process.env.AZURE_FOUNDRY_API_VERSION ?? "2024-10-21",
    coachPromptVersion: process.env.LEDGERLINES_COACH_PROMPT_VERSION ?? "coach-v1",
    pipelineVersion: process.env.LEDGERLINES_PIPELINE_VERSION ?? "pipeline-v1",
    telemetryBackend: process.env.LEDGERLINES_TELEMETRY === "console" ? "console" : "none",
    stripeSecretKey: process.env.STRIPE_SECRET_KEY?.trim(),
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim(),
    stripeClassroomBasePriceId: process.env.STRIPE_CLASSROOM_BASE_PRICE_ID?.trim(),
    stripeClassroomStudentPriceId: process.env.STRIPE_CLASSROOM_STUDENT_PRICE_ID?.trim(),
    ledgerlinesAppBaseUrl: process.env.LEDGERLINES_APP_BASE_URL?.trim(),
  };

  if (config.azureEmulator && nodeEnv === "production") {
    throw new Error("LEDGERLINES_AZURE_EMULATOR cannot be enabled in production");
  }
  if (process.env.LEDGERLINES_AZURE_CLOUD === "true" && nodeEnv === "production") {
    throw new Error("LEDGERLINES_AZURE_CLOUD is a local-development profile and cannot be enabled in production");
  }
  if (process.env.LEDGERLINES_AZURE_CLOUD === "true") {
    const forbiddenCloudSettings = [
      "LEDGERLINES_AZURE_EMULATOR",
      "AZURE_COSMOS_KEY",
      "AZURE_STORAGE_CONNECTION_STRING",
      "AZURE_STORAGE_ACCOUNT_KEY",
      "AZURE_CLIENT_ID",
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_SECRET",
    ].filter((name) => process.env[name] !== undefined);
    if (forbiddenCloudSettings.length) {
      throw new Error(`LEDGERLINES_AZURE_CLOUD forbids emulator flags and credential settings: ${forbiddenCloudSettings.join(", ")}`);
    }
  }
  if (authMode === "entra") {
    required("ENTRA_ISSUER", config.entraIssuer);
    required("ENTRA_AUDIENCE", config.entraAudience);
    required("ENTRA_JWKS_URL", config.entraJwksUrl);
  }
  if (azureRequired) {
    if (repositoryBackend === "azure") required("AZURE_COSMOS_ENDPOINT", config.cosmosEndpoint);
    if (repositoryBackend === "azure" && config.azureEmulator) {
      required("AZURE_COSMOS_KEY", config.cosmosKey);
    }
    if (storageBackend === "azure") {
      required("AZURE_STORAGE_ACCOUNT_URL", config.storageAccountUrl);
      required("AZURE_STORAGE_ACCOUNT_NAME", config.storageAccountName);
      if (config.azureEmulator) required("AZURE_STORAGE_CONNECTION_STRING", config.storageConnectionString);
      if (config.azureEmulator) required("AZURE_STORAGE_ACCOUNT_KEY", config.storageAccountKey);
    }
    if (queueBackend === "azure") {
      required("AZURE_STORAGE_ACCOUNT_URL", config.storageAccountUrl);
      required("AZURE_STORAGE_ACCOUNT_NAME", config.storageAccountName);
      if (!config.azureEmulator) required("AZURE_STORAGE_QUEUE_URL", config.storageQueueUrl ?? config.storageAccountUrl);
      if (config.azureEmulator) required("AZURE_STORAGE_CONNECTION_STRING", config.storageConnectionString);
      if (config.azureEmulator) required("AZURE_STORAGE_ACCOUNT_KEY", config.storageAccountKey);
    }
  }
  if (!config.azureEmulator && (config.cosmosKey || config.storageConnectionString || config.storageAccountKey)) {
    throw new Error("emulator credentials are only allowed when LEDGERLINES_AZURE_EMULATOR=true");
  }
  if (foundryEnabled) {
    required("AZURE_FOUNDRY_ENDPOINT", config.foundryEndpoint);
    required("AZURE_FOUNDRY_DEPLOYMENT", config.foundryDeployment);
  }
  if (!Number.isInteger(config.sasLifetimeSeconds) || config.sasLifetimeSeconds < 60 || config.sasLifetimeSeconds > 3600) {
    throw new Error("AZURE_SAS_LIFETIME_SECONDS must be an integer between 60 and 3600");
  }

  cachedConfig = config;
  return config;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}
