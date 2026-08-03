@description('Globally unique Cosmos DB account name.')
param accountName string

param location string
param databaseName string
param containers array
param tags object = {}

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

resource sqlContainers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = [for container in containers: {
  parent: database
  name: container.name
  properties: {
    resource: {
      id: container.name
      partitionKey: {
        paths: [
          container.partitionKey
        ]
        kind: 'Hash'
      }
    }
  }
}]

output accountName string = account.name
output resourceId string = account.id
output endpoint string = account.properties.documentEndpoint
output databaseName string = database.name
