# Greenhouse Resume Builder - Development Guide

## Quick Start (Local Development)

### Prerequisites

1. **Node.js** (v20 or later)
2. **PostgreSQL** (local or Azure)
3. **Azure Functions Core Tools** (v4)
   ```bash
   npm install -g azure-functions-core-tools@4
   ```
4. **Azure CLI** (optional, for Azure resources)

### 1. Clone and Install

```bash
# Install dependencies for all workspaces
npm ci

# Build shared packages first
npm run build -w @greenhouse-resume-builder/shared
```

### 2. Configure Environment

The project uses a single `.env` file at the root level that all services load.

```bash
# .env already exists with local development defaults
# Edit it to add your Azure service endpoints if needed
```

**Key Environment Variables for Local Development:**

```bash
# PostgreSQL (local)
PGHOST=localhost
PGPORT=5432
PGDATABASE=resume_builder
PGUSER=postgres
PGPASSWORD=postgres

# Auth (dev mode - bypasses Azure AD)
ALLOW_DEV_AUTH_BYPASS=true
AZURE_AD_JWKS_URI=
AZURE_AD_CLIENT_ID=

# Azure Functions (local emulator)
AzureWebJobsStorage=UseDevelopmentStorage=true
```

### 3. Set Up PostgreSQL

**Option A: Local PostgreSQL**

```bash
# Install PostgreSQL locally
# Create database
psql -U postgres -c "CREATE DATABASE resume_builder;"

# Tables are auto-created on first API startup
```

**Option B: Azure PostgreSQL**

```bash
# Update .env with your Azure PostgreSQL connection
PGHOST=<your-server>.postgres.database.azure.com
PGUSER=<your-user>
PGPASSWORD=<your-password>
PGSSLMODE=require
```

### 4. Run the Stack

#### Terminal 1: API Server

```bash
cd api
npm run dev
```

The API will start on http://localhost:3001

#### Terminal 2: UI (React + Vite)

```bash
cd ui
npm run dev
```

The UI will start on http://localhost:5173

#### Terminal 3: Azure Functions (Optional)

```bash
cd functions
npm run start:dev
```

Functions will start on http://localhost:7071

## VS Code Debugging

The project includes pre-configured debug configurations in `.vscode/launch.json`:

### Debug Configurations

1. **Debug API Server** - Attach debugger to the API server
2. **Debug API Server (tsx watch)** - Debug with hot reload
3. **Debug Azure Functions** - Attach to Functions runtime
4. **Debug UI (Chrome)** - Debug React app in Chrome
5. **Debug Full Stack** - Debug API + UI together

### How to Debug

1. Open VS Code in the project root
2. Press `F5` or go to Run & Debug
3. Select a configuration and click the green play button
4. Set breakpoints in your TypeScript files

## Azure Entra ID Authentication

### Development Mode (Default)

The `.env` file has `ALLOW_DEV_AUTH_BYPASS=true` by default, which:

- Accepts any request without validating tokens
- Sets placeholder `userId` and `tenantId`
- **Never use in production**

### Production Mode (Azure Entra ID)

To enable real Azure AD authentication:

1. **Create an App Registration in Azure Portal**
   - Go to Azure Portal > Entra ID > App Registrations
   - Create new registration
   - Note the Application (client) ID and Tenant ID

2. **Update .env**

   ```bash
   AZURE_TENANT_ID=<your-tenant-id>
   AZURE_AD_CLIENT_ID=<your-client-id>
   AZURE_AD_JWKS_URI=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys
   ALLOW_DEV_AUTH_BYPASS=false
   ```

3. **Get an Access Token**

   ```bash
   # Using Azure CLI
   az login
   az account get-access-token --resource <your-client-id> --query accessToken -o tsv
   ```

4. **Make Authenticated Requests**
   ```bash
   curl -H "Authorization: Bearer <token>" http://localhost:3001/api/v1/stats
   ```

### Azure Government / DoD IL5

For sovereign cloud deployments:

```bash
# Update .env for Azure Government
AZURE_AD_ISSUER_PREFIXES=https://login.microsoftonline.us/,https://sts.windows.net/
AZURE_AUTHORITY_HOST=https://login.microsoftonline.us
AZURE_SEARCH_ENDPOINT_SUFFIX=search.azure.us
AZURE_STORAGE_ENDPOINT_SUFFIX=core.usgovcloudapi.net
```

## Environment Variables

All environment variables are loaded from `.env` at the project root. The file is already created with sensible defaults for local development.

### How It Works

1. **Centralized Loading**: `shared/src/env.ts` loads `.env` and `.env.local`
2. **API**: Imports `shared/src/env.ts` at the top of `api/src/server.ts`
3. **Functions**: Imports `functions/src/env.ts` in entry points
4. **Path Resolution**: All loaders dynamically find the project root

### Adding New Variables

1. Add to `.env` file
2. Add to `.env.example` for documentation
3. Update `shared/src/env.ts` to export it (optional)

## Project Structure

