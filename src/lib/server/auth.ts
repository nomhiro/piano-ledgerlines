import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getConfig } from "./config";

export interface AuthenticatedUser {
  id: string;
  roles: string[];
  plan: "free" | "paid";
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

function userFromClaims(claims: JWTPayload): AuthenticatedUser {
  const id =
    typeof claims.oid === "string"
      ? claims.oid
      : typeof claims.sub === "string"
        ? claims.sub
        : "";
  if (!id) throw new AuthError("token subject is missing");
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
  return { id, roles, plan, isDevelopmentFallback: false };
}

/**
 * Verifies an Entra access token. The development fallback is deliberately
 * explicit and cannot be enabled by a request header or query parameter.
 */
export async function getAuthenticatedUser(request: Request): Promise<AuthenticatedUser> {
  const config = getConfig();
  const header = request.headers.get("authorization");
  if (!header) {
    if (config.authMode === "development") {
      return { id: config.devUserId, roles: ["developer"], plan: "free", isDevelopmentFallback: true };
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
