// Pythonワーカー(worker/worker_main.py)の起動ヘルパー。
// ローカル縦串フェーズでは Storage Queue + Container Apps Jobs の代わりに
// child_process.spawn で直接起動する。本番フェーズではこのモジュールを
// キュー投入(Service Bus / Storage Queue)に差し替える想定。
import { spawn } from "node:child_process";
import fs from "node:fs";
import { DATA_DIR, WORKER_MAIN } from "./paths";
import { getTelemetry } from "./observability";

function resolvePythonPath(): string {
  if (process.env.WORKER_PYTHON) return process.env.WORKER_PYTHON;
  // 前セッションのPoC検証で使われていたvenv（Windowsパス長制限回避のためリポジトリ外に配置）。
  // 本番はコンテナイメージに直接インストールするためこのフォールバックは不要になる。
  const pocVenv = "C:\\llpoc\\venv\\Scripts\\python.exe";
  if (fs.existsSync(pocVenv)) return pocVenv;
  return "python";
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runWorker(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const takeId = args[args.indexOf("--take-id") + 1];
    const mode = args[args.indexOf("--mode") + 1] ?? "unknown";
    const python = resolvePythonPath();
    const child = spawn(python, [WORKER_MAIN, ...args], {
      cwd: undefined,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      getTelemetry().record({ name: "worker.failed", takeId, stage: mode, durationMs: Date.now() - startedAt, failureCode: error.name });
      reject(error);
    });
    child.on("close", (code) => {
      getTelemetry().record({
        name: code === 0 ? "worker.completed" : "worker.failed",
        takeId,
        stage: mode,
        durationMs: Date.now() - startedAt,
        failureCode: code === 0 ? undefined : `EXIT_${code ?? 1}`,
      });
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function runOmrWorker(songId: string, dataDir = DATA_DIR): Promise<RunResult> {
  return runWorker(["--mode", "omr", "--data-dir", dataDir, "--song-id", songId]);
}

/**
 * S1: MusicXML → reference.json 生成。api.md 5.1 の `POST /songs/{songId}/score`
 * は同期処理(通常1-3秒)と規定されているため、呼び出し元でawaitしてよい。
 */
export async function runReferenceWorker(songId: string, dataDir = DATA_DIR): Promise<RunResult> {
  return runWorker(["--mode", "reference", "--data-dir", dataDir, "--song-id", songId]);
}

/**
 * S0〜S5の解析パイプライン。api.md 5.2/5.3 のとおり非同期(202 + ポーリング/SSE)
 * が前提のため、呼び出し元はawaitせず投げっぱなしにする（fire-and-forget）。
 * take.json の status をワーカーが直接更新するので、進捗はファイルをポーリングして把握する。
 */
export function runAnalyzeWorkerAsync(takeId: string): void {
  runWorker(["--mode", "analyze", "--data-dir", DATA_DIR, "--take-id", takeId]).catch((err) => {
    console.error(`[worker] analyze failed to start for take ${takeId}:`, err);
  });
}
