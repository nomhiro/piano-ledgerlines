import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DefaultAzureCredential } from "@azure/identity";
import { CosmosClient } from "@azure/cosmos";
import { BlobServiceClient } from "@azure/storage-blob";
import { QueueClient } from "@azure/storage-queue";
import { getConfig, resetConfigForTests } from "../src/lib/server/config";
import { createAzureCredential } from "../src/lib/server/azure-credential";

const root = process.cwd();
const profilePath = path.join(root, ".env.local.azure-cloud");

function loadDotEnv(): void {
  if (!fs.existsSync(profilePath)) {
    throw new Error("Copy .env.local.azure-cloud.example to .env.local.azure-cloud first");
  }
  for (const line of fs.readFileSync(profilePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    if (value && process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function parseShellValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    const raw = match[2].trim();
    try {
      values[match[1]] = raw.startsWith("\"") ? JSON.parse(raw) as string : raw.replace(/^'(.*)'$/, "$1");
    } catch {
      values[match[1]] = raw.replace(/^"(.*)"$/, "$1");
    }
  }
  return values;
}

function runAzd(args: string[]): Record<string, string> {
  try {
    return parseShellValues(execFileSync("azd", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }));
  } catch {
    return {};
  }
}

function collectDeploymentOutputs(value: unknown, result: Record<string, string>): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object" && "value" in child) {
      const outputValue = (child as { value?: unknown }).value;
      if (typeof outputValue === "string" || typeof outputValue === "number" || typeof outputValue === "boolean") {
        result[key] = String(outputValue);
        continue;
      }
    }
    collectDeploymentOutputs(child, result);
  }
}

