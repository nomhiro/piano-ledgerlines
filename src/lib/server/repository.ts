import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  DATA_DIR,
  audioDir,
  audioFilePath,
  billingEventDocPath,
  billingEventsDir,
  classroomDocPath,
  classroomInvitationDocPath,
  classroomInvitationsDir,
  classroomMemberDocPath,
  classroomMembersDir,
  classroomsDir,
  scoreFilePath,
  songDocPath,
  songsDir,
  takeDocPath,
  takesDir,
  userDocPath,
} from "./paths";
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
import { getAuthenticatedServerUser } from "./auth";
import { CosmosRepository } from "./cosmos-repository";
import { assertTakeTransition } from "./take-state";

export interface Repository {
  getUser(userId: string): Promise<UserProfileDoc | null>;
  getUserRecord(userId: string): Promise<RepositoryDocument<UserProfileDoc> | null>;
  upsertUser(user: UserProfileDoc, options?: RepositoryWriteOptions): Promise<UserProfileDoc>;
  upsertUserRecord(user: UserProfileDoc, options?: RepositoryWriteOptions): Promise<RepositoryDocument<UserProfileDoc>>;
  createClassroom(classroom: ClassroomDoc, options?: RepositoryWriteOptions): Promise<ClassroomDoc>;
  getClassroom(classroomId: string): Promise<ClassroomDoc | null>;
  getClassroomRecord?(classroomId: string): Promise<RepositoryDocument<ClassroomDoc> | null>;
  upsertClassroom(classroom: ClassroomDoc, options?: RepositoryWriteOptions): Promise<ClassroomDoc>;
  listClassroomsByOwner(ownerUserId: string): Promise<ClassroomDoc[]>;
  findClassroomByStripeCustomerId?(customerId: string): Promise<ClassroomDoc | null>;
  findClassroomByStripeSubscriptionId?(subscriptionId: string): Promise<ClassroomDoc | null>;
  createClassroomMember(member: ClassroomMemberDoc, options?: RepositoryWriteOptions): Promise<ClassroomMemberDoc>;
  getClassroomMember(classroomId: string, userId: string): Promise<ClassroomMemberDoc | null>;
  getClassroomMemberRecord?(classroomId: string, userId: string): Promise<RepositoryDocument<ClassroomMemberDoc> | null>;
  upsertClassroomMember(member: ClassroomMemberDoc, options?: RepositoryWriteOptions): Promise<ClassroomMemberDoc>;
  listClassroomMembers(classroomId: string): Promise<ClassroomMemberDoc[]>;
  createClassroomInvitation(invitation: ClassroomInvitationDoc, options?: RepositoryWriteOptions): Promise<ClassroomInvitationDoc>;
  getClassroomInvitation(classroomId: string, invitationId: string): Promise<ClassroomInvitationDoc | null>;
  upsertClassroomInvitation(invitation: ClassroomInvitationDoc, options?: RepositoryWriteOptions): Promise<ClassroomInvitationDoc>;
  listClassroomInvitations(classroomId: string): Promise<ClassroomInvitationDoc[]>;
  getClassroomInvitationRecord(
    classroomId: string,
    invitationId: string,
  ): Promise<RepositoryDocument<ClassroomInvitationDoc> | null>;
  deleteClassroomInvitation(classroomId: string, invitationId: string, options?: RepositoryWriteOptions): Promise<void>;
  createBillingEvent(event: BillingEventDoc, options?: RepositoryWriteOptions): Promise<BillingEventDoc>;
  getBillingEvent(eventId: string): Promise<BillingEventDoc | null>;
  getBillingEventRecord?(eventId: string): Promise<RepositoryDocument<BillingEventDoc> | null>;
  upsertBillingEvent(event: BillingEventDoc, options?: RepositoryWriteOptions): Promise<BillingEventDoc>;
  listBillingEvents(): Promise<BillingEventDoc[]>;
  createSong(userId: string, input: CreateSongInput): Promise<SongDoc>;
  getSong(userId: string, songId: string): Promise<SongDoc | null>;
  listSongs(userId: string): Promise<SongDoc[]>;
  listSongTakeSummaries(userId: string, songIds: string[]): Promise<Record<string, SongTakeSummary>>;
  updateSong(userId: string, songId: string, patch: Partial<SongDoc>): Promise<SongDoc>;
  deleteSong(userId: string, songId: string): Promise<void>;
  saveScoreFile(userId: string, songId: string, fileName: string, bytes: Buffer): Promise<string>;
  createTake(userId: string, songId: string, input: CreateTakeInput): Promise<TakeDoc>;
  getTake(userId: string, takeId: string): Promise<TakeDoc | null>;
  listTakesBySong(userId: string, songId: string): Promise<TakeDoc[]>;
  countTakesSince(userId: string, sinceIso: string): Promise<number>;
  updateTake(userId: string, takeId: string, patch: Partial<TakeDoc>): Promise<TakeDoc>;
  saveAudioFile(userId: string, takeId: string, fileName: string, bytes: Buffer): Promise<string>;
}

