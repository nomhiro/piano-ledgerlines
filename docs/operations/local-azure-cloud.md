# Cloud-backed local Azure development

The recommended local integration profile runs only the Next.js process on the
developer machine. Cosmos DB, Blob Storage, Storage Queue, and (optionally) AI
Foundry are real Azure resources provisioned by the existing Bicep/`azd`
deployment. Use a dedicated `dev` or `stg` environment: local development
auth is an explicit fallback, but all data written by this profile is real
cloud data.

The emulator profile remains available as an offline fallback in
[local-azure.md](./local-azure.md).

## Provision or select an isolated environment

Do not run these commands against production. Provisioning is the only step
that creates Azure resources; the local scripts never provision or delete them.

```powershell
az login
azd auth login
azd env select ledgerlines-dev
# Or create a new environment and set its subscription/location first:
# azd env new ledgerlines-dev
# azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
# azd env set AZURE_LOCATION japaneast
# azd env set AZURE_RESOURCE_GROUP ledgerlines-dev-rg
azd provision
azd env get-values
azd show
```

Use a separate `ledgerlines-stg` environment for staging. The `dev` and `stg`
parameter files use the same production-equivalent service types (Cosmos DB
Serverless, StorageV2, RBAC, and optional Foundry). Key Vault purge protection
is enabled in every environment because Azure policy may require it and it is
irreversible once enabled.

## Grant the signed-in developer data-plane access

The Bicep RBAC module grants the hosted web/worker identities. The local
Azure CLI identity also needs data-plane roles. Run the following once per
isolated environment, substituting values from `azd show` or the Azure portal.
These commands grant access; they do not create keys or connection strings.

```powershell
$rg = "ledgerlines-dev-rg"
$account = "<storage-account-name>"
$cosmos = "<cosmos-account-name>"
$storageId = az storage account show -g $rg -n $account --query id -o tsv
$cosmosId = az cosmosdb show -g $rg -n $cosmos --query id -o tsv
$user = az ad signed-in-user show --query id -o tsv

az role assignment create --assignee-object-id $user --assignee-principal-type User `
  --role "Storage Blob Data Contributor" --scope $storageId
az role assignment create --assignee-object-id $user --assignee-principal-type User `
  --role "Storage Queue Data Contributor" --scope $storageId
az cosmosdb sql role assignment create -g $rg -a $cosmos `
  --scope "/" --principal-id $user `
  --role-definition-id "00000000-0000-0000-0000-000000000002"
```

If Foundry is enabled, also assign `Cognitive Services OpenAI User` on that
account. RBAC propagation can take several minutes.

## Configure and run the local app

```powershell
Copy-Item .env.local.azure-cloud.example .env.local.azure-cloud
python -m pip install music21
npm run azure:cloud:check
npm run azure:cloud:start
```

The cloud-backed local profile runs the existing reference-score parser on the
developer machine after a MusicXML, MXL, or MIDI score upload. It downloads the
private score from Azure Blob Storage, writes the parsed `reference.json` back
to the `derived` container, and updates the song in Cosmos DB. `music21` is
therefore required locally. This synchronous local-development path is not a
replacement for the hosted production worker.

`azure:cloud:check` loads the selected `.env.local.azure-cloud` profile,
resolves endpoint and resource names from `azd env get-values` and the latest
read-only `az deployment group list` outputs, and then checks:

- an Azure CLI token from `DefaultAzureCredential`;
- HTTPS Cosmos, Blob, and Queue endpoints (never localhost);
- Cosmos database and `songs`/`takes` containers;
- Blob containers and the analysis queue;
- Foundry token/data-plane access when Foundry is enabled.

Use `npm run azure:cloud:init` only when a non-destructive initialization is
needed. It uses `createIfNotExists` for the database, application containers,
Blob containers, and queue; it never deletes, resets, or replaces data.

The profile rejects emulator flags, Cosmos keys, Storage keys, and connection
strings. The app uses the Azure CLI credential locally. Hosted deployments use
the same SDK constructors with the normal `DefaultAzureCredential` chain,
including Managed Identity. No credentials are written to the repository.

## Data and auth safety

`LEDGERLINES_AUTH_MODE=development` maps requests to the configured
`LEDGERLINES_DEV_USER_ID`; it is intentionally explicit and must not be used
for production. Keep that ID and the `dev`/`stg` resources isolated from other
developers. The quota and application state are real Azure data, so remove
test records through the normal application/admin process rather than
destroying the resource group.
