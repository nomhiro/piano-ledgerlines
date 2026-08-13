targetScope = 'resourceGroup'

@description('Short environment name used in resource names and tags.')
@allowed([
  'dev'
  'stg'
  'prod'
])
param environmentName string

@description('Azure region for the resource group resources.')
param location string = resourceGroup().location

@description('Lowercase application prefix. Keep it short because Storage and Key Vault names have length limits.')
@minLength(3)
@maxLength(18)
param resourceNamePrefix string = 'ledgerlines-${environmentName}'

@description('Set true only after confirming that the selected region supports the requested model deployment.')
param enableFoundry bool = false

@description('Azure OpenAI-compatible model deployment name.')
param foundryDeploymentName string = 'coach'

@description('Model family to deploy when enableFoundry is true.')
param foundryModelName string = 'gpt-4o-mini'

@description('Model version to deploy when enableFoundry is true.')
param foundryModelVersion string = '2024-07-18'

@description('Use purge protection for Key Vaults. Azure policy may require this to be enabled.')
param enablePurgeProtection bool = true

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param logAnalyticsRetentionInDays int = environmentName == 'prod' ? 90 : 30

@description('Deploy the queue-consuming analysis worker Container App.')
param enableWorkerHosting bool = false

@description('Existing Container Apps managed environment name.')
param containerEnvironmentName string = ''

@description('Worker image reference in GitHub Container Registry.')
param workerImage string = ''

@description('Worker Container App name.')
param workerContainerAppName string = '${resourceNamePrefix}-analysis-worker'

var normalizedPrefix = toLower(replace(replace(resourceNamePrefix, '-', ''), '_', ''))
var nameSuffix = uniqueString(subscription().id, resourceGroup().id)
var storageAccountName = take('${normalizedPrefix}${nameSuffix}', 24)
var keyVaultName = take('${normalizedPrefix}-kv-${nameSuffix}', 24)
var cosmosAccountName = take('${normalizedPrefix}-cosmos-${nameSuffix}', 44)
var foundryAccountName = take('${normalizedPrefix}-ai-${nameSuffix}', 64)
var webIdentityName = take('${resourceNamePrefix}-web', 128)
var workerIdentityName = take('${resourceNamePrefix}-worker', 128)

var blobContainers = [
  'scores'
  'audio'
  'derived'
  'work'
]

var queues = [
  'analysis-jobs'
]

var cosmosContainers = [
  {
    name: 'users'
    partitionKey: '/id'
  }
  {
    name: 'songs'
    partitionKey: '/userId'
  }
  {
    name: 'takes'
    partitionKey: '/userId'
  }
  {
    name: 'conversations'
    partitionKey: '/userId'
  }
  {
    name: 'comments'
    partitionKey: '/songId'
  }
  {
    name: 'assignments'
    partitionKey: '/teacherId'
  }
  {
    name: 'shares'
    partitionKey: '/ownerId'
  }
]

var storageBlobEndpoint = storage.outputs.blobEndpoint
var storageBaseUrl = endsWith(storageBlobEndpoint, '/') ? substring(storageBlobEndpoint, 0, max(0, length(storageBlobEndpoint) - 1)) : storageBlobEndpoint

module identity './modules/identity.bicep' = {
  name: '${environmentName}-identities'
  params: {
    location: location
    webIdentityName: webIdentityName
    workerIdentityName: workerIdentityName
    tags: {
      environment: environmentName
      component: 'identity'
      managedBy: 'bicep'
    }
  }
}

module storage './modules/storage.bicep' = {
  name: '${environmentName}-storage'
  params: {
    location: location
    storageAccountName: storageAccountName
    blobContainerNames: blobContainers
    queueNames: queues
    tags: {
      environment: environmentName
      component: 'storage'
      managedBy: 'bicep'
    }
  }
}

module monitoring './modules/monitoring.bicep' = {
  name: '${environmentName}-monitoring'
  params: {
    location: location
    workspaceName: take('${resourceNamePrefix}-logs-${nameSuffix}', 63)
    appInsightsName: take('${resourceNamePrefix}-appi-${nameSuffix}', 260)
    retentionInDays: logAnalyticsRetentionInDays
    tags: {
      environment: environmentName
      component: 'monitoring'
      managedBy: 'bicep'
    }
  }
}

module keyVault './modules/key-vault.bicep' = {
  name: '${environmentName}-key-vault'
  params: {
    location: location
    keyVaultName: keyVaultName
    enablePurgeProtection: enablePurgeProtection
    tags: {
      environment: environmentName
      component: 'secrets'
      managedBy: 'bicep'
    }
  }
}