```
greenhouse-resume-builder/
├── .env                        # Environment configuration (all services)
├── .vscode/                    # VS Code debug & task configs
│   ├── launch.json             # Debug configurations
│   ├── tasks.json              # Build tasks
│   └── settings.json           # Editor settings
├── api/                        # Express REST API
│   ├── src/
│   │   ├── server.ts           # Entry point (loads env)
│   │   ├── db/                 # PostgreSQL client & repos
│   │   ├── middleware/         # Auth middleware (Entra ID)
│   │   ├── routes/             # REST endpoints
│   │   └── search/             # Azure AI Search
│   └── package.json
├── functions/                  # Azure Durable Functions
│   ├── src/
│   │   ├── env.ts              # Functions env loader
│   │   ├── pipeline/           # Orchestrator & HTTP trigger
│   │   └── activities/         # Function activities
│   └── package.json
├── ui/                         # React + Vite
│   ├── src/
│   │   └── App.tsx
│   └── package.json
├── shared/                     # Shared types & utilities
│   ├── src/
│   │   ├── env.ts              # Centralized env loader
│   │   └── interfaces.ts       # DTOs
│   └── package.json
└── capabilities/               # Modular capabilities
    ├── mcp-core/               # Shared MCP utilities
    ├── ingestion/              # Document ingestion
    ├── quality/                # Quality checks
    ├── relationships/          # Relationship inference
    ├── temporal/               # Temporal analysis
    ├── geospatial/             # Location services
    └── discovery/              # Search & discovery
```

## Common Tasks

### Build Everything

```bash
npm run build --workspaces
```

### Build Specific Workspace

```bash
npm run build -w @greenhouse-resume-builder/api
npm run build -w @greenhouse-resume-builder/ui
npm run build -w @greenhouse-resume-builder/azure-functions
```

### Clean Build Artifacts

```bash
# Remove all dist/ and node_modules/
npm run clean --workspaces --if-present
```

### Test API Health

```bash
curl http://localhost:3001/health
```

### Test With Auth Bypass

```bash
# Any Bearer token works in dev mode
curl -H "Authorization: Bearer dev-token" http://localhost:3001/api/v1/stats
```

## Troubleshooting

### "Cannot find module" errors

```bash
# Rebuild shared package first
npm run build -w @greenhouse-resume-builder/shared
npm ci
```

### PostgreSQL connection errors

```bash
# Check PostgreSQL is running
psql -U postgres -c "SELECT version();"

# Verify .env settings
echo $PGHOST $PGPORT $PGDATABASE $PGUSER
```

### Environment variables not loading

```bash
# Verify .env exists at project root
ls -la .env

# Check for syntax errors in .env
cat .env
```

### Functions not starting

```bash
# Install Azure Functions Core Tools
npm install -g azure-functions-core-tools@4

# Verify installation
func --version

# Start with verbose logging
cd functions
func start --verbose
```

### Authentication failing

```bash
# For local dev, ensure bypass is enabled
grep ALLOW_DEV_AUTH_BYPASS .env
# Should show: ALLOW_DEV_AUTH_BYPASS=true

# For production auth, verify JWKS URI
grep AZURE_AD_JWKS_URI .env
```

## Azure Deployment

### Prerequisites

- Azure subscription
- Azure CLI installed and logged in
- Resource group created

### Deploy API (App Service)

```bash
# Build first
npm run build -w @greenhouse-resume-builder/api

# Deploy
az webapp up --name <app-name> --resource-group <rg-name> --runtime "NODE:20-lts" --src-path api
```

### Deploy Functions

```bash
# Build
npm run build -w @greenhouse-resume-builder/azure-functions

# Deploy
cd functions
func azure functionapp publish <function-app-name>
```

### Configure App Settings

```bash
# Set environment variables in Azure
az webapp config appsettings set \
  --name <app-name> \
  --resource-group <rg-name> \
  --settings \
    PGHOST=<azure-pg-server> \
    AZURE_AD_JWKS_URI=https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys \
    ALLOW_DEV_AUTH_BYPASS=false
```

### Enable Managed Identity

```bash
# Enable system-assigned managed identity
az webapp identity assign --name <app-name> --resource-group <rg-name>

# Grant PostgreSQL access
az postgres flexible-server ad-admin set \
  --server-name <pg-server> \
  --resource-group <rg-name> \
  --object-id <managed-identity-object-id>
```

## Additional Resources

- [README.md](./README.md) - Project overview
- [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) - Current implementation status
- [AGENT_TASKS.md](./AGENT_TASKS.md) - Current next steps and priorities
- [Azure Functions Documentation](https://docs.microsoft.com/azure/azure-functions/)
- [Azure PostgreSQL Documentation](https://docs.microsoft.com/azure/postgresql/)
- [Microsoft Entra ID Documentation](https://docs.microsoft.com/entra/identity/)

## Support

For issues or questions:

1. Check existing documentation in `docs/`
2. Review implementation status in `IMPLEMENTATION_STATUS.md`
3. Check the codebase for inline comments