export interface RepositoryWriteOptions {
  ifMatch?: string;
  ifNoneMatch?: boolean;
}

export interface RepositoryDocument<T> {
  document: T;
  etag: string | null;
}

export class RepositoryConflictError extends Error {
  constructor(message = "repository write conflict") {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export interface SongTakeSummary {
  count: number;
  latest: {
    id: string;
    label: string;
    status: TakeDoc["status"];
    recordedAt: string;
    overallScore: number | null;
  } | null;
}

type DomainDocument =
  | UserProfileDoc
  | ClassroomDoc
  | ClassroomMemberDoc
  | ClassroomInvitationDoc
  | BillingEventDoc;

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(tempPath, { force: true });
  }
}

async function listJsonFiles<T>(dir: string): Promise<T[]> {
  await ensureDir(dir);
  const entries = await fs.readdir(dir);
  return Promise.all(
    entries.filter((name) => name.endsWith(".json")).map((name) => readJson<T>(path.join(dir, name)))
  );
}

export class LocalRepository implements Repository {
  async getUser(userId: string): Promise<UserProfileDoc | null> {
    return (await this.getUserRecord(userId))?.document ?? null;
  }

  async getUserRecord(userId: string): Promise<RepositoryDocument<UserProfileDoc> | null> {
    return this.readDomainRecord(userDocPath(userId));
  }

  async upsertUser(user: UserProfileDoc, options?: RepositoryWriteOptions): Promise<UserProfileDoc> {
    return (await this.upsertUserRecord(user, options)).document;
  }

  async upsertUserRecord(user: UserProfileDoc, options?: RepositoryWriteOptions): Promise<RepositoryDocument<UserProfileDoc>> {
    return this.writeDomainRecord(userDocPath(user.id), user, options);
  }

  async createClassroom(classroom: ClassroomDoc, options?: RepositoryWriteOptions): Promise<ClassroomDoc> {
    return (await this.writeDomainRecord(classroomDocPath(classroom.id), classroom, { ...options, ifNoneMatch: true })).document;
  }

  async getClassroom(classroomId: string): Promise<ClassroomDoc | null> {
    return (await this.readDomainRecord<ClassroomDoc>(classroomDocPath(classroomId)))?.document ?? null;
  }

  async getClassroomRecord(classroomId: string): Promise<RepositoryDocument<ClassroomDoc> | null> {
    return this.readDomainRecord<ClassroomDoc>(classroomDocPath(classroomId));
  }

  async upsertClassroom(classroom: ClassroomDoc, options?: RepositoryWriteOptions): Promise<ClassroomDoc> {
    return (await this.writeDomainRecord(classroomDocPath(classroom.id), classroom, options)).document;
  }

  async listClassroomsByOwner(ownerUserId: string): Promise<ClassroomDoc[]> {
    const docs = await listJsonFiles<ClassroomDoc>(classroomsDir());
    return docs.filter((doc) => doc.ownerUserId === ownerUserId);
  }

  async findClassroomByStripeCustomerId(customerId: string): Promise<ClassroomDoc | null> {
    const docs = await listJsonFiles<ClassroomDoc>(classroomsDir());
    return docs.find((doc) => doc.billing.stripeCustomerId === customerId) ?? null;
  }

  async findClassroomByStripeSubscriptionId(subscriptionId: string): Promise<ClassroomDoc | null> {
    const docs = await listJsonFiles<ClassroomDoc>(classroomsDir());
    return docs.find((doc) => doc.billing.stripeSubscriptionId === subscriptionId) ?? null;
  }

  async createClassroomMember(member: ClassroomMemberDoc, options?: RepositoryWriteOptions): Promise<ClassroomMemberDoc> {
    return (await this.writeDomainRecord(
      classroomMemberDocPath(member.classroomId, member.id),
      member,
      { ...options, ifNoneMatch: true },
    )).document;
  }

  async getClassroomMember(classroomId: string, userId: string): Promise<ClassroomMemberDoc | null> {
    const id = classroomMemberId(classroomId, userId);
    return (await this.readDomainRecord<ClassroomMemberDoc>(classroomMemberDocPath(classroomId, id)))?.document ?? null;
  }