function runDeploymentOutputs(envValues: Record<string, string>): Record<string, string> {
  const resourceGroup = select(envValues, ["AZURE_RESOURCE_GROUP", "resourceGroupName", "resourceGroup"]);
  if (!resourceGroup) return {};
  try {
    const subscription = select(envValues, ["AZURE_SUBSCRIPTION_ID", "subscriptionId"]);
    const args = ["deployment", "group", "list", "--resource-group", resourceGroup, "--output", "json"];
    if (subscription) args.push("--subscription", subscription);
    const output = execFileSync("az", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const deployments = JSON.parse(output) as Array<{ properties?: { outputs?: unknown; timestamp?: string } }>;
    const latest = deployments
      .filter((deployment) => deployment.properties?.outputs)
      .sort((left, right) => String(left.properties?.timestamp ?? "").localeCompare(String(right.properties?.timestamp ?? "")))
      .at(-1);
    const values: Record<string, string> = {};
    collectDeploymentOutputs(latest?.properties?.outputs, values);
    return values;
  } catch {
    return {};
  }
}

function normalized(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function select(values: Record<string, string>, names: string[]): string | undefined {
  const entries = new Map(Object.entries(values).map(([key, value]) => [normalized(key), value]));
  for (const name of names) {
    const value = entries.get(normalized(name));
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function loadAzdOutputs(): void {
  const environment = process.env.AZD_ENV_NAME;
  const selectedValues = environment ? runAzd(["env", "get-values", "--environment", environment]) : {};
  const envValues = Object.keys(selectedValues).length
    ? selectedValues
    : runAzd(["env", "get-values"]);
  const values = { ...envValues, ...runDeploymentOutputs(envValues) };
  const aliases: Record<string, string[]> = {
    AZURE_COSMOS_ENDPOINT: ["AZURE_COSMOS_ENDPOINT", "cosmosEndpoint", "cosmosEndpointUrl"],
    AZURE_COSMOS_DATABASE: ["AZURE_COSMOS_DATABASE", "cosmosDatabaseName", "databaseName"],
    AZURE_STORAGE_ACCOUNT_URL: ["AZURE_STORAGE_ACCOUNT_URL", "storageAccountUrl", "storageBlobEndpoint"],
    AZURE_STORAGE_QUEUE_URL: ["AZURE_STORAGE_QUEUE_URL", "storageQueueUrl", "storageQueueEndpoint", "queueEndpoint"],
    AZURE_STORAGE_ACCOUNT_NAME: ["AZURE_STORAGE_ACCOUNT_NAME", "storageAccountName"],
    AZURE_ANALYSIS_QUEUE: ["AZURE_ANALYSIS_QUEUE", "analysisQueueName"],
    AZURE_FOUNDRY_ENDPOINT: ["AZURE_FOUNDRY_ENDPOINT", "foundryEndpoint"],
    AZURE_FOUNDRY_DEPLOYMENT: ["AZURE_FOUNDRY_DEPLOYMENT", "foundryDeploymentName", "deploymentName"],
    AZURE_FOUNDRY_MODEL: ["AZURE_FOUNDRY_MODEL", "foundryModelName", "modelName"],
    LEDGERLINES_FOUNDRY_ENABLED: ["LEDGERLINES_FOUNDRY_ENABLED", "foundryEnabled"],
  };
  for (const [target, names] of Object.entries(aliases)) {
    if (process.env[target] === undefined) {
      const value = select(values, names);
      if (value !== undefined) process.env[target] = value;
    }
  }
  if (!process.env.AZURE_STORAGE_QUEUE_URL && process.env.AZURE_STORAGE_ACCOUNT_URL) {
    process.env.AZURE_STORAGE_QUEUE_URL = process.env.AZURE_STORAGE_ACCOUNT_URL.replace(".blob.", ".queue.");
  }
  if (!process.env.AZURE_STORAGE_ACCOUNT_NAME && process.env.AZURE_STORAGE_ACCOUNT_URL) {
    try {
      process.env.AZURE_STORAGE_ACCOUNT_NAME = new URL(process.env.AZURE_STORAGE_ACCOUNT_URL).hostname.split(".")[0];
    } catch {
      // Validation below reports the malformed endpoint.
    }
  }
}

function assertCloudProfile(): ReturnType<typeof getConfig> {
  const forbidden = [
    "LEDGERLINES_AZURE_EMULATOR",
    "AZURE_COSMOS_KEY",
    "AZURE_STORAGE_CONNECTION_STRING",
    "AZURE_STORAGE_ACCOUNT_KEY",
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_SECRET",
  ];
  const present = forbidden.filter((name) => process.env[name] !== undefined);
  if (present.length) throw new Error(`Cloud local profile forbids emulator flags and secrets: ${present.join(", ")}`);
  if (process.env.LEDGERLINES_AZURE_CLOUD !== "true") {
    throw new Error("LEDGERLINES_AZURE_CLOUD=true is required for the cloud-backed local profile");
  }
  if (process.env.LEDGERLINES_AUTH_MODE !== "development") {
    throw new Error("The cloud-backed local profile must use explicit development auth");
  }
  for (const name of ["LEDGERLINES_REPOSITORY", "LEDGERLINES_STORAGE", "LEDGERLINES_QUEUE"]) {
    if (process.env[name] !== "azure") throw new Error(`${name}=azure is required for the cloud-backed local profile`);
  }
  resetConfigForTests();
  const config = getConfig();
  for (const [name, endpoint] of [
    ["AZURE_COSMOS_ENDPOINT", config.cosmosEndpoint],
    ["AZURE_STORAGE_ACCOUNT_URL", config.storageAccountUrl],
    ["AZURE_STORAGE_QUEUE_URL", config.storageQueueUrl],
  ] as const) {
    if (!endpoint) throw new Error(`${name} is missing; run azd provision and ensure its output is available`);
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || /localhost|127\.0\.0\.1/i.test(parsed.hostname)) {
      throw new Error(`${name} must be an HTTPS Azure endpoint, not an emulator endpoint`);
    }
  }
  if (config.foundryEnabled) {
    const endpoint = new URL(config.foundryEndpoint!);
    if (endpoint.protocol !== "https:") throw new Error("AZURE_FOUNDRY_ENDPOINT must use HTTPS");
  }
  return config;
}

async function checkDataPlane(config: ReturnType<typeof getConfig>, credential: DefaultAzureCredential): Promise<void> {
  const failures: string[] = [];
  const check = async (name: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`FAIL ${name}`);
    }
  };

  await check("Azure CLI authentication", async () => {
    if (!(await credential.getToken("https://management.azure.com/.default"))) throw new Error("token unavailable");
  });

  const cosmos = new CosmosClient({ endpoint: config.cosmosEndpoint!, aadCredentials: credential });
  const database = cosmos.database(config.cosmosDatabase);
  await check(`Cosmos database ${config.cosmosDatabase}`, async () => { await database.read(); });
  for (const containerName of [
    config.cosmosUsersContainer,
    config.cosmosClassroomsContainer,
    config.cosmosClassroomMembersContainer,
    config.cosmosClassroomInvitationsContainer,
    config.cosmosBillingEventsContainer,
    config.cosmosSongsContainer,
    config.cosmosTakesContainer,
  ]) {
    await check(`Cosmos container ${containerName}`, async () => { await database.container(containerName).read(); });
  }

  const blobs = new BlobServiceClient(config.storageAccountUrl!, credential);
  for (const containerName of [config.scoresContainer, config.audioContainer, config.derivedContainer]) {
    await check(`Blob container ${containerName}`, async () => {
      await blobs.getContainerClient(containerName).getProperties();
    });
  }

  const queueUrl = `${config.storageQueueUrl!.replace(/\/$/, "")}/${config.analysisQueueName}`;
  await check(`Storage Queue ${config.analysisQueueName}`, async () => {
    await new QueueClient(queueUrl, credential).getProperties();
  });

  if (config.foundryEnabled) {
    await check("Foundry endpoint and RBAC", async () => {
      const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
      if (!token) throw new Error("Foundry token unavailable");
      const response = await fetch(`${config.foundryEndpoint!.replace(/\/$/, "")}/openai/deployments?api-version=${encodeURIComponent(config.foundryApiVersion)}`, {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      if (!response.ok) throw new Error(`Foundry returned HTTP ${response.status}`);
    });
  } else {
    console.log("SKIP Foundry (LEDGERLINES_FOUNDRY_ENABLED=false)");
  }

  if (failures.length) {
    throw new Error(`Azure cloud preflight failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

async function initializeResources(config: ReturnType<typeof getConfig>, credential: DefaultAzureCredential): Promise<void> {
  console.log("Initializing missing data-plane resources only (no deletes or resets).");
  const cosmos = new CosmosClient({ endpoint: config.cosmosEndpoint!, aadCredentials: credential });
  const database = (await cosmos.databases.createIfNotExists({ id: config.cosmosDatabase })).database;
  for (const [id, partitionKey] of [
    [config.cosmosUsersContainer, "/id"],
    [config.cosmosClassroomsContainer, "/id"],
    [config.cosmosClassroomMembersContainer, "/classroomId"],
    [config.cosmosClassroomInvitationsContainer, "/classroomId"],
    [config.cosmosBillingEventsContainer, "/id"],
    [config.cosmosSongsContainer, "/userId"],
    [config.cosmosTakesContainer, "/userId"],
  ] as const) {
    await database.containers.createIfNotExists({ id, partitionKey: { paths: [partitionKey] } });
  }
  const blobs = new BlobServiceClient(config.storageAccountUrl!, credential);
  for (const id of [config.scoresContainer, config.audioContainer, config.derivedContainer]) {
    await blobs.getContainerClient(id).createIfNotExists();
  }
  const queueUrl = `${config.storageQueueUrl!.replace(/\/$/, "")}/${config.analysisQueueName}`;
  await new QueueClient(queueUrl, credential).createIfNotExists();
}

async function main(): Promise<void> {
  loadDotEnv();
  loadAzdOutputs();
  const command = process.argv[2] ?? "check";
  const config = assertCloudProfile();
  const credential = createAzureCredential();
  if (command === "init") {
    if (!(await credential.getToken("https://management.azure.com/.default"))) {
      throw new Error("Azure CLI authentication token unavailable");
    }
    await initializeResources(config, credential);
    await checkDataPlane(config, credential);
    return;
  }
  if (command === "check") {
    await checkDataPlane(config, credential);
    return;
  }
  if (command === "start") {
    if (process.argv.includes("--init")) await initializeResources(config, credential);
    await checkDataPlane(config, credential);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ["run", "dev"], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }
  throw new Error(`unknown command: ${command}; use check, init, or start`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
