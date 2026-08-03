import { CosmosClient, type Container, type SqlQuerySpec } from "@azure/cosmos";
import https from "node:https";
import path from "node:path";
import type { Repository } from "./repository";
import type { CreateSongInput, CreateTakeInput, SongDoc, TakeDoc } from "./types";
import { newSongId, newTakeId } from "./ids";
import { getConfig } from "./config";
import { getBlobStore } from "./blob-storage";
import { assertTakeTransition } from "./take-state";
import { createAzureCredential } from "./azure-credential";

function timestamp(): string {
  return new Date().toISOString();
}

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: number }).code === 404;
}

export class CosmosRepository implements Repository {
  private readonly songs: Container;
  private readonly takes: Container;

  constructor() {
    const config = getConfig();
    const client = config.azureEmulator
      ? new CosmosClient({
          endpoint: config.cosmosEndpoint!,
          key: config.cosmosKey!,
          agent: new https.Agent({ rejectUnauthorized: false }),
        })
      : new CosmosClient({
          endpoint: config.cosmosEndpoint!,
          aadCredentials: createAzureCredential(),
        });
    const database = client.database(config.cosmosDatabase);
    this.songs = database.container(config.cosmosSongsContainer);
    this.takes = database.container(config.cosmosTakesContainer);
  }

  async createSong(userId: string, input: CreateSongInput): Promise<SongDoc> {
    const now = timestamp();
    const song: SongDoc = {
      id: newSongId(), userId, title: input.title, composer: input.composer,
      targetTempo: input.targetTempo ?? null, targetDate: input.targetDate ?? null,
      status: "awaiting_score", measureCount: null, scoreMeasureCount: null,
      keySignature: null, timeSignature: null, detectedTempo: null, hasRepeats: false,
      warnings: [], scoreFileName: null, createdAt: now, updatedAt: now,
    };
    await this.songs.items.create(song);
    return song;
  }

  async getSong(userId: string, songId: string): Promise<SongDoc | null> {
    try {
      return (await this.songs.item(songId, userId).read<SongDoc>()).resource ?? null;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async listSongs(userId: string): Promise<SongDoc[]> {
    const query: SqlQuerySpec = {
      query: "SELECT * FROM c WHERE c.userId = @userId ORDER BY c.createdAt DESC",
      parameters: [{ name: "@userId", value: userId }],
    };
    return (await this.songs.items.query<SongDoc>(query, { partitionKey: userId }).fetchAll()).resources;
  }

  async updateSong(userId: string, songId: string, patch: Partial<SongDoc>): Promise<SongDoc> {
    const current = await this.getSong(userId, songId);
    if (!current) throw new Error("song not found");
    const allowed = { ...patch };
    delete allowed.id;
    delete allowed.userId;
    delete allowed.createdAt;
    const updated = { ...current, ...allowed, updatedAt: timestamp() };
    await this.songs.item(songId, userId).replace(updated);
    return updated;
  }

  async deleteSong(userId: string, songId: string): Promise<void> {
    const song = await this.getSong(userId, songId);
    if (!song) throw new Error("song not found");
    const config = getConfig();
    const prefix = `users/${userId}/songs/${songId}/`;
    const takes = await this.listTakesBySong(userId, songId);
    await Promise.all([
      getBlobStore().deletePrefix(config.scoresContainer, prefix),
      getBlobStore().deletePrefix(config.audioContainer, prefix),
      getBlobStore().deletePrefix(config.derivedContainer, prefix),
    ]);
    await Promise.all(takes.map((take) => this.takes.item(take.id, userId).delete()));
    await this.songs.item(songId, userId).delete();
  }

  async saveScoreFile(userId: string, songId: string, fileName: string, bytes: Buffer): Promise<string> {
    if (!(await this.getSong(userId, songId))) throw new Error("song not found");
    const name = `users/${userId}/songs/${songId}/scores/score${path.extname(fileName).toLowerCase() || ".musicxml"}`;
    await getBlobStore().upload(getConfig().scoresContainer, name, bytes, "application/octet-stream");
    await this.updateSong(userId, songId, { scoreFileName: fileName });
    return name;
  }

  async createTake(userId: string, songId: string, input: CreateTakeInput): Promise<TakeDoc> {
    if (!(await this.getSong(userId, songId))) throw new Error("song not found");
    const now = timestamp();
    const take: TakeDoc = {
      id: newTakeId(), userId, songId, label: input.label, recordedAt: input.recordedAt,
      durationSec: input.durationSec, requestedMeasureRange: input.requestedMeasureRange,
      playedMeasureRange: null, requestedTempo: input.requestedTempo ?? null,
      inputKind: input.inputKind, contentType: input.contentType, status: "uploading",
      progress: 0, failure: null, overallScore: null, metrics: null, metricsNAReason: {},
      measureScores: [], issues: [], aiReview: null, analysis: null, memo: "",
      createdAt: now, updatedAt: now,
    };
    await this.takes.items.create(take);
    return take;
  }

  async getTake(userId: string, takeId: string): Promise<TakeDoc | null> {
    try {
      return (await this.takes.item(takeId, userId).read<TakeDoc>()).resource ?? null;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async listTakesBySong(userId: string, songId: string): Promise<TakeDoc[]> {
    const query: SqlQuerySpec = {
      query: "SELECT * FROM c WHERE c.userId = @userId AND c.songId = @songId ORDER BY c.recordedAt DESC",
      parameters: [{ name: "@userId", value: userId }, { name: "@songId", value: songId }],
    };
    return (await this.takes.items.query<TakeDoc>(query, { partitionKey: userId }).fetchAll()).resources;
  }

  async countTakesSince(userId: string, sinceIso: string): Promise<number> {
    const query: SqlQuerySpec = {
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.userId = @userId AND c.createdAt >= @sinceIso",
      parameters: [{ name: "@userId", value: userId }, { name: "@sinceIso", value: sinceIso }],
    };
    const resources = (await this.takes.items.query<number>(query, { partitionKey: userId }).fetchAll()).resources;
    return resources[0] ?? 0;
  }

  async updateTake(userId: string, takeId: string, patch: Partial<TakeDoc>): Promise<TakeDoc> {
    const current = await this.getTake(userId, takeId);
    if (!current) throw new Error("take not found");
    if (patch.status) assertTakeTransition(current.status, patch.status);
    const allowed = { ...patch };
    delete allowed.id;
    delete allowed.userId;
    delete allowed.songId;
    delete allowed.createdAt;
    const updated = { ...current, ...allowed, updatedAt: timestamp() };
    await this.takes.item(takeId, userId).replace(updated);
    return updated;
  }

  async saveAudioFile(userId: string, takeId: string, fileName: string, bytes: Buffer): Promise<string> {
    const take = await this.getTake(userId, takeId);
    if (!take) throw new Error("take not found");
    const name = `users/${userId}/songs/${take.songId}/takes/${takeId}/original${path.extname(fileName).toLowerCase() || ".webm"}`;
    await getBlobStore().upload(getConfig().audioContainer, name, bytes, take.contentType ?? "application/octet-stream");
    await this.updateTake(userId, takeId, { status: "uploaded" });
    return name;
  }
}
