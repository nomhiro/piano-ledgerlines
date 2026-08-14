import assert from "node:assert/strict";
import test from "node:test";
import { buildLoginReturnUri, invitationStorageKey } from "./invitation-client";

test("login return URI keeps only invitation identifiers and never the secret", () => {
  const uri = buildLoginReturnUri(
    "https://ledgerlines.example",
    "/classroom-invitations/accept",
    "classroom_123",
    "invitation_456",
  );
  assert.equal(
    uri,
    "https://ledgerlines.example/classroom-invitations/accept?classroomId=classroom_123&invitationId=invitation_456",
  );
  assert.equal(uri.includes("secret"), false);
});

test("invitation storage is keyed by non-secret identifiers", () => {
  assert.equal(
    invitationStorageKey("classroom_123", "invitation_456"),
    "ledgerlines:classroom-invitation:classroom_123:invitation_456",
  );
});
