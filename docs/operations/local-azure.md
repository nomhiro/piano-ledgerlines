# Local Azure-compatible development

There are two supported local profiles:

1. **Cloud-backed local (recommended):** only Next.js runs locally; Bicep/`azd`
   provisions real dev/stg Azure services. See
   [local-azure-cloud.md](./local-azure-cloud.md).
2. **Emulator fallback:** Azurite and the Cosmos emulator run locally for
   offline/deterministic tests. This page documents that fallback.

The emulator profile runs the Azure-shaped data plane locally. It does **not** create an
Azure resource, use a subscription, or require cloud credentials:

- Azurite provides Blob Storage and Storage Queue.
- The Linux Cosmos DB emulator provides the NoSQL API.
- The coach uses the deterministic fallback (`LEDGERLINES_FOUNDRY_ENABLED=false`).
- The analysis queue uses a deterministic local completion when
  `LEDGERLINES_DETERMINISTIC_ANALYSIS=true`.

## Start

```bash
cp .env.local.azure.example .env.local.azure
npm install
npm run azure:up
npm run azure:health
npm run azure:init
npm run azure:start
```

On PowerShell, use `Copy-Item .env.local.azure.example .env.local.azure`.
`azure:start` loads the profile, checks that development auth and emulator mode
are enabled, initializes containers, and starts Next.js on port 3000.

In another terminal:

```bash
npm run test:azure-local                 # deterministic; no Docker required
SMOKE_MODE=http npm run test:azure-local # against a running local app
npm run azure:down
```

The HTTP smoke test covers song creation, score upload/completion, take
creation, audio upload, queue submission, status polling, and coach output.
The deterministic test covers the same state-machine contract when Docker is
not available.

## Emulator limitations

The Cosmos emulator uses a well-known key and a self-signed certificate. The
local Cosmos client uses a narrowly scoped emulator-only HTTPS agent (it does
not disable TLS verification for production clients). The
profile intentionally enables key authentication **only** with
`LEDGERLINES_AZURE_EMULATOR=true`; production configuration rejects emulator
keys and connection strings and uses `DefaultAzureCredential`/Managed Identity.
The emulator is not serverless, cannot model geo-replication, and is intended
for development and tests only.

The compose file runs the Linux vNext emulator over HTTPS on port 8081 and
uses port 8080 for readiness (the Data Explorer is on 1234). Docker Desktop on
Windows requires Linux containers and virtualization; the first start can take
several minutes. The vNext image supports more host architectures than the
legacy emulator, but an architecture-specific Docker image/runner may still
be needed on older ARM setups. On Linux, ensure Docker has enough memory. If
the Cosmos image cannot start, run `npm run test:azure-local` for the
deterministic integration check and use the regular local filesystem profile.

Azurite uses HTTP on ports 10000 (Blob), 10001 (Queue), and 10002 (Table).
These endpoints are local-only and the example account key is the public
Azurite development key, not an Azure secret.

## Configuration safety

`AZURE_COSMOS_KEY`, `AZURE_STORAGE_CONNECTION_STRING`, and
`AZURE_STORAGE_ACCOUNT_KEY` are accepted only in emulator mode. Cloud
deployments should set `LEDGERLINES_*` backends to `azure` but omit those
values; Cosmos, Blob, and Queue then use Managed Identity. Local auth is an
explicit development fallback (`LEDGERLINES_AUTH_MODE=development`) and uses
the configured `LEDGERLINES_DEV_USER_ID`; it must not be used in production.
The free-plan quota remains active locally (five takes per month), so quota
behavior can be exercised without an identity provider.
