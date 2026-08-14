@description('Existing Storage account name.')
param storageAccountName string

@description('Existing Cosmos DB account name.')
param cosmosAccountName string

@description('Existing Key Vault name.')
param keyVaultName string

param webPrincipalId string
param workerPrincipalId string
@description('Existing ACS Communication Service name when email is enabled.')
param communicationServiceName string = ''
@description('Whether to assign ACS email permissions to the dedicated email sender identity.')
param enableCommunicationEmail bool = false
@description('Dedicated ACS email sender identity principal ID.')
param emailSenderPrincipalId string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' existing = {
  name: cosmosAccountName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource communicationService 'Microsoft.Communication/communicationServices@2023-04-01' existing = if (enableCommunicationEmail) {
  name: communicationServiceName
}

var blobContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var queueSenderRoleId = 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'
var queueProcessorRoleId = '8a0f0c08-91a1-4084-bc3d-661d67233fed'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'
var communicationEmailOwnerRoleId = '09976791-48a7-449e-bb21-39d1a415f350'

resource webBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, webPrincipalId, blobContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: webPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRoleId)
  }
}

resource workerBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, workerPrincipalId, blobContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRoleId)
  }
}

resource webQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, webPrincipalId, queueSenderRoleId)
  scope: storageAccount
  properties: {
    principalId: webPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueSenderRoleId)
  }
}

resource workerQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, workerPrincipalId, queueProcessorRoleId)
  scope: storageAccount
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueProcessorRoleId)
  }
}

resource webKeyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, webPrincipalId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: webPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource workerKeyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, workerPrincipalId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

resource webCosmosRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, webPrincipalId, cosmosDataContributorRoleId)
  properties: {
    principalId: webPrincipalId
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    scope: cosmosAccount.id
  }
}

resource workerCosmosRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, workerPrincipalId, cosmosDataContributorRoleId)
  properties: {
    principalId: workerPrincipalId
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    scope: cosmosAccount.id
  }
}

resource emailSenderCommunicationEmailRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableCommunicationEmail) {
  name: guid(communicationService.id, emailSenderPrincipalId, communicationEmailOwnerRoleId)
  scope: communicationService
  properties: {
    principalId: emailSenderPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', communicationEmailOwnerRoleId)
  }
}