module cosmos './modules/cosmos.bicep' = {
  name: '${environmentName}-cosmos'
  params: {
    location: location
    accountName: cosmosAccountName
    databaseName: 'ledgerlines'
    containers: cosmosContainers
    tags: {
      environment: environmentName
      component: 'database'
      managedBy: 'bicep'
    }
  }
}

module foundry './modules/foundry.bicep' = {
  name: '${environmentName}-foundry'
  params: {
    location: location
    accountName: foundryAccountName
    enabled: enableFoundry
    deploymentName: foundryDeploymentName
    modelName: foundryModelName
    modelVersion: foundryModelVersion
    principalIds: [
      identity.outputs.webPrincipalId
      identity.outputs.workerPrincipalId
    ]
    tags: {
      environment: environmentName
      component: 'ai'
      managedBy: 'bicep'
    }
  }
}

module rbac './modules/rbac.bicep' = {
  name: '${environmentName}-rbac'
  params: {
    storageAccountName: storage.outputs.name
    cosmosAccountName: cosmos.outputs.accountName
    keyVaultName: keyVault.outputs.name
    webPrincipalId: identity.outputs.webPrincipalId
    workerPrincipalId: identity.outputs.workerPrincipalId
  }
}

module analysisWorker './modules/analysis-worker.bicep' = if (enableWorkerHosting) {
  name: '${environmentName}-analysis-worker'
  params: {
    workerContainerAppName: workerContainerAppName
    managedEnvironmentName: containerEnvironmentName
    workerImage: workerImage
    workerIdentityResourceId: identity.outputs.workerResourceId
    workerIdentityClientId: identity.outputs.workerClientId
    location: location
    storageAccountUrl: storageBaseUrl
    storageQueueUrl: endsWith(storage.outputs.queueEndpoint, '/') ? substring(storage.outputs.queueEndpoint, 0, max(0, length(storage.outputs.queueEndpoint) - 1)) : storage.outputs.queueEndpoint
    storageAccountName: storage.outputs.name
    analysisQueueName: 'analysis-jobs'
    cosmosEndpoint: cosmos.outputs.endpoint
    cosmosDatabaseName: cosmos.outputs.databaseName
    audioContainerName: 'audio'
    derivedContainerName: 'derived'
    takesContainerName: 'takes'
    tags: {
      environment: environmentName
      component: 'analysis-worker'
      managedBy: 'bicep'
    }
  }
}

output environmentName string = environmentName
output resourceGroupName string = resourceGroup().name
output location string = location
output storageAccountName string = storage.outputs.name
output storageBlobEndpoint string = storageBlobEndpoint
output storageAccountUrl string = storageBaseUrl
output storageQueueUrl string = endsWith(storage.outputs.queueEndpoint, '/') ? substring(storage.outputs.queueEndpoint, 0, max(0, length(storage.outputs.queueEndpoint) - 1)) : storage.outputs.queueEndpoint
output analysisQueueName string = 'analysis-jobs'
output cosmosAccountName string = cosmos.outputs.accountName
output cosmosEndpoint string = cosmos.outputs.endpoint
output cosmosDatabaseName string = cosmos.outputs.databaseName
output keyVaultName string = keyVault.outputs.name
output keyVaultUri string = keyVault.outputs.uri
output logAnalyticsWorkspaceName string = monitoring.outputs.workspaceName
output applicationInsightsName string = monitoring.outputs.appInsightsName
@secure()
output applicationInsightsConnectionString string = monitoring.outputs.connectionString
output webManagedIdentityName string = identity.outputs.webName
output webManagedIdentityPrincipalId string = identity.outputs.webPrincipalId
output workerManagedIdentityName string = identity.outputs.workerName
output workerManagedIdentityPrincipalId string = identity.outputs.workerPrincipalId
output workerManagedIdentityClientId string = identity.outputs.workerClientId
output foundryEnabled bool = enableFoundry
output foundryEndpoint string = foundry.outputs.endpoint
output foundryDeploymentName string = foundry.outputs.deploymentName
output appImageConfiguration string = 'Hosting is intentionally not provisioned: publish an app image, then add a web service to azure.yaml.'
output workerImageConfiguration string = enableWorkerHosting ? workerImage : 'Worker hosting disabled. Set enableWorkerHosting=true and provide workerImage.'
