@description('Deployment region for the user-assigned identities.')
param location string

@description('Name for the web/API user-assigned identity.')
param webIdentityName string

@description('Name for the analysis worker user-assigned identity.')
param workerIdentityName string

@description('Name for the dedicated ACS Email sender user-assigned identity.')
param emailSenderIdentityName string

param tags object = {}

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: webIdentityName
  location: location
  tags: tags
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: workerIdentityName
  location: location
  tags: tags
}

resource emailSenderIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: emailSenderIdentityName
  location: location
  tags: tags
}

output webName string = webIdentity.name
output webPrincipalId string = webIdentity.properties.principalId
output webClientId string = webIdentity.properties.clientId
output webResourceId string = webIdentity.id
output workerName string = workerIdentity.name
output workerPrincipalId string = workerIdentity.properties.principalId
output workerClientId string = workerIdentity.properties.clientId
output workerResourceId string = workerIdentity.id
output emailSenderName string = emailSenderIdentity.name
output emailSenderPrincipalId string = emailSenderIdentity.properties.principalId
output emailSenderClientId string = emailSenderIdentity.properties.clientId
output emailSenderResourceId string = emailSenderIdentity.id
