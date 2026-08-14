import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { normalizeEmail } from "./account";
import {
  assertAuthenticatedGoogleUser,
  requireActiveClassroomAccess,
  requireClassroomRole,
} from "./classroom-access";
import { classroomHasPaidEntitlement, reconcileBillableStudentQuantity, setBillableStudentQuantity } from "./billing";
import { getConfig } from "./config";
import { ConflictError, ConfigurationError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "./http";
import { getRepository, RepositoryConflictError, type Repository } from "./repository";
import { classroomMemberId } from "./ids";
import type {
  ClassroomDoc,
  ClassroomInvitationDoc,
  ClassroomMemberDoc,
  ClassroomMemberStatus,
  ClassroomInvitationReservationDoc,
  ClassroomReference,
  ClassroomRole,
  UserProfileDoc,
} from "./types";
import type { AuthenticatedUser } from "./auth";
import { getEmailSender, type EmailMessage, type EmailSender } from "./email";
import type { StripeGateway } from "./stripe";

const TOKEN_VERSION = 1;
const DEFAULT_INVITATION_TTL_DAYS = 7;
const DEFAULT_INVITE_RATE_LIMIT = 20;
const INVITATION_CREATION_LEASE_MS = 2 * 60 * 1000;

function now(): Date {
  return new Date();
}

async function reconcileTeacherSeatReservations(
  classroomId: string,
  repository: Repository,
): Promise<void> {
  if (!repository.getClassroomRecord) {
    throw new ConfigurationError("repository does not support compare-and-swap");
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const members = await repository.listClassroomMembers(classroomId);
    const current = await repository.getClassroomRecord(classroomId);
    if (!current) throw new NotFoundError("classroom not found");
    if (!current.etag) throw new ConfigurationError("repository returned no classroom etag");
    const invitationList = await repository.listClassroomInvitations(classroomId);
    const linkedInvitations = await Promise.all(
      invitationList.map((invitation) => repository.getClassroomInvitation(classroomId, invitation.id)),
    );
    const invitationById = new Map(
      linkedInvitations
        .filter((invitation): invitation is ClassroomInvitationDoc => invitation !== null)
        .map((invitation) => [invitation.id, invitation]),
    );
    const currentInvitationIds = new Set(
      Object.values(current.document.invitationReservations ?? {}).map((reservation) => reservation.invitationId),
    );
    const timestamp = now();
    for (const reservation of Object.values(current.document.invitationReservations ?? {})) {
      const invitation = linkedInvitations.find((candidate) => candidate?.id === reservation.invitationId);
      if (
        invitation?.status === "preparing" &&
        reservation.state === "linked" &&
        invitation.generation === reservation.generation &&
        invitation.reservationVersion === reservation.version
      ) {
        const finalized = await updateInvitationWithCas(invitation, (latest) => ({
          ...latest,
          status: latest.status === "preparing" ? "pending" : latest.status,
          updatedAt: now().toISOString(),
        }), repository);
        const index = linkedInvitations.findIndex((candidate) => candidate?.id === finalized.id);
        if (index >= 0) linkedInvitations[index] = finalized;
        invitationById.set(finalized.id, finalized);
      }
    }
    const reservations: Record<string, ClassroomInvitationReservationDoc> = {};
    for (const invitation of linkedInvitations) {
      if (
        !invitation ||
        !["pending", "accepting"].includes(invitation.status) ||
        invitation.id === deterministicInvitationId(classroomId, invitation.normalizedEmail, invitation.role)
      ) continue;
      const revoked = await updateInvitationWithCas(invitation, (latest) => ({
        ...latest,
        status: latest.status === "pending" || latest.status === "accepting" ? "revoked" : latest.status,
        updatedAt: now().toISOString(),
      }), repository);
      const oldIndex = linkedInvitations.findIndex((candidate) => candidate?.id === revoked.id);
      if (oldIndex >= 0) linkedInvitations[oldIndex] = revoked;
      invitationById.set(revoked.id, revoked);
    }
    for (const [key, reservation] of Object.entries(current.document.invitationReservations ?? {})) {
      const invitation = invitationById.get(reservation.invitationId);
      const liveDocument = invitation && (
        ["pending", "accepting"].includes(invitation.status) ||
        (invitation.status === "preparing" &&
          (reservation.state === "linked" || reservation.leaseExpiresAt > timestamp.toISOString()))
      );
      const missingLeaseActive = !invitation && reservation.leaseExpiresAt > timestamp.toISOString();
      if (!liveDocument && !missingLeaseActive) continue;
      reservations[key] = {
        ...reservation,
        generation: invitation?.generation ?? reservation.generation,
        version: invitation?.reservationVersion ?? reservation.version,
        state: invitation?.status === "accepting"
          ? "accepting"
          : invitation?.status === "pending"
            ? "pending"
            : reservation.state,
      };
    }
    for (const invitation of linkedInvitations) {
      if (
        !invitation ||
        !["pending", "accepting"].includes(invitation.status) ||
        currentInvitationIds.has(invitation.id)
      ) continue;
      const key = invitationReservationKey(invitation.normalizedEmail, invitation.role);
      if (reservations[key]) continue;
      reservations[key] = {
        invitationId: invitation.id,
        role: invitation.role,
        emailRoleFingerprint: key,
        state: invitation.status === "accepting" ? "accepting" : "pending",
        ownerToken: randomUUID(),
        version: randomUUID(),
        generation: invitation.generation ?? 1,
        createdAt: invitation.createdAt,
        leaseExpiresAt: invitation.expiresAt ?? timestamp.toISOString(),
      };
    }
    const teacherReservationCount = liveTeacherReservationCount(
      reservations,
      invitationById,
      members,
    );
    const activeTeacherCount = members.filter(
      (member) => member.role === "teacher" && ["active", "provisioning"].includes(member.status),
    ).length;
    const nextCount = activeTeacherCount + teacherReservationCount;
    const next = {
      ...current.document,
      reservedTeacherSeatCount: nextCount,
      teacherSeatVersion:
        (current.document.teacherSeatVersion ?? 0) + (current.document.reservedTeacherSeatCount === nextCount ? 0 : 1),
      invitationReservations: reservations,
      updatedAt: timestamp.toISOString(),
    };
    delete next.pendingInvitationKeys;
    try {
      await repository.upsertClassroom(next, { ifMatch: current.etag });
      return;
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("reservation reconciliation retries exhausted");
}

function invitationTokenSecret(): string {
  const configured = process.env.LEDGERLINES_INVITATION_TOKEN_SECRET?.trim();
  if (configured) return configured;
  if (getConfig().nodeEnv === "production") {
    throw new ConfigurationError("invitation token signing is not configured");
  }
  return "local-only-invitation-secret";
}

function invitationTtlMs(): number {
  const configured = Number(process.env.LEDGERLINES_INVITATION_TTL_DAYS ?? DEFAULT_INVITATION_TTL_DAYS);
  if (!Number.isFinite(configured) || configured < 1 || configured > 30) {
    throw new ConfigurationError("invitation expiry must be between 1 and 30 days");
  }
  return configured * 24 * 60 * 60 * 1000;
}

function rateLimitConfig(): { max: number; windowMs: number } {
  const max = Number(process.env.LEDGERLINES_INVITE_RATE_LIMIT ?? DEFAULT_INVITE_RATE_LIMIT);
  const minutes = Number(process.env.LEDGERLINES_INVITE_RATE_WINDOW_MINUTES ?? "60");
  if (!Number.isInteger(max) || max < 1 || max > 1000 || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new ConfigurationError("invitation rate limit configuration is invalid");
  }
  return { max, windowMs: minutes * 60 * 1000 };
}

function tokenHash(classroomId: string, invitationId: string, secret: string): string {
  return createHmac("sha256", invitationTokenSecret())
    .update(`${TOKEN_VERSION}:${classroomId}:${invitationId}:${secret}`)
    .digest("hex");
}

function tokenMatches(invitation: ClassroomInvitationDoc, secret: string): boolean {
  if (invitation.tokenVersion !== TOKEN_VERSION || !invitation.tokenHash || !secret) return false;
  const expected = Buffer.from(invitation.tokenHash, "hex");
  const actual = Buffer.from(tokenHash(invitation.classroomId, invitation.id, secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function tokenFingerprint(invitation: ClassroomInvitationDoc): string {
  if (!invitation.tokenHash) throw new ValidationError("invitation token is invalid");
  return createHash("sha256").update(invitation.tokenHash).digest("hex");
}

function invitationUrl(classroomId: string, invitationId: string, secret: string): string {
  const config = getConfig();
  const configuredBase = config.ledgerlinesAppBaseUrl;
  if (!configuredBase && config.nodeEnv === "production") {
    throw new ConfigurationError("public application base URL is not configured");
  }
  const base = configuredBase ?? "http://localhost:3000";
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${root}/classroom-invitations/accept#classroomId=${encodeURIComponent(classroomId)}&invitationId=${encodeURIComponent(invitationId)}&secret=${encodeURIComponent(secret)}`;
}

function invitationReservationKey(
  normalizedEmail: string,
  role: Exclude<ClassroomRole, "owner">,
): string {
  return createHash("sha256")
    .update(`${role}:${normalizedEmail}`)
    .digest("hex");
}

function deterministicInvitationId(
  classroomId: string,
  normalizedEmail: string,
  role: Exclude<ClassroomRole, "owner">,
): string {
  return `invitation_${createHmac("sha256", invitationTokenSecret())
    .update(`${classroomId}:${role}:${normalizedEmail}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function liveTeacherReservationCount(
  reservations: Record<string, ClassroomInvitationReservationDoc>,
  invitations: Map<string, ClassroomInvitationDoc>,
  members: ClassroomMemberDoc[],
): number {
  return Object.values(reservations).filter((reservation) => {
    if (reservation.role !== "teacher") return false;
    if (reservation.state !== "accepting") return true;
    const invitation = invitations.get(reservation.invitationId);
    const claimedMember = invitation?.claimedByUserId
      ? members.find((member) => member.userId === invitation.claimedByUserId && member.role === "teacher")
      : undefined;
    return !claimedMember || !["active", "provisioning"].includes(claimedMember.status);
  }).length;
}

async function consumeInvitationRateLimit(
  classroomId: string,
  userId: string,
  repository: Repository,
): Promise<void> {
  const limits = rateLimitConfig();
  const timestamp = now();
  await updateClassroomWithCas(classroomId, (current) => {
    const rate = current.invitationRateLimits?.[userId];
    const withinWindow = rate && timestamp.getTime() - new Date(rate.windowStartedAt).getTime() < limits.windowMs;
    if (withinWindow && rate.count >= limits.max) {
      throw new RateLimitError(
        "invitation rate limit exceeded",
        Math.ceil((limits.windowMs - (timestamp.getTime() - new Date(rate.windowStartedAt).getTime())) / 1000),
      );
    }
    return {
      ...current,
      invitationRateLimits: {
        ...(current.invitationRateLimits ?? {}),
        [userId]: {
          windowStartedAt: withinWindow ? rate!.windowStartedAt : timestamp.toISOString(),
          count: withinWindow ? rate!.count + 1 : 1,
        },
      },
      updatedAt: timestamp.toISOString(),
    };
  }, repository);
}

function safeInvitation(invitation: ClassroomInvitationDoc): Record<string, unknown> {
  const {
    tokenHash,
    claimedTokenFingerprint,
    acceptOperationVersion,
    claimedByUserId,
    claimedAt,
    ...publicInvitation
  } = invitation;
  void tokenHash;
  void claimedTokenFingerprint;
  void acceptOperationVersion;
  void claimedByUserId;
  void claimedAt;
  return publicInvitation;
}

async function updateClassroomWithCas(
  classroomId: string,
  update: (classroom: ClassroomDoc) => ClassroomDoc,
  repository: Repository,
): Promise<ClassroomDoc> {
  if (!repository.getClassroomRecord) throw new ConfigurationError("repository does not support compare-and-swap");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await repository.getClassroomRecord(classroomId);
    if (!current) throw new NotFoundError("classroom not found");
    if (!current.etag) throw new ConfigurationError("repository returned no etag");
    try {
      return await repository.upsertClassroom(update(current.document), { ifMatch: current.etag });
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("classroom update retries exhausted");
}

async function updateInvitationWithCas(
  invitation: ClassroomInvitationDoc,
  update: (current: ClassroomInvitationDoc) => ClassroomInvitationDoc,
  repository: Repository,
): Promise<ClassroomInvitationDoc> {
  if (!repository.getClassroomInvitationRecord) throw new ConfigurationError("repository does not support compare-and-swap");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await repository.getClassroomInvitationRecord(invitation.classroomId, invitation.id);
    if (!current) throw new NotFoundError("invitation not found");
    if (!current.etag) throw new ConfigurationError("repository returned no invitation etag");
    try {
      return await repository.upsertClassroomInvitation(update(current.document), { ifMatch: current.etag });
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("invitation update retries exhausted");
}

async function claimInvitation(
  invitation: ClassroomInvitationDoc,
  userId: string,
  secret: string,
  repository: Repository,
): Promise<ClassroomInvitationDoc> {
  const operationVersion = `accept:${invitation.id}:${userId}`;
  if (!repository.getClassroomInvitationRecord) {
    throw new ConfigurationError("repository does not support compare-and-swap");
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentRecord = await repository.getClassroomInvitationRecord(
      invitation.classroomId,
      invitation.id,
    );
    if (!currentRecord) throw new NotFoundError("invitation not found");
    if (!currentRecord.etag) throw new ConfigurationError("repository returned no invitation etag");
    const current = currentRecord.document;
    if (!current.expiresAt || current.expiresAt <= now().toISOString()) {
      if (current.status === "pending") {
        await expireInvitation(current, repository);
      }
      throw new ConflictError("invitation has expired");
    }
    if (!tokenMatches(current, secret)) throw new ValidationError("invitation token is invalid");
    const fingerprint = tokenFingerprint(current);
    if (current.status === "accepting") {
      if (
        current.acceptOperationVersion === operationVersion &&
        current.claimedByUserId === userId &&
        current.claimedTokenFingerprint === fingerprint
      ) {
        await markInvitationReservationState(current, "accepting", repository);
        return current;
      }
      throw new ConflictError("invitation acceptance is already in progress");
    }
    if (current.status !== "pending") {
      throw new ConflictError("invitation is no longer available");
    }
    try {
      const claimed = await repository.upsertClassroomInvitation(
        {
          ...current,
          status: "accepting",
          acceptOperationVersion: operationVersion,
          claimedByUserId: userId,
          claimedTokenFingerprint: fingerprint,
          claimedAt: now().toISOString(),
          updatedAt: now().toISOString(),
        },
        { ifMatch: currentRecord.etag },
      );
      await markInvitationReservationState(claimed, "accepting", repository);
      return claimed;
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("invitation claim retries exhausted");
}

async function updateMemberWithCas(
  member: ClassroomMemberDoc,
  update: (current: ClassroomMemberDoc) => ClassroomMemberDoc,
  repository: Repository,
): Promise<ClassroomMemberDoc> {
  if (!repository.getClassroomMemberRecord) throw new ConfigurationError("repository does not support member compare-and-swap");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await repository.getClassroomMemberRecord(member.classroomId, member.userId);
    if (!current) throw new NotFoundError("classroom member not found");
    if (!current.etag) throw new ConfigurationError("repository returned no member etag");
    try {
      return await repository.upsertClassroomMember(update(current.document), { ifMatch: current.etag });
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("member update retries exhausted");
}

async function updateProfileWithCas(
  userId: string,
  update: (profile: UserProfileDoc) => UserProfileDoc,
  repository: Repository,
): Promise<UserProfileDoc> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await repository.getUserRecord(userId);
    if (!current) throw new NotFoundError("user profile not found");
    if (!current.etag) throw new ConfigurationError("repository returned no profile etag");
    try {
      return await repository.upsertUserRecord(update(current.document), { ifMatch: current.etag }).then((result) => result.document);
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("profile update retries exhausted");
}

function appendRef(
  profile: UserProfileDoc,
  classroomId: string,
  role: ClassroomRole,
  status: ClassroomReference["status"],
  operationVersion: string,
  generation: number,
): UserProfileDoc {
  const refs = profile.classroomRefs.filter((ref) => ref.classroomId !== classroomId);
  refs.push({ classroomId, role, status, operationVersion, generation });
  return { ...profile, classroomRefs: refs, updatedAt: now().toISOString() };
}

async function ensureUserProfile(user: AuthenticatedUser, repository: Repository): Promise<UserProfileDoc> {
  const existing = await repository.getUser(user.id);
  if (existing) return existing;
  const profile: UserProfileDoc = {
    id: user.id,
    type: "user",
    email: user.email,
    normalizedEmail: normalizeEmail(user.email),
    displayName: user.displayName,
    provider: user.provider,
    providerSyncedAt: now().toISOString(),
    settings: {
      dailyPracticeMinutes: 30,
      locale: "ja-JP",
      allowTrainingUse: false,
      notifyOnAnalysisComplete: true,
    },
    classroomRefs: [],
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  };
  try {
    return await repository.upsertUser(profile, { ifNoneMatch: true });
  } catch (error) {
    if (!(error instanceof RepositoryConflictError)) throw error;
    const raced = await repository.getUser(user.id);
    if (!raced) throw error;
    return raced;
  }
}

function assertInviterCanInvite(inviterRole: ClassroomRole, role: Exclude<ClassroomRole, "owner">): void {
  if (inviterRole === "owner") return;
  if (inviterRole === "teacher" && role === "student") return;
  throw new ForbiddenError("your classroom role cannot send this invitation");
}

async function sendInvitation(
  invitation: ClassroomInvitationDoc,
  secret: string,
  repository: Repository,
  sender: EmailSender,
): Promise<ClassroomInvitationDoc> {
  const classroom = await repository.getClassroom(invitation.classroomId);
  const key = invitationReservationKey(invitation.normalizedEmail, invitation.role);
  const reservation = classroom?.invitationReservations?.[key];
  const latest = await repository.getClassroomInvitation(invitation.classroomId, invitation.id);
  if (
    !reservation ||
    reservation.invitationId !== invitation.id ||
    reservation.generation !== invitation.generation ||
    reservation.version !== invitation.reservationVersion ||
    reservation.state !== "linked" ||
    !latest ||
    latest.status !== "pending" ||
    latest.generation !== invitation.generation ||
    latest.reservationVersion !== invitation.reservationVersion
  ) {
    throw new ConflictError("invitation delivery fence changed");
  }
  const message: EmailMessage = {
    to: invitation.email,
    subject: "Ledger Lines 教室への招待",
    text: `Ledger Lines の教室への招待です。次のリンクから承諾してください。\n${invitationUrl(invitation.classroomId, invitation.id, secret)}`,
    html: `<p>Ledger Lines の教室への招待です。</p><p><a href="${invitationUrl(invitation.classroomId, invitation.id, secret)}">招待を承諾する</a></p>`,
  };
  try {
    await sender.send(message);
  } catch (error) {
    const messageText = error instanceof Error ? error.name : "delivery failed";
    const failed = await updateInvitationWithCas(invitation, (current) => ({
      ...current,
      deliveryStatus: "failed",
      deliveryError: messageText,
      updatedAt: now().toISOString(),
    }), repository);
    return failed;
  }
  return updateInvitationWithCas(invitation, (current) => ({
    ...current,
    deliveryStatus: "sent",
    deliveryError: null,
    sentAt: current.sentAt ?? now().toISOString(),
    updatedAt: now().toISOString(),
  }), repository);
}

export interface CreateInvitationInput {
  email: string;
  role: Exclude<ClassroomRole, "owner">;
}

async function reserveInvitationReservation(
  classroomId: string,
  key: string,
  invitationId: string,
  role: Exclude<ClassroomRole, "owner">,
  inviterId: string,
  ownerToken: string,
  version: string,
  generation: number,
  createdAt: Date,
  limits: { max: number; windowMs: number },
  repository: Repository,
): Promise<void> {
  if (!repository.getClassroomRecord) {
    throw new ConfigurationError("repository does not support compare-and-swap");
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await reconcileTeacherSeatReservations(classroomId, repository);
    const members = await repository.listClassroomMembers(classroomId);
    const current = await repository.getClassroomRecord(classroomId);
    if (!current) throw new NotFoundError("classroom not found");
    if (!current.etag) throw new ConfigurationError("repository returned no classroom etag");
    const entries = Object.entries(current.document.invitationReservations ?? {});
    const linked = await Promise.all(
      entries.map(([, reservation]) => repository.getClassroomInvitation(classroomId, reservation.invitationId)),
    );
    const invitationById = new Map(
      linked
        .filter((invitation): invitation is ClassroomInvitationDoc => invitation !== null)
        .map((invitation) => [invitation.id, invitation]),
    );
    const reservations: Record<string, ClassroomInvitationReservationDoc> = {};
    const timestamp = now();
    for (const [reservationKey, reservation] of entries) {
      const invitation = invitationById.get(reservation.invitationId);
      if (!invitation && reservation.leaseExpiresAt <= timestamp.toISOString()) continue;
      if (invitation && !["pending", "accepting"].includes(invitation.status)) continue;
      reservations[reservationKey] = reservation;
    }
    if (reservations[key]) {
      throw new ConflictError("a pending invitation already exists for this address and role");
    }
    const activeTeacherCount = members.filter(
      (member) => member.role === "teacher" && ["active", "provisioning"].includes(member.status),
    ).length;
    const liveTeacherCount = liveTeacherReservationCount(reservations, invitationById, members);
    if (role === "teacher" && activeTeacherCount + liveTeacherCount >= Math.max(0, current.document.teacherLimit - 1)) {
      throw new ConflictError("teacher seat limit reached");
    }
    const rate = current.document.invitationRateLimits?.[inviterId];
    const withinWindow = rate && createdAt.getTime() - new Date(rate.windowStartedAt).getTime() < limits.windowMs;
    if (withinWindow && rate.count >= limits.max) {
      throw new RateLimitError(
        "invitation rate limit exceeded",
        Math.ceil((limits.windowMs - (createdAt.getTime() - new Date(rate.windowStartedAt).getTime())) / 1000),
      );
    }
    reservations[key] = {
      invitationId,
      role,
      emailRoleFingerprint: key,
      state: "creating",
      ownerToken,
      version,
      generation,
      createdAt: createdAt.toISOString(),
      leaseExpiresAt: new Date(createdAt.getTime() + INVITATION_CREATION_LEASE_MS).toISOString(),
    };
    const next = {
      ...current.document,
      reservedTeacherSeatCount: activeTeacherCount + liveTeacherCount + (role === "teacher" ? 1 : 0),
      teacherSeatVersion:
        (current.document.teacherSeatVersion ?? 0) + (role === "teacher" ? 1 : 0),
      invitationReservations: reservations,
      invitationRateLimits: {
        ...(current.document.invitationRateLimits ?? {}),
        [inviterId]: {
          windowStartedAt: withinWindow ? rate!.windowStartedAt : createdAt.toISOString(),
          count: withinWindow ? rate!.count + 1 : 1,
        },
      },
      updatedAt: timestamp.toISOString(),
    };
    try {
      await repository.upsertClassroom(next, { ifMatch: current.etag });
      return;
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("invitation reservation retries exhausted");
}

async function transitionReservationToCommitting(
  classroomId: string,
  key: string,
  invitationId: string,
  ownerToken: string,
  version: string,
  generation: number,
  repository: Repository,
): Promise<void> {
  if (!repository.getClassroomRecord) throw new ConfigurationError("repository does not support compare-and-swap");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await repository.getClassroomRecord(classroomId);
    if (!current?.etag) throw new ConflictError("invitation reservation ownership was lost");
    const reservation = current.document.invitationReservations?.[key];
    if (
      !reservation ||
      reservation.invitationId !== invitationId ||
      reservation.ownerToken !== ownerToken ||
      reservation.version !== version ||
      reservation.generation !== generation ||
      reservation.state !== "creating" ||
      reservation.leaseExpiresAt <= now().toISOString()
    ) {
      throw new ConflictError("invitation reservation ownership was lost");
    }
    const next = {
      ...current.document,
      invitationReservations: {
        ...current.document.invitationReservations,
        [key]: { ...reservation, state: "committing" as const },
      },
      updatedAt: now().toISOString(),
    };
    try {
      await repository.upsertClassroom(next, { ifMatch: current.etag });
      return;
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("invitation reservation commit fence retries exhausted");
}

async function linkInvitationReservation(
  invitation: ClassroomInvitationDoc,
  key: string,
  ownerToken: string,
  version: string,
  repository: Repository,
): Promise<void> {
  if (!repository.getClassroomRecord) throw new ConfigurationError("repository does not support compare-and-swap");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await repository.getClassroomRecord(invitation.classroomId);
    if (!current?.etag) throw new ConflictError("invitation reservation ownership was lost");
    const reservation = current.document.invitationReservations?.[key];
    if (
      !reservation ||
      reservation.invitationId !== invitation.id ||
      reservation.ownerToken !== ownerToken ||
      reservation.version !== version ||
      reservation.state !== "committing" ||
      reservation.generation !== invitation.generation
    ) {
      throw new ConflictError("invitation reservation ownership was lost");
    }
    const next = {
      ...current.document,
      invitationReservations: {
        ...current.document.invitationReservations,
        [key]: { ...reservation, state: "linked" as const },
      },
      updatedAt: now().toISOString(),
    };
    try {
      await repository.upsertClassroom(next, { ifMatch: current.etag });
      return;
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("invitation reservation link retries exhausted");
}

async function publishPreparedInvitation(
  invitation: ClassroomInvitationDoc,
  version: string,
  repository: Repository,
): Promise<ClassroomInvitationDoc> {
  const classroom = await repository.getClassroom(invitation.classroomId);
  const key = invitationReservationKey(invitation.normalizedEmail, invitation.role);
  const reservation = classroom?.invitationReservations?.[key];
  if (
    !reservation ||
    reservation.invitationId !== invitation.id ||
    reservation.version !== version ||
    reservation.generation !== invitation.generation ||
    reservation.state !== "linked"
  ) {
    throw new ConflictError("invitation reservation link fence changed");
  }
  return updateInvitationWithCas(invitation, (current) => {
    if (
      current.status !== "preparing" ||
      current.generation !== invitation.generation ||
      current.reservationVersion !== version
    ) {
      throw new ConflictError("invitation preparation fence changed");
    }

    return {
      ...current,
      status: "pending",
      updatedAt: now().toISOString(),
    };
  }, repository);
}

async function persistPreparingInvitation(
  invitation: ClassroomInvitationDoc,
  repository: Repository,
): Promise<void> {
  if (!repository.getClassroomInvitationRecord) {
    throw new ConfigurationError("repository does not support compare-and-swap");
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await repository.getClassroomInvitationRecord(invitation.classroomId, invitation.id);
    if (!current) {
      try {
        await repository.createClassroomInvitation(invitation, { ifNoneMatch: true });
        return;
      } catch (error) {
        if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
        continue;
      }
    }
    if (!current.etag) throw new ConfigurationError("repository returned no invitation etag");
    if (["pending", "accepting"].includes(current.document.status)) {
      throw new ConflictError("a pending invitation already exists for this address and role");
    }
    try {
      await repository.upsertClassroomInvitation(invitation, { ifMatch: current.etag });
      return;
    } catch (error) {
      if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
    }
  }
  throw new RepositoryConflictError("invitation preparation retries exhausted");
}

async function compensateOrphanInvitation(
  invitation: ClassroomInvitationDoc,
  ownerToken: string,
  version: string,
  generation: number,
  repository: Repository,
): Promise<void> {
  const current = await repository.getClassroomInvitationRecord?.(invitation.classroomId, invitation.id);
  if (
    current?.etag &&
    current.document.status === "pending" &&
    current.document.reservationVersion === version &&
    current.document.generation === generation
  ) {
    await repository.upsertClassroomInvitation(
      { ...current.document, status: "revoked", updatedAt: now().toISOString() },
      { ifMatch: current.etag },
    );
  }
  await releasePendingReservation(invitation, repository, ownerToken, version, generation);
}

export async function createClassroomInvitation(
  classroomId: string,
  inviter: AuthenticatedUser,
  input: CreateInvitationInput,
  repository: Repository = getRepository(),
  sender: EmailSender = getEmailSender(),
): Promise<{ invitation: Record<string, unknown>; invitationUrl: string }> {
  const access = await requireActiveClassroomAccess(classroomId, inviter.id, ["owner", "teacher"], repository);
  assertInviterCanInvite(access.member.role, input.role);
  const email = input.email.trim();
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 320) {
    throw new ValidationError("email is invalid");
  }
  const pendingInvitations = await repository.listClassroomInvitations(classroomId);
  for (const pending of pendingInvitations) {
    if (pending.status === "pending" && (!pending.expiresAt || pending.expiresAt <= now().toISOString())) {
      await expireInvitation(pending, repository);
    }
  }
  await reconcileTeacherSeatReservations(classroomId, repository);
  const existingMembers = await repository.listClassroomMembers(classroomId);
  for (const member of existingMembers.filter((candidate) => candidate.status !== "removed")) {
    const profile = await repository.getUser(member.userId);
    if (profile?.normalizedEmail === normalizedEmail) throw new ConflictError("user is already a classroom member");
  }
  const limits = rateLimitConfig();
  const key = invitationReservationKey(normalizedEmail, input.role);
  const invitationId = deterministicInvitationId(classroomId, normalizedEmail, input.role);
  const existingInvitation = await repository.getClassroomInvitation(classroomId, invitationId);
  if (existingInvitation && ["pending", "accepting"].includes(existingInvitation.status)) {
    throw new ConflictError("a pending invitation already exists for this address and role");
  }
  const generation = (existingInvitation?.generation ?? 0) + 1;
  const reservationOwnerToken = randomUUID();
  const reservationVersion = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const url = invitationUrl(classroomId, invitationId, secret);
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + invitationTtlMs()).toISOString();
  await reserveInvitationReservation(
    classroomId,
    key,
    invitationId,
    input.role,
    inviter.id,
    reservationOwnerToken,
    reservationVersion,
    generation,
    createdAt,
    limits,
    repository,
  );
  const invitation: ClassroomInvitationDoc = {
    id: invitationId,
    type: "classroom-invitation",
    classroomId,
    email,
    normalizedEmail,
    role: input.role,
    status: "preparing",
    tokenHash: tokenHash(classroomId, invitationId, secret),
    tokenVersion: TOKEN_VERSION,
    generation,
    reservationVersion,
    expiresAt,
    createdByUserId: inviter.id,
    acceptedByUserId: null,
    sentAt: null,
    resentAt: null,
    deliveryStatus: "pending",
    deliveryError: null,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  };
  try {
    await transitionReservationToCommitting(
      classroomId,
      key,
      invitationId,
      reservationOwnerToken,
      reservationVersion,
      generation,
      repository,
    );
    await persistPreparingInvitation(invitation, repository);
    await linkInvitationReservation(
      invitation,
      key,
      reservationOwnerToken,
      reservationVersion,
      repository,
    );
    const publishedInvitation = await publishPreparedInvitation(
      invitation,
      reservationVersion,
      repository,
    );
    const delivered = await sendInvitation(publishedInvitation, secret, repository, sender);
    return {
      invitation: safeInvitation(delivered),
      invitationUrl: url,
    };
  } catch (error) {
    await compensateOrphanInvitation(
      invitation,
      reservationOwnerToken,
      reservationVersion,
      generation,
      repository,
    );
    throw error;
  }
}

async function markInvitationReservationState(
  invitation: ClassroomInvitationDoc,
  state: "pending" | "accepting",
  repository: Repository,
): Promise<void> {
  const key = invitationReservationKey(invitation.normalizedEmail, invitation.role);
  await updateClassroomWithCas(invitation.classroomId, (current) => {
    const reservations = { ...(current.invitationReservations ?? {}) };
    const existing = reservations[key];
    if (!existing || existing.invitationId !== invitation.id) return current;
    if (
      (invitation.generation !== undefined && existing.generation !== invitation.generation) ||
      (invitation.reservationVersion && existing.version !== invitation.reservationVersion)
    ) {
      throw new ConflictError("invitation reservation generation changed");
    }
    reservations[key] = {
      invitationId: invitation.id,
      role: invitation.role,
      emailRoleFingerprint: key,
      state,
      ownerToken: existing.ownerToken ?? randomUUID(),
      version: existing.version ?? randomUUID(),
      generation: existing.generation ?? invitation.generation ?? 1,
      createdAt: existing?.createdAt ?? invitation.createdAt,
      leaseExpiresAt: existing?.leaseExpiresAt ?? invitation.expiresAt ?? new Date().toISOString(),
    };
    return { ...current, invitationReservations: reservations, updatedAt: now().toISOString() };
  }, repository);
}

async function releasePendingReservation(
  invitation: ClassroomInvitationDoc,
  repository: Repository,
  ownerToken?: string,
  version?: string,
  generation?: number,
): Promise<void> {
  await updateClassroomWithCas(invitation.classroomId, (current) => {
    const reservations = { ...(current.invitationReservations ?? {}) };
    const key = Object.keys(reservations).find(
      (candidate) => reservations[candidate].invitationId === invitation.id,
    );
    if (!key) return current;
    const reservation = reservations[key];
    if (
      ownerToken &&
      version &&
      generation !== undefined &&
      (reservation.ownerToken !== ownerToken ||
        reservation.version !== version ||
        reservation.generation !== generation)
    ) return current;
    delete reservations[key];
    return {
      ...current,
      invitationReservations: reservations,
      updatedAt: now().toISOString(),
    };
  }, repository);
  await reconcileTeacherSeatReservations(invitation.classroomId, repository);
}

async function fenceAcceptingInvitationsForMember(
  classroomId: string,
  userId: string,
  repository: Repository,
): Promise<void> {
  const invitations = await repository.listClassroomInvitations(classroomId);
  for (const invitation of invitations) {
    if (invitation.status !== "accepting" || invitation.claimedByUserId !== userId) continue;
    const revoked = await updateInvitationWithCas(invitation, (current) => {
      if (current.status !== "accepting" || current.claimedByUserId !== userId) return current;
      return { ...current, status: "revoked", updatedAt: now().toISOString() };
    }, repository);
    if (revoked.status === "revoked") await releasePendingReservation(revoked, repository);
  }
}

async function acceptPendingReservation(invitation: ClassroomInvitationDoc, repository: Repository): Promise<void> {
  await releasePendingReservation(invitation, repository);
}

export async function listClassroomInvitations(
  classroomId: string,
  userId: string,
  repository: Repository = getRepository(),
): Promise<Record<string, unknown>[]> {
  const access = await requireActiveClassroomAccess(classroomId, userId, ["owner", "teacher"], repository);
  const invitations = await repository.listClassroomInvitations(classroomId);
  const visible = access.member.role === "owner" ? invitations : invitations.filter((invitation) => invitation.role === "student");
  return Promise.all(visible.map(async (invitation) => {
    if (invitation.status === "pending" && (!invitation.expiresAt || invitation.expiresAt <= now().toISOString())) {
      const expired = await expireInvitation(invitation, repository);
      return safeInvitation(expired);
    }
    return safeInvitation(invitation);
  }));
}

export async function resendClassroomInvitation(
  classroomId: string,
  invitationId: string,
  userId: string,
  repository: Repository = getRepository(),
  sender: EmailSender = getEmailSender(),
): Promise<Record<string, unknown>> {
  const access = await requireActiveClassroomAccess(classroomId, userId, ["owner", "teacher"], repository);
  const existing = await repository.getClassroomInvitation(classroomId, invitationId);
  if (!existing) throw new NotFoundError("invitation not found");
  if (access.member.role === "teacher" && existing.role !== "student") throw new ForbiddenError();
  if (existing.status !== "pending" || !existing.expiresAt) throw new ConflictError("only pending invitations can be resent");
  const secret = randomBytes(32).toString("base64url");
  const url = invitationUrl(classroomId, invitationId, secret);
  const generation = (existing.generation ?? 0) + 1;
  const reservationVersion = randomUUID();
  await consumeInvitationRateLimit(classroomId, userId, repository);
  const refreshed = await updateInvitationWithCas(existing, (current) => {
    if (current.status !== "pending") {
      throw new ConflictError("invitation acceptance is already in progress");
    }
    return {
      ...current,
      tokenHash: tokenHash(classroomId, invitationId, secret),
      tokenVersion: TOKEN_VERSION,
      generation,
      reservationVersion,
      expiresAt: new Date(now().getTime() + invitationTtlMs()).toISOString(),
      resentAt: now().toISOString(),
      deliveryStatus: "pending",
      deliveryError: null,
      updatedAt: now().toISOString(),
    };
  }, repository);
  await updateClassroomWithCas(classroomId, (current) => {
    const key = invitationReservationKey(existing.normalizedEmail, existing.role);
    const reservations = { ...(current.invitationReservations ?? {}) };
    const reservation = reservations[key];
    if (!reservation || reservation.invitationId !== invitationId) {
      throw new ConflictError("invitation reservation is missing");
    }
    if (reservation.generation > generation) {
      throw new ConflictError("invitation generation has advanced");
    }
    reservations[key] = {
      ...reservation,
      state: "linked",
      generation,
      version: reservationVersion,
      leaseExpiresAt: refreshed.expiresAt ?? reservation.leaseExpiresAt,
    };
    return { ...current, invitationReservations: reservations, updatedAt: now().toISOString() };
  }, repository);
  const delivered = await sendInvitation(refreshed, secret, repository, sender);
  return { invitation: safeInvitation(delivered), invitationUrl: url };
}

async function expireInvitation(invitation: ClassroomInvitationDoc, repository: Repository): Promise<ClassroomInvitationDoc> {
  const changed = await updateInvitationWithCas(invitation, (current) => {
    if (current.status !== "pending" || (current.expiresAt && current.expiresAt > now().toISOString())) return current;
    return { ...current, status: "expired", tokenHash: current.tokenHash, updatedAt: now().toISOString() };
  }, repository);
  if (changed.status === "expired") await releasePendingReservation(changed, repository);
  return changed;
}

export async function revokeClassroomInvitation(
  classroomId: string,
  invitationId: string,
  userId: string,
  repository: Repository = getRepository(),
): Promise<void> {
  const access = await requireActiveClassroomAccess(classroomId, userId, ["owner", "teacher"], repository);
  const existing = await repository.getClassroomInvitation(classroomId, invitationId);
  if (!existing) throw new NotFoundError("invitation not found");
  if (access.member.role === "teacher" && existing.role !== "student") throw new ForbiddenError();
  if (existing.status !== "pending") throw new ConflictError("invitation is no longer pending");
  const revoked = await updateInvitationWithCas(existing, (current) => {
    if (current.status !== "pending") {
      throw new ConflictError("invitation acceptance is already in progress");
    }
    return { ...current, status: "revoked", updatedAt: now().toISOString() };
  }, repository);
  if (revoked.status === "revoked") await releasePendingReservation(revoked, repository);
}

async function ensureMemberProvisioning(
  classroomId: string,
  userId: string,
  role: Exclude<ClassroomRole, "owner">,
  operationVersion: string,
  repository: Repository,
): Promise<ClassroomMemberDoc> {
  const existing = await repository.getClassroomMember(classroomId, userId);
  const timestamp = now().toISOString();
  if (!existing) {
    const member: ClassroomMemberDoc = {
      id: classroomMemberId(classroomId, userId),
      type: "classroom-member",
      classroomId,
      userId,
      role,
      status: "provisioning",
      operationVersion,
      billingDesiredStatus: role === "student" ? "active" : null,
      generation: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      return await repository.createClassroomMember(member, { ifNoneMatch: true });
    } catch (error) {
      if (!(error instanceof RepositoryConflictError)) throw error;
      const raced = await repository.getClassroomMember(classroomId, userId);
      if (!raced) throw error;
      return raced;
    }
  }
  if (existing.role !== role) throw new ConflictError("user already has a different classroom role");
  if (existing.status === "removing") throw new ConflictError("membership removal is in progress");
  if (existing.status === "active") {
    if (existing.operationVersion && existing.operationVersion !== operationVersion) {
      throw new ConflictError("membership belongs to another invitation generation");
    }
    return existing;
  }
  if (existing.status === "provisioning") {
    if (existing.operationVersion && existing.operationVersion !== operationVersion) {
      throw new ConflictError("membership provisioning belongs to another invitation generation");
    }
    return existing;
  }
  return updateMemberWithCas(existing, (current) => {
    if (current.status !== "removed") {
      throw new ConflictError("membership changed while starting a new generation");
    }
    return {
      ...current,
      status: "provisioning",
      operationVersion,
      billingDesiredStatus: role === "student" ? "active" : null,
      generation: (current.generation ?? 0) + 1,
      updatedAt: timestamp,
    };
  }, repository);
}

async function reserveStudentProfile(
  profile: UserProfileDoc,
  classroomId: string,
  operationVersion: string,
  generation: number,
  repository: Repository,
): Promise<UserProfileDoc> {
  const existing = profile.classroomRefs.find((ref) => ref.role === "student" && ref.status !== "removed");
  if (existing && existing.classroomId !== classroomId) {
    throw new ConflictError("student already belongs to another classroom");
  }
  const current = profile.classroomRefs.find((ref) => ref.classroomId === classroomId);
  if (
    current?.role === "student" &&
    current.status === "active" &&
    current.operationVersion === operationVersion &&
    current.generation === generation
  ) return profile;
  if (
    current?.role === "student" &&
    current.status === "provisioning" &&
    current.operationVersion === operationVersion &&
    current.generation === generation
  ) return profile;
  if (current?.role === "student" && current.status === "removing") {
    throw new ConflictError("student membership removal is in progress");
  }
  return updateProfileWithCas(profile.id, (latest) => {
    const conflictRef = latest.classroomRefs.find((ref) => ref.role === "student" && ref.status !== "removed" && ref.classroomId !== classroomId);
    if (conflictRef) throw new ConflictError("student already belongs to another classroom");
    const latestRef = latest.classroomRefs.find((ref) => ref.classroomId === classroomId);
    if (
      latestRef &&
      latestRef.status !== "removed" &&
      (latestRef.operationVersion !== operationVersion || latestRef.generation !== generation)
    ) {
      throw new ConflictError("student profile belongs to another membership generation");
    }
    return appendRef(latest, classroomId, "student", "provisioning", operationVersion, generation);
  }, repository);
}

async function ensureProfileRefProvisioning(
  userId: string,
  classroomId: string,
  role: Exclude<ClassroomRole, "owner">,
  operationVersion: string,
  generation: number,
  repository: Repository,
): Promise<void> {
  await updateProfileWithCas(userId, (profile) => {
    const current = profile.classroomRefs.find((ref) => ref.classroomId === classroomId);
    if (
      current?.role === role &&
      current.status === "provisioning" &&
      current.operationVersion === operationVersion &&
      current.generation === generation
    ) return profile;
    if (
      current?.role === role &&
      current.status === "active" &&
      current.operationVersion === operationVersion &&
      current.generation === generation
    ) return profile;
    if (current && current.status !== "removed") {
      throw new ConflictError("profile membership generation changed while provisioning");
    }
    return appendRef(profile, classroomId, role, "provisioning", operationVersion, generation);
  }, repository);
}

async function activateProfileRef(
  userId: string,
  classroomId: string,
  role: Exclude<ClassroomRole, "owner">,
  operationVersion: string,
  generation: number,
  repository: Repository,
): Promise<void> {
  await updateProfileWithCas(userId, (profile) => {
    const current = profile.classroomRefs.find((ref) => ref.classroomId === classroomId);
    if (
      current?.role === role &&
      current.status === "active" &&
      current.operationVersion === operationVersion &&
      current.generation === generation
    ) return profile;
    if (
      !current ||
      current.role !== role ||
      current.status !== "provisioning" ||
      current.operationVersion !== operationVersion ||
      current.generation !== generation
    ) {
      throw new ConflictError("profile membership generation changed while activating");
    }
    return {
      ...profile,
      classroomRefs: profile.classroomRefs.map((ref) =>
        ref.classroomId === classroomId
          ? { ...ref, status: "active", operationVersion, generation }
          : ref,
      ),
      updatedAt: now().toISOString(),
    };
  }, repository);
}

async function markProfileRefRemoving(
  userId: string,
  classroomId: string,
  operationVersion: string,
  generation: number,
  repository: Repository,
): Promise<void> {
  await updateProfileWithCas(userId, (profile) => {
    const current = profile.classroomRefs.find((ref) => ref.classroomId === classroomId);
    if (!current || current.status === "removed") return profile;
    if (current.operationVersion && current.generation !== generation) {
      throw new ConflictError("profile membership generation changed while removing");
    }
    return {
      ...profile,
      classroomRefs: profile.classroomRefs.map((ref) =>
        ref.classroomId === classroomId
          ? { ...ref, status: "removing", operationVersion, generation }
          : ref,
      ),
      updatedAt: now().toISOString(),
    };
  }, repository);
}

async function removeProfileRef(
  userId: string,
  classroomId: string,
  operationVersion: string,
  generation: number,
  repository: Repository,
): Promise<void> {
  await updateProfileWithCas(userId, (profile) => {
    const current = profile.classroomRefs.find((ref) => ref.classroomId === classroomId);
    if (!current || current.status === "removed") return profile;
    if (
      current.status !== "removing" ||
      current.operationVersion !== operationVersion ||
      current.generation !== generation
    ) {
      throw new ConflictError("profile removal generation changed");
    }
    return {
      ...profile,
      classroomRefs: profile.classroomRefs.filter((ref) => ref.classroomId !== classroomId),
      updatedAt: now().toISOString(),
    };
  }, repository);
}

async function markInvitationAccepted(
  invitation: ClassroomInvitationDoc,
  userId: string,
  operationVersion: string,
  tokenFingerprintValue: string,
  repository: Repository,
): Promise<void> {
  const accepted = await updateInvitationWithCas(invitation, (current) => {
    if (current.status === "accepted") {
      if (current.acceptedByUserId === userId) return current;
      throw new ConflictError("invitation has already been used");
    }
    if (
      current.status !== "accepting" ||
      current.acceptOperationVersion !== operationVersion ||
      current.claimedByUserId !== userId ||
      current.claimedTokenFingerprint !== tokenFingerprintValue ||
      current.generation !== invitation.generation ||
      current.reservationVersion !== invitation.reservationVersion ||
      tokenFingerprint(current) !== tokenFingerprintValue
    ) {
      throw new ConflictError("invitation acceptance fence changed");
    }
    if (!current.expiresAt || current.expiresAt <= now().toISOString()) throw new ConflictError("invitation has expired");
    return {
      ...current,
      status: "accepted",
      acceptedByUserId: userId,
      tokenHash: current.tokenHash,
      updatedAt: now().toISOString(),
    };
  }, repository);
  await acceptPendingReservation(accepted, repository);
}

export async function acceptClassroomInvitation(
  input: { classroomId: string; invitationId: string; secret: string },
  user: AuthenticatedUser,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<{ classroomId: string; role: Exclude<ClassroomRole, "owner">; status: ClassroomMemberStatus }> {
  assertAuthenticatedGoogleUser(user);
  if (!input.secret || input.secret.length < 32 || input.secret.length > 128) throw new ValidationError("invitation token is invalid");
  const loadedInvitation = await repository.getClassroomInvitation(input.classroomId, input.invitationId);
  if (!loadedInvitation || !tokenMatches(loadedInvitation, input.secret)) throw new ValidationError("invitation token is invalid");
  if (loadedInvitation.status === "accepted" && loadedInvitation.acceptedByUserId === user.id) {
    await reconcileTeacherSeatReservations(input.classroomId, repository);
    const member = await repository.getClassroomMember(input.classroomId, user.id);
    if (member?.status === "active" && member.role !== "owner") {
      return { classroomId: input.classroomId, role: member.role, status: member.status };
    }
  }
  if (loadedInvitation.status !== "pending" && loadedInvitation.status !== "accepting") {
    throw new ConflictError("invitation is no longer available");
  }
  if (!loadedInvitation.expiresAt || loadedInvitation.expiresAt <= now().toISOString()) {
    if (loadedInvitation.status === "pending") await expireInvitation(loadedInvitation, repository);
    throw new ConflictError("invitation has expired");
  }
  if (normalizeEmail(user.email) !== loadedInvitation.normalizedEmail) {
    throw new ForbiddenError("Google account email does not match the invitation");
  }
  await reconcileTeacherSeatReservations(input.classroomId, repository);
  const invitation = await claimInvitation(loadedInvitation, user.id, input.secret, repository);
  if (invitation.status !== "accepting" || !invitation.acceptOperationVersion || !invitation.claimedTokenFingerprint) {
    throw new ConflictError("invitation acceptance claim is incomplete");
  }
  const operationVersion = invitation.acceptOperationVersion;
  const claimedTokenFingerprint = invitation.claimedTokenFingerprint;
  const classroom = await repository.getClassroom(input.classroomId);
  if (!classroom) throw new NotFoundError("classroom not found");
  if (classroom.appStatus !== "active" || !classroomHasPaidEntitlement(classroom.billing.status)) {
    throw new ForbiddenError("classroom subscription is not active");
  }
  const profile = await ensureUserProfile(user, repository);
  const existingMember = await repository.getClassroomMember(input.classroomId, user.id);
  const generation = existingMember?.status === "removed"
    ? (existingMember.generation ?? 0) + 1
    : existingMember?.generation ?? 1;
  if (invitation.role === "student") {
    await reserveStudentProfile(profile, input.classroomId, operationVersion, generation, repository);
    const member = await ensureMemberProvisioning(input.classroomId, user.id, "student", operationVersion, repository);
    if (member.generation !== generation) throw new ConflictError("membership generation changed while accepting");
    if (member.status !== "active") {
      const desiredMember = await updateMemberWithCas(member, (current) => ({
        ...current,
        billingDesiredStatus: "active",
        updatedAt: now().toISOString(),
      }), repository);
      await setBillableStudentQuantity(
        {
          classroomId: input.classroomId,
          quantity: 0,
          operationVersion,
          authoritativeMembershipCount: true,
        },
        repository,
        stripe,
      );
      await updateMemberWithCas(desiredMember, (current) => {
        if (
          current.status === "active" &&
          current.operationVersion === operationVersion &&
          current.generation === generation
        ) return current;
        if (current.status === "active") {
          throw new ConflictError("membership generation changed while billing was in progress");
        }
        if (
          current.status !== "provisioning" ||
          current.operationVersion !== operationVersion ||
          current.generation !== generation
        ) {
          throw new ConflictError("membership changed while billing was in progress");
        }
        return {
          ...current,
          status: "active",
          operationVersion,
          updatedAt: now().toISOString(),
        };
      }, repository);
    }
    await activateProfileRef(user.id, input.classroomId, "student", operationVersion, generation, repository);
    await markInvitationAccepted(invitation, user.id, operationVersion, claimedTokenFingerprint, repository);
    return { classroomId: input.classroomId, role: "student", status: "active" };
  }
  const member = await ensureMemberProvisioning(input.classroomId, user.id, "teacher", operationVersion, repository);
  if (member.generation !== generation) throw new ConflictError("membership generation changed while accepting");
  await ensureProfileRefProvisioning(user.id, input.classroomId, "teacher", operationVersion, generation, repository);
  if (member.status !== "active") {
    await updateMemberWithCas(member, (current) => {
      if (
        current.status === "active" &&
        current.operationVersion === operationVersion &&
        current.generation === generation
      ) return current;
      if (current.status === "active") {
        throw new ConflictError("membership generation changed while accepting");
      }
      if (
        current.status !== "provisioning" ||
        current.operationVersion !== operationVersion ||
        current.generation !== generation
      ) {
        throw new ConflictError("membership changed while accepting");
      }
      return { ...current, status: "active", operationVersion, generation, updatedAt: now().toISOString() };
    }, repository);
  }
  await activateProfileRef(user.id, input.classroomId, "teacher", operationVersion, generation, repository);
  await markInvitationAccepted(invitation, user.id, operationVersion, claimedTokenFingerprint, repository);
  return { classroomId: input.classroomId, role: "teacher", status: "active" };
}

export async function removeClassroomMember(
  classroomId: string,
  targetUserId: string,
  actorUserId: string,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<{ status: "removed" | "removing" }> {
  const target = await repository.getClassroomMember(classroomId, targetUserId);
  if (!target) throw new NotFoundError("classroom member not found");
  const classroom = await repository.getClassroom(classroomId);
  if (!classroom) throw new NotFoundError("classroom not found");
  if (target.role === "owner") throw new ForbiddenError("classroom owner cannot be removed");
  const actor = await repository.getClassroomMember(classroomId, actorUserId);
  if (!actor || actor.status !== "active" || (target.role === "teacher" ? actor.role !== "owner" : actor.role !== "owner" && targetUserId !== actorUserId)) {
    throw new ForbiddenError();
  }
  if (target.status === "removed") {
    if (target.operationVersion && target.generation) {
      await removeProfileRef(targetUserId, classroomId, target.operationVersion, target.generation, repository);
    }
    await fenceAcceptingInvitationsForMember(classroomId, targetUserId, repository);
    if (target.role === "teacher") await reconcileTeacherSeatReservations(classroomId, repository);
    return { status: "removed" };
  }
  if (target.status !== "removing" && !classroomHasPaidEntitlement(classroom.billing.status)) {
    throw new ForbiddenError("classroom subscription is not active");
  }
  const removing = target.status === "removing"
    ? target
    : await updateMemberWithCas(target, (current) => ({
      ...current,
      status: "removing",
      operationVersion: `remove:${randomUUID()}`,
      billingDesiredStatus: current.role === "student" ? "removed" : current.billingDesiredStatus,
      generation: current.generation ?? 1,
      updatedAt: now().toISOString(),
    }), repository);
  const removalOperationVersion = removing.operationVersion;
  const removalGeneration = removing.generation ?? 1;
  if (!removalOperationVersion) throw new ConfigurationError("removal operation is missing");
  await markProfileRefRemoving(
    targetUserId,
    classroomId,
    removalOperationVersion,
    removalGeneration,
    repository,
  );
  if (removing.role === "student") {
    await setBillableStudentQuantity(
      {
        classroomId,
        quantity: 0,
        operationVersion: removalOperationVersion,
        authoritativeMembershipCount: true,
      },
      repository,
      stripe,
    );
  }
  await updateMemberWithCas(removing, (current) => {
    if (
      current.status !== "removing" ||
      current.operationVersion !== removalOperationVersion ||
      (current.generation ?? 1) !== removalGeneration
    ) {
      throw new ConflictError("membership removal generation changed");
    }
    return { ...current, status: "removed", updatedAt: now().toISOString() };
  }, repository);
  await removeProfileRef(targetUserId, classroomId, removalOperationVersion, removalGeneration, repository);
  await fenceAcceptingInvitationsForMember(classroomId, targetUserId, repository);
  if (removing.role === "teacher") await reconcileTeacherSeatReservations(classroomId, repository);
  return { status: "removed" };
}

export async function reconcileClassroomBilling(
  classroomId: string,
  ownerUserId: string,
  repository: Repository = getRepository(),
  stripe?: StripeGateway,
): Promise<ClassroomDoc> {
  await requireClassroomRole(classroomId, ownerUserId, ["owner"], repository);
  await reconcileTeacherSeatReservations(classroomId, repository);
  const operation = (await repository.getClassroom(classroomId))?.billing.studentQuantityOperation;
  return reconcileBillableStudentQuantity(
    classroomId,
    operation?.operationVersion ?? `reconcile:${randomUUID()}`,
    repository,
    stripe,
  );
}
