// LLMWiki MCP Server — Azure AI Search infrastructure provisioning (Phase 2)
//
// Deploy with:
//   az deployment group create \
//     --resource-group <RG> \
//     --template-file bicep/search.bicep \
//     --parameters searchServiceName=llmwiki-search-<unique>

@minValue(1)
@maxValue(5)
param searchServiceCapacity int = 1

param location string = resourceGroup().location

var uniqueSuffix = substring(toLower(guid(resourceGroup().id, 'llmwiki')), 0, 6)
var storageAccName = 'lwmkstrg${uniqueSuffix}'

//------------------------------------------------------------------------------
// Azure Storage Account (for corpus blob storage + ingest log)
//------------------------------------------------------------------------------
resource storageAcc 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
}

//------------------------------------------------------------------------------
// Container for corpus raw documents (operators drop files here)
//------------------------------------------------------------------------------
resource corpusContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  name: '${storageAccName}/default/wiki-corpus'
  properties: {}
  dependsOn: [storageAcc]
}

//------------------------------------------------------------------------------
// Container for ingest audit log entries (append-only)
//------------------------------------------------------------------------------
resource ingestLogContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  name: '${storageAccName}/default/ingest-log'
  properties: {}
  dependsOn: [storageAcc]
}

//------------------------------------------------------------------------------
// Azure AI Search Service
//------------------------------------------------------------------------------
resource searchSvc 'Microsoft.Search/searchServices@2024-07-01-preview' = {
  name: 'search-${uniqueSuffix}'
  location: location
  sku: {
    name: 'standard'
  }
  kind: 'search'

  properties: {
    replicaCount: searchServiceCapacity
    partitionCount: 1
    hostingMode: 'default'
    
    semanticSearch: {
      kind: 'free'
    }
    
    // Private endpoint only in production (IL5). Local dev = public endpoint.
    networkRuleSet: {
      defaultAction: 'allowPrivate'
      ipRules: []
    }
  }
}

//------------------------------------------------------------------------------
// Outputs for consumption by the MCP server and Azure Functions app
//------------------------------------------------------------------------------
output searchServiceName string = searchSvc.name
output searchServiceUrl string = 'https://${searchSvc.name}.search.windows.net'
output storageAccountName string = storageAcc.name
output storageAccountEndpoint string = storageAcc.primaryEndpoints.blob
