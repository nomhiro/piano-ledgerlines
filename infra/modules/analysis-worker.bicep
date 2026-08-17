@description('Name of the worker Container App.')
param workerContainerAppName string

@description('Existing Container Apps managed environment name.')
param managedEnvironmentName string

@description('Fully qualified public worker image, including tag.')
param workerImage string

@description('Resource ID of the worker user-assigned managed identity.')
param workerIdentityResourceId string

@description('Client ID of the worker user-assigned managed identity.')
param workerIdentityClientId string

@description('Azure region for the Container App.')
param location string

param storageAccountUrl string
param storageQueueUrl string
param storageAccountName string
param analysisQueueName string
param scoreQueueName string
param songsContainerName string
param cosmosEndpoint string
param cosmosDatabaseName string
param audioContainerName string
param derivedContainerName string
param takesContainerName string
param scoresContainerName string
param tags object = {}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: managedEnvironmentName
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: workerContainerAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
    }
    template: {
      containers: [
        {
          name: 'analysis-worker'
          image: workerImage
          env: [
            { name: 'AZURE_CLIENT_ID', value: workerIdentityClientId }
            { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storageAccountUrl }
            { name: 'AZURE_STORAGE_QUEUE_URL', value: storageQueueUrl }
            { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storageAccountName }
            { name: 'AZURE_ANALYSIS_QUEUE', value: analysisQueueName }
            { name: 'AZURE_SCORE_QUEUE', value: scoreQueueName }
            { name: 'AZURE_COSMOS_SONGS_CONTAINER', value: songsContainerName }
            { name: 'AZURE_STORAGE_SCORES_CONTAINER', value: scoresContainerName }
            { name: 'WORKER_SCORE_VISIBILITY_TIMEOUT_SECONDS', value: '300' }
            { name: 'AZURE_COSMOS_ENDPOINT', value: cosmosEndpoint }
            { name: 'AZURE_COSMOS_DATABASE', value: cosmosDatabaseName }
            { name: 'AZURE_COSMOS_TAKES_CONTAINER', value: takesContainerName }
            { name: 'AZURE_STORAGE_AUDIO_CONTAINER', value: audioContainerName }
            { name: 'AZURE_STORAGE_DERIVED_CONTAINER', value: derivedContainerName }
            { name: 'WORKER_VISIBILITY_TIMEOUT_SECONDS', value: '1800' }
          ]
          resources: {
            cpu: 2
            memory: '4Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output workerName string = worker.name
output workerResourceId string = worker.id
