@description('Globally unique Key Vault name (3-24 alphanumeric characters and hyphens).')
@minLength(3)
@maxLength(24)
param keyVaultName string

param location string
param enablePurgeProtection bool = false
param tags object = {}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: enablePurgeProtection
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

output name string = keyVault.name
output resourceId string = keyVault.id
output uri string = keyVault.properties.vaultUri