  async getClassroomMemberRecord(
    classroomId: string,
    userId: string,
  ): Promise<RepositoryDocument<ClassroomMemberDoc> | null> {
    return this.readDomainRecord<ClassroomMemberDoc>(
      classroomMemberDocPath(classroomId, classroomMemberId(classroomId, userId)),
    );
  }

  async upsertClassroomMember(member: ClassroomMemberDoc, options?: RepositoryWriteOptions): Promise<ClassroomMemberDoc> {
    return (await this.writeDomainRecord(
      classroomMemberDocPath(member.classroomId, member.id),
      member,
      options,
    )).document;
  }

  async listClassroomMembers(classroomId: string): Promise<ClassroomMemberDoc[]> {
    return listJsonFiles<ClassroomMemberDoc>(classroomMembersDir(classroomId));
  }

  async createClassroomInvitation(invitation: ClassroomInvitationDoc, options?: RepositoryWriteOptions): Promise<ClassroomInvitationDoc> {
    return (await this.writeDomainRecord(
      classroomInvitationDocPath(invitation.classroomId, invitation.id),
      invitation,
      { ...options, ifNoneMatch: true },
    )).document;
  }

  async getClassroomInvitation(classroomId: string, invitationId: string): Promise<ClassroomInvitationDoc | null> {
    return (await this.readDomainRecord<ClassroomInvitationDoc>(
      classroomInvitationDocPath(classroomId, invitationId),
    ))?.document ?? null;
  }

  async upsertClassroomInvitation(invitation: ClassroomInvitationDoc, options?: RepositoryWriteOptions): Promise<ClassroomInvitationDoc> {
    return (await this.writeDomainRecord(
      classroomInvitationDocPath(invitation.classroomId, invitation.id),
      invitation,
      options,
    )).document;
  }

  async listClassroomInvitations(classroomId: string): Promise<ClassroomInvitationDoc[]> {
    return listJsonFiles<ClassroomInvitationDoc>(classroomInvitationsDir(classroomId));
  }

  async getClassroomInvitationRecord(
    classroomId: string,
    invitationId: string,
  ): Promise<RepositoryDocument<ClassroomInvitationDoc> | null> {
    return this.readDomainRecord<ClassroomInvitationDoc>(
      classroomInvitationDocPath(classroomId, invitationId),
    );
  }

  async deleteClassroomInvitation(classroomId: string, invitationId: string, options?: RepositoryWriteOptions): Promise<void> {
    const filePath = classroomInvitationDocPath(classroomId, invitationId);
    await withDomainLock(filePath, async () => {
      const current = await this.readDomainRecord<ClassroomInvitationDoc>(filePath);
      if (!current) {
        this.assertWriteCondition(current, options);
        return;
      }
      this.assertWriteCondition(current, options);
      await fs.rm(filePath);
    });
  }

  async createBillingEvent(event: BillingEventDoc, options?: RepositoryWriteOptions): Promise<BillingEventDoc> {
    return (await this.writeDomainRecord(billingEventDocPath(event.id), event, { ...options, ifNoneMatch: true })).document;
  }

  async getBillingEvent(eventId: string): Promise<BillingEventDoc | null> {
    return (await this.readDomainRecord<BillingEventDoc>(billingEventDocPath(eventId)))?.document ?? null;
  }

  async getBillingEventRecord(eventId: string): Promise<RepositoryDocument<BillingEventDoc> | null> {
    return this.readDomainRecord<BillingEventDoc>(billingEventDocPath(eventId));
  }

  async upsertBillingEvent(event: BillingEventDoc, options?: RepositoryWriteOptions): Promise<BillingEventDoc> {
    return (await this.writeDomainRecord(billingEventDocPath(event.id), event, options)).document;
  }

  async listBillingEvents(): Promise<BillingEventDoc[]> {
    return listJsonFiles<BillingEventDoc>(billingEventsDir());
  }

