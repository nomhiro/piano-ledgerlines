import { CosmosClient, type Container, type SqlQuerySpec } from "@azure/cosmos";
import https from "node:https";
import path from "node:path";
import type {
  Repository,
  RepositoryDocument,
  RepositoryWriteOptions,
  SongTakeSummary,
} from "./repository";
import {
  RepositoryConflictError as RepositoryConflictErrorClass,
} from "./repository";
import type {
  BillingEventDoc,
  ClassroomDoc,
  ClassroomInvitationDoc,
  ClassroomMemberDoc,
  CreateSongInput,
  CreateTakeInput,
  SongDoc,
  TakeDoc,
  UserProfileDoc,
} from "./types";
import { classroomMemberId, newSongId, newTakeId } from "./ids";
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

function conflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as { code?: number }).code === 409 || (error as { code?: number }).code === 412);
}

export class CosmosRepository implements Repository {
  private readonly songs: Container;
  private readonly takes: Container;
  private readonly users: Container;
  private readonly classrooms: Container;
  private readonly classroomMembers: Container;
  private readonly classroomInvitations: Container;
  private readonly billingEvents: Container;

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
    this.users = database.container(config.cosmosUsersContainer);
    this.classrooms = database.container(config.cosmosClassroomsContainer);
    this.classroomMembers = database.container(config.cosmosClassroomMembersContainer);
    this.classroomInvitations = database.container(config.cosmosClassroomInvitationsContainer);
    this.billingEvents = database.container(config.cosmosBillingEventsContainer);
    this.songs = database.container(config.cosmosSongsContainer);
    this.takes = database.container(config.cosmosTakesContainer);
  }

  async getUser(userId: string): Promise<UserProfileDoc | null> {
    return (await this.getUserRecord(userId))?.document ?? null;
  }

  async getUserRecord(userId: string): Promise<RepositoryDocument<UserProfileDoc> | null> {
    return this.readRecord(this.users, userId, userId);
  }

  async upsertUser(user: UserProfileDoc, options?: RepositoryWriteOptions): Promise<UserProfileDoc> {
    return (await this.upsertRecord(this.users, user, user.id, options)).document;
  }

  async upsertUserRecord(user: UserProfileDoc, options?: RepositoryWriteOptions): Promise<RepositoryDocument<UserProfileDoc>> {
    return this.upsertRecord(this.users, user, user.id, options);
  }

  async createClassroom(classroom: ClassroomDoc, options?: RepositoryWriteOptions): Promise<ClassroomDoc> {
    return (await this.createRecord(this.classrooms, classroom, classroom.id, options)).document;
  }

  async getClassroom(classroomId: string): Promise<ClassroomDoc | null> {
    return (await this.readRecord<ClassroomDoc>(this.classrooms, classroomId, classroomId))?.document ?? null;
  }

  async upsertClassroom(classroom: ClassroomDoc, options?: RepositoryWriteOptions): Promise<ClassroomDoc> {
    return (await this.upsertRecord(this.classrooms, classroom, classroom.id, options)).document;
  }

  async listClassroomsByOwner(ownerUserId: string): Promise<ClassroomDoc[]> {
    const query: SqlQuerySpec = {
      query: "SELECT * FROM c WHERE c.ownerUserId = @ownerUserId",
      parameters: [{ name: "@ownerUserId", value: ownerUserId }],
    };
    return (await this.classrooms.items.query<ClassroomDoc>(query).fetchAll()).resources;
  }

  async createClassroomMember(member: ClassroomMemberDoc, options?: RepositoryWriteOptions): Promise<ClassroomMemberDoc> {
    return (await this.createRecord(this.classroomMembers, member, member.classroomId, options)).document;
  }

  async getClassroomMember(classroomId: string, userId: string): Promise<ClassroomMemberDoc | null> {
    return (
      await this.readRecord<ClassroomMemberDoc>(
        this.classroomMembers,
        classroomMemberId(classroomId, userId),
        classroomId,
      )
    )?.document ?? null;
  }

  async upsertClassroomMember(member: ClassroomMemberDoc, options?: RepositoryWriteOptions): Promise<ClassroomMemberDoc> {
    return (await this.upsertRecord(this.classroomMembers, member, member.classroomId, options)).document;
  }

  async listClassroomMembers(classroomId: string): Promise<ClassroomMemberDoc[]> {
    const query: SqlQuerySpec = {
      query: "SELECT * FROM c WHERE c.classroomId = @classroomId ORDER BY c.createdAt ASC",
      parameters: [{ name: "@classroomId", value: classroomId }],
    };
    return (await this.classroomMembers.items.query<ClassroomMemberDoc>(query, { partitionKey: classroomId }).fetchAll()).resources;
  }

  async createClassroomInvitation(invitation: ClassroomInvitationDoc, options?: RepositoryWriteOptions): Promise<ClassroomInvitationDoc> {
    return (await this.createRecord(this.classroomInvitations, invitation, invitation.classroomId, options)).document;
  }

  async getClassroomInvitation(classroomId: string, invitationId: string): Promise<ClassroomInvitationDoc | null> {
    return (await this.readRecord<ClassroomInvitationDoc>(this.classroomInvitations, invitationId, classroomId))?.document ?? null;
  }

  async upsertClassroomInvitation(invitation: ClassroomInvitationDoc, options?: RepositoryWriteOptions): Promise<ClassroomInvitationDoc> {
    return (await this.upsertRecord(this.classroomInvitations, invitation, invitation.classroomId, options)).document;
  }

  async listClassroomInvitations(classroomId: string): Promise<ClassroomInvitationDoc[]> {
    const query: SqlQuerySpec = {
      query: "SELECT * FROM c WHERE c.classroomId = @classroomId ORDER BY c.createdAt DESC",
      parameters: [{ name: "@classroomId", value: classroomId }],
    };
    return (await this.classroomInvitations.items.query<ClassroomInvitationDoc>(query, { partitionKey: classroomId }).fetchAll()).resources;
  }

  async deleteClassroomInvitation(classroomId: string, invitationId: string, options?: RepositoryWriteOptions): Promise<void> {
    const item = this.classroomInvitations.item(invitationId, classroomId);
    try {
      await item.delete({
        accessCondition: options?.ifMatch
          ? { type: "IfMatch", condition: options.ifMatch }
          : undefined,
      });
    } catch (error) {
      if (notFound(error)) return;
      if (conflict(error)) throw new RepositoryConflictErrorClass("etag does not match");
      throw error;
    }
  }

  async createBillingEvent(event: BillingEventDoc, options?: RepositoryWriteOptions): Promise<BillingEventDoc> {
    return (await this.createRecord(this.billingEvents, event, event.id, options)).document;
  }

  async getBillingEvent(eventId: string): Promise<BillingEventDoc | null> {
    return (await this.readRecord<BillingEventDoc>(this.billingEvents, eventId, eventId))?.document ?? null;
  }

  async upsertBillingEvent(event: BillingEventDoc, options?: RepositoryWriteOptions): Promise<BillingEventDoc> {
    return (await this.upsertRecord(this.billingEvents, event, event.id, options)).document;
  }

  async listBillingEvents(): Promise<BillingEventDoc[]> {
    const query: SqlQuerySpec = {
      query: "SELECT * FROM c ORDER BY c.createdAt DESC",
      parameters: [],
    };
    return (await this.billingEvents.items.query<BillingEventDoc>(query).fetchAll()).resources;
  }

  private async readRecord<T extends { id: string }>(
    container: Container,
    id: string,
    partitionKey: string,
  ): Promise<RepositoryDocument<T> | null> {
    try {
      const response = await container.item(id, partitionKey).read<T>();
      return response.resource ? { document: response.resource, etag: response.etag ?? null } : null;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  private async createRecord<T extends { id: string }>(
    container: Container,
    document: T,
    partitionKey: string,
    options?: RepositoryWriteOptions,
  ): Promise<RepositoryDocument<T>> {
    try {
      const response = await container.items.create<T>(document, {
        accessCondition: options?.ifMatch
          ? { type: "IfMatch", condition: options.ifMatch }
          : undefined,
      });
      return { document: response.resource ?? document, etag: response.etag ?? null };
    } catch (error) {
      if (conflict(error)) throw new RepositoryConflictErrorClass("document already exists");
      throw error;
    }
  }

  private async upsertRecord<T extends { id: string }>(
    container: Container,
    document: T,
    partitionKey: string,
    options?: RepositoryWriteOptions,
  ): Promise<RepositoryDocument<T>> {
    if (options?.ifNoneMatch) {
      const current = await this.readRecord<T>(container, document.id, partitionKey);
      if (current) throw new RepositoryConflictErrorClass("document already exists");
    }
    try {
      const response = options?.ifMatch
        ? await container.item(document.id, partitionKey).replace(document, {
            accessCondition: { type: "IfMatch", condition: options.ifMatch },
          })
        : await container.items.upsert<T>(document);
      return { document: response.resource ?? document, etag: response.etag ?? null };
    } catch (error) {
      if (conflict(error)) throw new RepositoryConflictErrorClass("etag does not match");
      throw error;
    }
  }

  async createSong(userId: string, input: CreateSongInput): Promise<SongDoc> {
    const now = timestamp();
    const song: SongDoc = {
      id: newSongId(), userId, title: input.title, composer: input.composer,
      targetTempo: input.targetTempo ?? null, targetDate: input.targetDate ?? null,
      status: "awaiting_score", measureCount: null, scoreMeasureCount: null,
      keySignature: null, timeSignature: null, detectedTempo: null, hasRepeats: false,
      warnings: [], scoreFileName: null, sourceScoreFileName: null, scoreSource: null,
      omrEngine: null, previewScoreFileName: null, previewMidiFileName: null, createdAt: now, updatedAt: now,
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

  async listSongTakeSummaries(userId: string, songIds: string[]): Promise<Record<string, SongTakeSummary>> {
    if (songIds.length === 0) return {};
    const query: SqlQuerySpec = {
      query: "SELECT c.id, c.songId, c.label, c.status, c.recordedAt, c.overallScore FROM c WHERE c.userId = @userId AND ARRAY_CONTAINS(@songIds, c.songId)",
      parameters: [{ name: "@userId", value: userId }, { name: "@songIds", value: songIds }],
    };
    const takes = (await this.takes.items.query<Pick<TakeDoc, "id" | "songId" | "label" | "status" | "recordedAt" | "overallScore">>(query, { partitionKey: userId }).fetchAll()).resources;
    const summaries: Record<string, SongTakeSummary> = {};
    for (const take of takes) {
      const summary = summaries[take.songId] ?? { count: 0, latest: null };
      summary.count += 1;
      if (!summary.latest || take.recordedAt > summary.latest.recordedAt) {
        summary.latest = {
          id: take.id,
          label: take.label,
          status: take.status,
          recordedAt: take.recordedAt,
          overallScore: take.overallScore,
        };
      }
      summaries[take.songId] = summary;
    }
    return summaries;
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
      progress: 0, failure: null, overallScore: null, metrics: null,
      metricConfidence: { pitch: null, rhythm: null, tempo: null, dynamics: null, pedal: null },
      metricEvaluations: {}, metricsNAReason: {}, evaluation: null,
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
      query: "SELECT * FROM c WHERE c.userId = @userId AND c.songId = @songId ORDER BY c.recordedAt ASC",
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
