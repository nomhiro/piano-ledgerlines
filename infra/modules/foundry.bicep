@description('Set false to keep model provisioning optional until quota and model availability are confirmed.')
param enabled bool = false

param location string
@minLength(3)
@maxLength(64)
param accountName string
param deploymentName string = 'coach'
param modelName string = 'gpt-4o-mini'
param modelVersion string = '2024-07-18'
param principalIds array = []
param tags object = {}

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = if (enabled) {
  name: accountName
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = if (enabled) {
  parent: account
  name: deploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: 1
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
}

resource openAiUserAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in principalIds: if (enabled) {
  name: guid(account.id, principalId, '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  scope: account
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  }
}]

output enabled bool = enabled
output endpoint string = account.?properties.endpoint ?? ''
output accountName string = account.?name ?? ''
output deploymentName string = deployment.?name ?? ''