  private async readDomainRecord<T extends DomainDocument>(filePath: string): Promise<RepositoryDocument<T> | null> {
    try {
      const document = await readJson<T>(filePath);
      return { document, etag: domainEtag(document) };
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  private async writeDomainRecord<T extends DomainDocument>(
    filePath: string,
    document: T,
    options?: RepositoryWriteOptions,
  ): Promise<RepositoryDocument<T>> {
    return withDomainLock(filePath, async () => {
      const current = await this.readDomainRecord<T>(filePath);
      if (options?.ifNoneMatch && current) throw new RepositoryConflictError("document already exists");
      this.assertWriteCondition(current, options);
      await writeJsonAtomically(filePath, document);
      return { document, etag: domainEtag(document) };
    });
  }

  private assertWriteCondition<T>(current: RepositoryDocument<T> | null, options?: RepositoryWriteOptions): void {
    if (options?.ifMatch && (!current || options.ifMatch !== current.etag)) {
      throw new RepositoryConflictError("etag does not match");
    }
  }

  async createSong(userId: string, input: CreateSongInput): Promise<SongDoc> {
    const id = newSongId();
    const timestamp = nowIso();
    const doc: SongDoc = {
      id,
      userId,
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
      sourceScoreFileName: null,
      scoreSource: null,
      omrEngine: null,
      previewScoreFileName: null,
      previewMidiFileName: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeJson(songDocPath(id), doc);
    return doc;
  }

  async getSong(userId: string, songId: string): Promise<SongDoc | null> {
    try {
      const song = await readJson<SongDoc>(songDocPath(songId));
      return song.userId === userId ? song : null;
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async listSongs(userId: string): Promise<SongDoc[]> {
    const docs = await listJsonFiles<SongDoc>(songsDir());
    return docs.filter((doc) => doc.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listSongTakeSummaries(userId: string, songIds: string[]): Promise<Record<string, SongTakeSummary>> {
    const wanted = new Set(songIds);
    const summaries: Record<string, SongTakeSummary> = {};
    const docs = await listJsonFiles<TakeDoc>(takesDir());
    for (const doc of docs) {
      if (doc.userId !== userId || !wanted.has(doc.songId)) continue;
      const summary = summaries[doc.songId] ?? { count: 0, latest: null };
      summary.count += 1;
      if (!summary.latest || doc.recordedAt > summary.latest.recordedAt) {
        summary.latest = {
          id: doc.id,
          label: doc.label,
          status: doc.status,
          recordedAt: doc.recordedAt,
          overallScore: doc.overallScore,
        };
      }
      summaries[doc.songId] = summary;
    }
    return summaries;
  }

  async updateSong(userId: string, songId: string, patch: Partial<SongDoc>): Promise<SongDoc> {
    const current = await this.getSong(userId, songId);
    if (!current) throw new Error("song not found");
    const updated: SongDoc = { ...current, ...safeSongPatch(patch), updatedAt: nowIso() };
    await writeJson(songDocPath(songId), updated);
    return updated;
  }

  async deleteSong(userId: string, songId: string): Promise<void> {
    const song = await this.getSong(userId, songId);
    if (!song) throw new Error("song not found");
    const takes = await this.listTakesBySong(userId, songId);
    await Promise.all([
      fs.rm(path.join(DATA_DIR, "scores", songId), { recursive: true, force: true }),
      fs.rm(path.join(DATA_DIR, "derived", songId), { recursive: true, force: true }),
      ...takes.flatMap((take) => [
        fs.rm(audioDir(take.id), { recursive: true, force: true }),
        fs.rm(takeDocPath(take.id), { force: true }),
      ]),
    ]);
    await fs.rm(songDocPath(songId), { force: true });
  }

  async saveScoreFile(userId: string, songId: string, fileName: string, bytes: Buffer): Promise<string> {
    const song = await this.getSong(userId, songId);
    if (!song) throw new Error("song not found");
    const ext = path.extname(fileName).toLowerCase() || ".musicxml";
    const targetName = `score${ext}`;
    const filePath = scoreFilePath(songId, targetName);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, bytes);
    await this.updateSong(userId, songId, { scoreFileName: fileName });
    return filePath;
  }

  async createTake(userId: string, songId: string, input: CreateTakeInput): Promise<TakeDoc> {
    const song = await this.getSong(userId, songId);
    if (!song) throw new Error("song not found");
    const id = newTakeId();
    const timestamp = nowIso();
    const doc: TakeDoc = {
      id,
      userId,
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
      metricConfidence: { pitch: null, rhythm: null, tempo: null, dynamics: null, pedal: null },
      metricEvaluations: {},
      metricsNAReason: {},
      evaluation: null,
      measureScores: [],
      issues: [],
      aiReview: null,
      analysis: null,
      memo: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeJson(takeDocPath(id), doc);
    return doc;
  }

  async getTake(userId: string, takeId: string): Promise<TakeDoc | null> {
    try {
      const take = await readJson<TakeDoc>(takeDocPath(takeId));
      return take.userId === userId ? take : null;
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async listTakesBySong(userId: string, songId: string): Promise<TakeDoc[]> {
    const docs = await listJsonFiles<TakeDoc>(takesDir());
    return docs
      .filter((doc) => doc.userId === userId && doc.songId === songId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }

  async countTakesSince(userId: string, sinceIso: string): Promise<number> {
    const docs = await listJsonFiles<TakeDoc>(takesDir());
    return docs.filter((doc) => doc.userId === userId && doc.createdAt >= sinceIso).length;
  }

  async updateTake(userId: string, takeId: string, patch: Partial<TakeDoc>): Promise<TakeDoc> {
    const current = await this.getTake(userId, takeId);
    if (!current) throw new Error("take not found");
    if (patch.status) assertTakeTransition(current.status, patch.status);
    const updated: TakeDoc = { ...current, ...safeTakePatch(patch), updatedAt: nowIso() };
    await writeJson(takeDocPath(takeId), updated);
    return updated;
  }

  async saveAudioFile(userId: string, takeId: string, fileName: string, bytes: Buffer): Promise<string> {
    const take = await this.getTake(userId, takeId);
    if (!take) throw new Error("take not found");
    const ext = path.extname(fileName).toLowerCase() || ".webm";
    const filePath = audioFilePath(takeId, `original${ext}`);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, bytes);
    await this.updateTake(userId, takeId, { status: "uploaded" });
    return filePath;
  }
}

function safeSongPatch(patch: Partial<SongDoc>): Partial<SongDoc> {
  const allowed = { ...patch };
  delete allowed.id;
  delete allowed.userId;
  delete allowed.createdAt;
  return allowed;
}

function safeTakePatch(patch: Partial<TakeDoc>): Partial<TakeDoc> {
  const allowed = { ...patch };
  delete allowed.id;
  delete allowed.userId;
  delete allowed.songId;
  delete allowed.createdAt;
  return allowed;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function domainEtag(document: unknown): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

async function withDomainLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  await ensureDir(path.dirname(filePath));
  // proper-lockfile uses atomic mkdir ownership, mtime leases, and cross-process
  // retry/release handling on Windows; domain writes remain short critical sections.
  const release = await lockfile.lock(filePath, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 200, factor: 1, minTimeout: 25, maxTimeout: 25 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

let repository: Repository | undefined;
export function getRepository(): Repository {
  repository ??= getConfig().repositoryBackend === "azure" ? new CosmosRepository() : new LocalRepository();
  return repository;
}

export function resetRepositoryForTests(): void {
  repository = undefined;
}

export async function countTakesSince(userId: string, sinceIso: string): Promise<number> {
  return getRepository().countTakesSince(userId, sinceIso);
}

async function defaultUser(): Promise<string> {
  return (await getAuthenticatedServerUser()).id;
}
export const createSong = async (input: CreateSongInput, userId?: string) =>
  getRepository().createSong(userId ?? (await defaultUser()), input);
export const getSong = async (songId: string, userId?: string) =>
  getRepository().getSong(userId ?? (await defaultUser()), songId);
export const listSongs = async (userId?: string) =>
  getRepository().listSongs(userId ?? (await defaultUser()));
export const listSongTakeSummaries = async (songIds: string[], userId?: string) =>
  getRepository().listSongTakeSummaries(userId ?? (await defaultUser()), songIds);
export const updateSong = async (songId: string, patch: Partial<SongDoc>, userId?: string) =>
  getRepository().updateSong(userId ?? (await defaultUser()), songId, patch);
export const deleteSong = async (songId: string, userId?: string) =>
  getRepository().deleteSong(userId ?? (await defaultUser()), songId);
export const saveScoreFile = async (songId: string, fileName: string, bytes: Buffer, userId?: string) =>
  getRepository().saveScoreFile(userId ?? (await defaultUser()), songId, fileName, bytes);
export const createTake = async (songId: string, input: CreateTakeInput, userId?: string) =>
  getRepository().createTake(userId ?? (await defaultUser()), songId, input);
export const getTake = async (takeId: string, userId?: string) =>
  getRepository().getTake(userId ?? (await defaultUser()), takeId);
export const listTakesBySong = async (songId: string, userId?: string) =>
  getRepository().listTakesBySong(userId ?? (await defaultUser()), songId);
export const updateTake = async (takeId: string, patch: Partial<TakeDoc>, userId?: string) =>
  getRepository().updateTake(userId ?? (await defaultUser()), takeId, patch);
export const saveAudioFile = async (takeId: string, fileName: string, bytes: Buffer, userId?: string) =>
  getRepository().saveAudioFile(userId ?? (await defaultUser()), takeId, fileName, bytes);

export { DATA_DIR };
