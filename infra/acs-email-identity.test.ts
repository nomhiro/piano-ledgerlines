import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("ACS email role is scoped to the dedicated sender identity", async () => {
  const [rbac, identity, main] = await Promise.all([
    fs.readFile("infra/modules/rbac.bicep", "utf8"),
    fs.readFile("infra/modules/identity.bicep", "utf8"),
    fs.readFile("infra/main.bicep", "utf8"),
  ]);
  assert.match(rbac, /emailSenderCommunicationEmailRole/);
  assert.doesNotMatch(rbac, /webCommunicationEmailRole/);
  assert.match(rbac, /emailSenderPrincipalId/);
  assert.match(identity, /emailSenderIdentity/);
  assert.match(main, /emailSenderPrincipalId: identity\.outputs\.emailSenderPrincipalId/);
});
