import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { headers } from "next/headers";
import { getConfig } from "./config";

export interface AuthenticatedUser {
  id: string;
  roles: string[];
  plan: "free" | "paid";
  provider: "google" | "entra" | "development";
  email: string;
  displayName: string;
  emailVerified: boolean;
  isDevelopmentFallback: boolean;
}

export class AuthError extends Error {
  readonly status: 401 | 403 = 401;
  constructor(message = "authentication required") {
    super(message);
    this.name = "AuthError";
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function validEmail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function claimFromJwt(claims: JWTPayload, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = nonEmptyString(claims[name]);
    if (value) return value;
  }
  return undefined;
}

function userFromClaims(claims: JWTPayload): AuthenticatedUser {
  const id =
    typeof claims.oid === "string"
      ? claims.oid
      : typeof claims.sub === "string"
        ? claims.sub
        : "";
  if (!id) throw new AuthError("token subject is missing");
  const email = validEmail(
    claimFromJwt(claims, "email", "preferred_username", "upn")
  );
  if (!email) throw new AuthError("token email claim is missing or invalid");
  const displayName =
    claimFromJwt(claims, "name", "displayName") ??
    [claimFromJwt(claims, "given_name"), claimFromJwt(claims, "family_name")]
      .filter(Boolean)
      .join(" ");
  const resolvedDisplayName = displayName ?? email.split("@", 1)[0] ?? "Ledger Lines ユーザー";
  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((role): role is string => typeof role === "string")
    : [];
  const planClaim = claims["extension_plan"] ?? claims["plan"];
  const plan =
    planClaim === "paid" ||
    planClaim === "premium" ||
    roles.some((role) => role === "paid" || role === "premium")
      ? "paid"
      : "free";
  return {
    id,
    roles,
    plan,
    provider: "entra",
    email,
    displayName: resolvedDisplayName,
    emailVerified: claims.email_verified === true,
    isDevelopmentFallback: false,
  };
}

interface EasyAuthPrincipal {
  userId?: unknown;
  identityProvider?: unknown;
  auth_typ?: unknown;
  userDetails?: unknown;
  claims?: unknown;
  userClaims?: unknown;
}

function claimValue(claims: unknown, ...types: string[]): string | undefined {
  if (!Array.isArray(claims)) return undefined;
  const claimTypes = new Set(types);
  const claim = claims.find(
    (item): item is { typ?: unknown; val?: unknown } =>
      typeof item === "object" &&
      item !== null &&
      "typ" in item &&
      claimTypes.has(String(item.typ)),
  );
  return claim && typeof claim.val === "string" && claim.val ? claim.val : undefined;
}

function booleanClaimValue(claims: unknown, ...types: string[]): boolean {
  const value = claimValue(claims, ...types);
  return value === "true";
}

function userFromEasyAuthHeader(
  encodedPrincipal: string,
  principalId: string | null,
): AuthenticatedUser {
  let principal: EasyAuthPrincipal;
  try {
    const base64 = encodedPrincipal.replace(/-/g, "+").replace(/_/g, "/");
    principal = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as EasyAuthPrincipal;
  } catch {
    throw new AuthError("invalid Easy Auth principal");
  }
  const provider =
    typeof principal.identityProvider === "string"
      ? principal.identityProvider
      : typeof principal.auth_typ === "string"
        ? principal.auth_typ.toLowerCase()
        : "google";
  const userId =
    (typeof principal.userId === "string" && principal.userId) ||
    principalId ||
    claimValue(
      principal.claims,
      "sub",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
      "http://schemas.microsoft.com/identity/claims/objectidentifier",
    );
  if (!userId) {
    throw new AuthError("Easy Auth user id is missing");
  }
  const claims = [principal.claims, principal.userClaims];
  const email = validEmail(
    claims.map((value) =>
      claimValue(
        value,
        "email",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
        "http://schemas.microsoft.com/identity/claims/emailaddress",
        "preferred_username",
        "upn",
      )
    ).find(Boolean)
  );
  if (!email) throw new AuthError("Easy Auth email claim is missing or invalid");
  const displayName =
    nonEmptyString(principal.userDetails) ??
    claims
      .map((value) =>
        claimValue(
          value,
          "name",
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
          "http://schemas.microsoft.com/identity/claims/displayname",
        )
      )
      .find(Boolean);
  const resolvedDisplayName =
    displayName ?? email.split("@", 1)[0] ?? "Ledger Lines ユーザー";
  const normalizedProvider = provider.toLowerCase();
  const authProvider =
    normalizedProvider === "google"
      ? "google"
      : normalizedProvider === "entra" || normalizedProvider === "aad"
        ? "entra"
        : "google";
  const id = userId.includes(":") ? userId : `${authProvider}:${userId}`;
  return {
    id,
    roles: [],
    plan: "free",
    provider: authProvider,
    email,
    displayName: resolvedDisplayName,
    emailVerified: claims.some((value) =>
      booleanClaimValue(
        value,
        "email_verified",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/email_verified",
      )
    ),
    isDevelopmentFallback: false,
  };
}

/**
 * Verifies an Entra access token. The development fallback is deliberately
 * explicit and cannot be enabled by a request header or query parameter.
 */
export async function getAuthenticatedUser(request: Request): Promise<AuthenticatedUser> {
  const config = getConfig();
  const header = request.headers.get("authorization");
  if (config.authMode === "google") {
    const principal = request.headers.get("x-ms-client-principal");
    if (!principal) throw new AuthError();
    return userFromEasyAuthHeader(principal, request.headers.get("x-ms-client-principal-id"));
  }
  if (!header) {
    if (config.authMode === "development") {
      return {
        id: config.devUserId,
        roles: ["developer"],
        plan: "free",
        provider: "development",
        email: `${config.devUserId}@local.invalid`,
        displayName: "Local developer",
        emailVerified: true,
        isDevelopmentFallback: true,
      };
    }
    throw new AuthError();
  }
  if (!header.startsWith("Bearer ")) throw new AuthError("invalid authorization scheme");

  if (!config.entraIssuer || !config.entraAudience || !config.entraJwksUrl) {
    throw new AuthError("authentication is not configured");
  }
  try {
    jwks ??= createRemoteJWKSet(new URL(config.entraJwksUrl));
    const result = await jwtVerify(header.slice("Bearer ".length), jwks, {
      issuer: config.entraIssuer,
      audience: config.entraAudience,
    });
    return userFromClaims(result.payload);
  } catch {
    throw new AuthError("invalid or expired token");
  }
}

export async function getAuthenticatedServerUser(): Promise<AuthenticatedUser> {
  const requestHeaders = new Headers(await headers());
  return getAuthenticatedUser(new Request("http://localhost", { headers: requestHeaders }));
}
