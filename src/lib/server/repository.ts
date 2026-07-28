// ローカルJSONファイルベースのリポジトリ実装。
// data-model.md のコンテナ設計（songs/userId, takes/songId）に相当する操作を
// ファイルシステム上で提供する。本番フェーズでは同じ関数シグネチャを
// @azure/cosmos 実装に差し替える想定（呼び出し側のAPIルートは変更不要）。
import fs from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIR,
  audioFilePath,
  scoreFilePath,
  songDocPath,
  songsDir,
  takeDocPath,
  takesDir,
} from "./paths";
import type { CreateSongInput, CreateTakeInput, SongDoc, TakeDoc } from "./types";
import { newSongId, newTakeId } from "./ids";

// M5縦串フェーズは認証未実装（ユーザー確認済み: まず固定モックユーザーで進める）。
// Entra External ID 導入時にリクエストのユーザーIDへ置き換える。
export const MOCK_USER_ID = "usr_local_dev";

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function listJsonFiles<T>(dir: string): Promise<T[]> {
  await ensureDir(dir);
  const entries = await fs.readdir(dir);
  const docs = await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<T>(path.join(dir, name)))
  );
  return docs;
}

// --- Songs ---------------------------------------------------------------

export async function createSong(input: CreateSongInput): Promise<SongDoc> {
  const id = newSongId();
  const doc: SongDoc = {
    id,
    userId: MOCK_USER_ID,
    title: input.title,
    composer: input.composer,
    targetTempo: input.targetTempo ?? null,
    targetDate: input.targetDate ?? null,
    status: "awaiting_score",
    measureCount: null,
    scoreMeasureCount: null,
    keySignature: null,
    timeSignature: null,
    detectedTempo: null,
    hasRepeats: false,
    warnings: [],
    scoreFileName: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await writeJson(songDocPath(id), doc);
  return doc;
}

export async function getSong(songId: string): Promise<SongDoc | null> {
  try {
    return await readJson<SongDoc>(songDocPath(songId));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function listSongs(): Promise<SongDoc[]> {
  const docs = await listJsonFiles<SongDoc>(songsDir());
  return docs
    .filter((d) => d.userId === MOCK_USER_ID)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function saveScoreFile(
  songId: string,
  fileName: string,
  bytes: Buffer
): Promise<string> {
  // ワーカー(reference.py)は score.musicxml という固定名を期待するため、
  // 元のファイル名に関わらずここで正規化する。
  const ext = path.extname(fileName).toLowerCase() || ".musicxml";
  const targetName = `score${ext}`;
  const filePath = scoreFilePath(songId, targetName);
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, bytes);
  await updateSong(songId, { scoreFileName: fileName });
  return filePath;
}

export async function updateSong(
  songId: string,
  patch: Partial<SongDoc>
): Promise<SongDoc> {
  const current = await getSong(songId);
  if (!current) throw new Error(`song not found: ${songId}`);
  const updated: SongDoc = { ...current, ...patch, updatedAt: nowIso() };
  await writeJson(songDocPath(songId), updated);
  return updated;
}

// --- Takes -----------------------------------------------------------------

export async function createTake(
  songId: string,
  input: CreateTakeInput
): Promise<TakeDoc> {
  const id = newTakeId();
  const doc: TakeDoc = {
    id,
    userId: MOCK_USER_ID,
    songId,
    label: input.label,
    recordedAt: input.recordedAt,
    durationSec: input.durationSec,
    requestedMeasureRange: input.requestedMeasureRange,
    playedMeasureRange: null,
    requestedTempo: input.requestedTempo ?? null,
    inputKind: input.inputKind,
    contentType: input.contentType,
    status: "uploading",
    progress: 0,
    failure: null,
    overallScore: null,
    metrics: null,
    metricsNAReason: {},
    measureScores: [],
    issues: [],
    aiReview: null,
    analysis: null,
    memo: "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await writeJson(takeDocPath(id), doc);
  return doc;
}

export async function getTake(takeId: string): Promise<TakeDoc | null> {
  try {
    return await readJson<TakeDoc>(takeDocPath(takeId));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function listTakesBySong(songId: string): Promise<TakeDoc[]> {
  const docs = await listJsonFiles<TakeDoc>(takesDir());
  return docs
    .filter((d) => d.songId === songId)
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
}

export async function updateTake(
  takeId: string,
  patch: Partial<TakeDoc>
): Promise<TakeDoc> {
  const current = await getTake(takeId);
  if (!current) throw new Error(`take not found: ${takeId}`);
  const updated: TakeDoc = { ...current, ...patch, updatedAt: nowIso() };
  await writeJson(takeDocPath(takeId), updated);
  return updated;
}

export async function saveAudioFile(
  takeId: string,
  fileName: string,
  bytes: Buffer
): Promise<string> {
  const ext = path.extname(fileName) || ".webm";
  const filePath = audioFilePath(takeId, `original${ext}`);
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, bytes);
  await updateTake(takeId, { status: "uploaded" });
  return filePath;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

export { DATA_DIR };
