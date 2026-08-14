import { DefaultAzureCredential } from "@azure/identity";

/**
 * Local cloud development must use the signed-in Azure CLI identity rather
 * than accidentally picking up a client secret from the shell. Hosted
 * deployments retain the full DefaultAzureCredential chain so Managed
 * Identity is used there.
 */
export function createAzureCredential(managedIdentityClientId?: string): DefaultAzureCredential {
  if (process.env.LEDGERLINES_AZURE_CLOUD === "true" && process.env.NODE_ENV !== "production") {
    // @azure/identity v4 selects the chain with this non-secret setting.
    // This keeps local cloud development on `az login`, while hosted
    // deployments retain the normal chain and Managed Identity.
    process.env.AZURE_TOKEN_CREDENTIALS = "AzureCliCredential";
  }
  return new DefaultAzureCredential(
    managedIdentityClientId ? { managedIdentityClientId } : undefined,
  );
}
