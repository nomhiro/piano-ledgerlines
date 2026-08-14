@description('Azure Communication Services resource name.')
param communicationServiceName string

@description('Azure Communication Services Email resource name.')
param emailServiceName string

@description('Email domain resource name. AzureManagedDomain is provisioned by Azure.')
param emailDomainName string = 'AzureManagedDomain'

@description('Data residency location for ACS Email.')
param dataLocation string = 'Japan'

@description('Resource tags.')
param tags object = {}

@description('Whether to provision the ACS Email resources.')
param enabled bool = true

resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = if (enabled) {
  name: emailServiceName
  location: 'global'
  properties: {
    dataLocation: dataLocation
  }
  tags: tags
}

resource emailDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = if (enabled) {
  parent: emailService
  name: emailDomainName
  location: 'global'
  properties: {
    domainManagement: 'AzureManaged'
    userEngagementTracking: 'Disabled'
  }
}

resource communicationService 'Microsoft.Communication/communicationServices@2023-04-01' = if (enabled) {
  name: communicationServiceName
  location: 'global'
  properties: {
    dataLocation: dataLocation
    linkedDomains: [
      emailDomain.id
    ]
  }
  tags: tags
}

output communicationServiceName string = enabled ? communicationServiceName : ''
output communicationServiceId string = enabled ? resourceId('Microsoft.Communication/communicationServices', communicationServiceName) : ''
output endpoint string = enabled ? 'https://${communicationServiceName}.communication.azure.com' : ''
output emailServiceName string = enabled ? emailServiceName : ''
output emailDomainName string = enabled ? emailDomainName : ''
