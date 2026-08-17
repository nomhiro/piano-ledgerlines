import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { CosmosClient, PartitionKeyKind } from "@azure/cosmos";
import { BlobServiceClient } from "@azure/storage-blob";
import { QueueServiceClient } from "@azure/storage-queue";

const root = process.cwd();
const envFile = path.join(root, ".env.local.azure");

function loadEnv(): void {
  if (!fs.existsSync(envFile)) throw new Error("Copy .env.local.azure.example to .env.local.azure first");
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function checkPort(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error(`timed out connecting to ${host}:${port}`)); });
  });
}

async function checkHttp(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, (response) => {
      response.resume();
      response.once("end", () => resolve());
    });
    request.once("error", reject);
    request.setTimeout(3_000, () => { request.destroy(); reject(new Error(`timed out requesting ${url}`)); });
  });
}

const execFileAsync = promisify(execFile);

// Next.js自体はワーカーに直接接続しない（Queue経由のみ）ため、ワーカーが
// 落ちていても起動をブロックする理由はない。ただし
// LEDGERLINES_DETERMINISTIC_ANALYSIS=false（既定）でワーカーコンテナが
// 動いていない場合、投入したテイクがQueueに残ったまま誰にも消費されず
// `queued` で固まる。ここでは警告のみ出す（`docker`未インストール等でも
// health自体は失敗させない）。
async function checkWorkerContainer(): Promise<void> {
  if (process.env.LEDGERLINES_DETERMINISTIC_ANALYSIS === "true") return;
  try {
    const { stdout } = await execFileAsync("docker", [
      "compose", "-f", "docker-compose.azure-local.yml", "ps", "--status", "running", "--services",
    ]);
    if (!stdout.split(/\r?\n/).map((line) => line.trim()).includes("worker")) {
      console.warn(
        "警告: workerコンテナが起動していません。LEDGERLINES_DETERMINISTIC_ANALYSIS=false のままだと" +
        "解析ジョブを消費する者がおらず`queued`で止まります。`npm run azure:up`でworkerも起動してください" +
        "（または一時的に`LEDGERLINES_DETERMINISTIC_ANALYSIS=true`に戻す）。"
      );
    }
  } catch {
    console.warn("警告: workerコンテナの起動状態を確認できませんでした（dockerが見つからない可能性があります）。");
  }
}

async function health(): Promise<void> {
  await checkPort("127.0.0.1", 10000);
  await checkPort("127.0.0.1", 10001);
  await checkPort("127.0.0.1", 8080);
  await checkHttp(process.env.AZURE_COSMOS_ENDPOINT ?? "https://localhost:8081");
  console.log("Azurite and Cosmos emulator are reachable.");
  await checkWorkerContainer();
}

async function init(): Promise<void> {
  const endpoint = process.env.AZURE_COSMOS_ENDPOINT!;
  const key = process.env.AZURE_COSMOS_KEY!;
  const cosmos = new CosmosClient({
    endpoint,
    key,
    agent: new https.Agent({ rejectUnauthorized: false }),
  });
  const database = (await cosmos.databases.createIfNotExists({ id: process.env.AZURE_COSMOS_DATABASE ?? "ledgerlines" })).database;
  for (const [id, partitionKey] of [
    [process.env.AZURE_COSMOS_USERS_CONTAINER ?? "users", "/id"],
    [process.env.AZURE_COSMOS_CLASSROOMS_CONTAINER ?? "classrooms", "/id"],
    [process.env.AZURE_COSMOS_CLASSROOM_MEMBERS_CONTAINER ?? "classroom-members", "/classroomId"],
    [process.env.AZURE_COSMOS_CLASSROOM_INVITATIONS_CONTAINER ?? "classroom-invitations", "/classroomId"],
    [process.env.AZURE_COSMOS_BILLING_EVENTS_CONTAINER ?? "billing-events", "/id"],
    [process.env.AZURE_COSMOS_SONGS_CONTAINER ?? "songs", "/userId"],
    [process.env.AZURE_COSMOS_TAKES_CONTAINER ?? "takes", "/userId"],
  ] as const) {
    // `kind: "Hash"` は infra/modules/cosmos.bicep と揃えるために必須。省略すると
    // Cosmos emulator(vnext) はパーティションキー定義を送られたまま
    // （`kind` 無しで）保存し、Python SDK が `partitionKeyDefinition["kind"]` を
    // 読む箇所で `KeyError: 'kind'` になる（実機で確認済み）。Node SDK は
    // `kind` を参照しないので気付きにくいが、`cloud_worker.py` の
    // `replace_item`（テイクの状態更新）が全て失敗し解析が完了できなくなる。
    await database.containers.createIfNotExists({
      id,
      partitionKey: { paths: [partitionKey], kind: PartitionKeyKind.Hash },
    });
  }
  const connection = process.env.AZURE_STORAGE_CONNECTION_STRING!;
  const blobs = BlobServiceClient.fromConnectionString(connection);
  for (const name of [
    process.env.AZURE_STORAGE_SCORES_CONTAINER ?? "scores",
    process.env.AZURE_STORAGE_AUDIO_CONTAINER ?? "audio",
    process.env.AZURE_STORAGE_DERIVED_CONTAINER ?? "derived",
  ]) await blobs.getContainerClient(name).createIfNotExists();
  const queueService = QueueServiceClient.fromConnectionString(connection);
  for (const name of [
    process.env.AZURE_ANALYSIS_QUEUE ?? "analysis-jobs",
    process.env.AZURE_SCORE_QUEUE ?? "score-jobs",
  ]) await queueService.getQueueClient(name).createIfNotExists();
  console.log("Cosmos database/containers and Azurite containers/queue are ready.");
}

function checkConfig(): void {
  const forbidden = ["AZURE_SUBSCRIPTION_ID", "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET"];
  const found = forbidden.filter((name) => process.env[name]);
  if (found.length) throw new Error(`Cloud credentials must not be set for local Azure mode: ${found.join(", ")}`);
  if (process.env.LEDGERLINES_AZURE_EMULATOR !== "true") throw new Error("LEDGERLINES_AZURE_EMULATOR must be true");
  if (process.env.LEDGERLINES_AUTH_MODE !== "development") throw new Error("local profile must use development auth");
  console.log("Local Azure profile is safe (emulator endpoints, development auth, no cloud credentials).");
}

async function start(): Promise<void> {
  checkConfig();
  await health();
  await init();
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Windowsでは `shell: true` が必須。Node 18.20 / 20.12 以降のセキュリティ修正で
  // `.cmd` / `.bat` を shell 無しで spawn すると EINVAL になり、この行が
  // `Error: spawn EINVAL` で即死する（Node 22.17 / Windows 11 で確認済み）。
  const child = spawn(npm, ["run", "dev"], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

async function main(): Promise<void> {
  loadEnv();
  const command = process.argv[2] ?? "check";
  if (command === "health") return health();
  if (command === "init") return init();
  if (command === "check") return checkConfig();
  if (command === "start") return start();
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
