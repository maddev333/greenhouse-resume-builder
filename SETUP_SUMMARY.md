# Greenhouse Resume Builder - Setup Summary

## ✅ Changes Made

### 1. Fixed Environment Variable Loading
- **Removed hardcoded paths** in `api/src/server.ts` and `api/src/bootstrap-env.ts` that pointed to `/Users/nick/repos/`
- **Created centralized environment loader** in `shared/src/env.ts` that dynamically finds the project root
- **Added Functions environment loader** in `functions/src/env.ts`
- All services now properly load `.env` from the project root

### 2. Created .env File
- **Created `.env`** with sensible defaults for local development
- Configured for **dev auth bypass** (`ALLOW_DEV_AUTH_BYPASS=true`)
- Includes placeholders for Azure services
- Local PostgreSQL configuration by default

### 3. Configured Azure Entra ID Authentication
- Auth middleware in `api/src/middleware/auth.middleware.ts` supports:
  - **Dev mode**: Bypass token validation (local development)
  - **Production mode**: Full JWT verification against Azure AD JWKS endpoint
  - **Managed Identity**: Support for passwordless PostgreSQL and Azure services
- Ready for Azure deployment with proper Entra ID configuration

### 4. VS Code Debug Configuration
Created complete debug setup in `.vscode/`:
- **launch.json**: Debug configurations for API, Functions, UI, and full stack
- **tasks.json**: Build and run tasks
- **settings.json**: TypeScript and editor settings
- **extensions.json**: Recommended VS Code extensions

### 5. Development Documentation
- **DEVELOPMENT.md**: Comprehensive guide covering:
  - Quick start instructions
  - Environment variable configuration
  - Azure Entra ID setup (dev and production)
  - Debugging in VS Code
  - Deployment to Azure
  - Troubleshooting common issues
- **Quick start scripts**: `quick-start.bat` (Windows) and `quick-start.sh` (Linux/Mac)

## 🎯 How to Run

### Option 1: Quick Start (Recommended)
```bash
# Windows
quick-start.bat

# Linux/Mac
chmod +x quick-start.sh
./quick-start.sh
```

### Option 2: Manual Start
```bash
# 1. Install dependencies
npm ci

# 2. Build shared packages
npm run build -w @greenhouse-resume-builder/shared

# 3. Start API (terminal 1)
cd api && npm run dev

# 4. Start UI (terminal 2)
cd ui && npm run dev
```

### Option 3: VS Code Debugging
1. Open project in VS Code
2. Press `F5`
3. Select "Debug Full Stack"
4. Set breakpoints and debug!

## 🔐 Authentication Modes

### Development (Default)
`.env` has `ALLOW_DEV_AUTH_BYPASS=true`:
- No Azure AD required
- Any request accepted
- Perfect for local development

### Production (Azure Entra ID)
Update `.env`:
```bash
AZURE_TENANT_ID=<your-tenant-id>
AZURE_AD_CLIENT_ID=<your-client-id>
AZURE_AD_JWKS_URI=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys
ALLOW_DEV_AUTH_BYPASS=false
```

Get token and test:
```bash
az login
TOKEN=$(az account get-access-token --resource <client-id> --query accessToken -o tsv)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/stats
```

## 📁 Key Files Modified/Created

### Modified
- `api/src/server.ts` - Fixed env loading path
- `api/src/bootstrap-env.ts` - Fixed env loading path
- `functions/src/pipeline/http-start.ts` - Added env import

### Created
- `.env` - Main environment configuration
- `shared/src/env.ts` - Centralized env loader
- `functions/src/env.ts` - Functions env loader
- `.vscode/launch.json` - Debug configurations
- `.vscode/tasks.json` - Build tasks
- `.vscode/settings.json` - Editor settings
- `.vscode/extensions.json` - Recommended extensions
- `DEVELOPMENT.md` - Development guide
- `quick-start.bat` - Windows quick start
- `quick-start.sh` - Linux/Mac quick start
- `SETUP_SUMMARY.md` - This file

## ⚙️ Environment Variable Inheritance

All services now properly inherit environment variables from `.env`:

1. **Project Root**: `.env` file (single source of truth)
2. **Shared**: `shared/src/env.ts` loads and exports variables
3. **API**: Imports `shared/src/env.ts` at server startup
4. **Functions**: Imports `functions/src/env.ts` at function startup
5. **UI**: Uses Vite's built-in env loading (prefix with `VITE_`)

## 🔧 Build Status

✅ **API**: Builds successfully (`tsc` passes)
✅ **Functions**: Builds successfully (`tsc` passes)
✅ **Shared**: Builds successfully

## 📋 Prerequisites for Running

### Required
- Node.js v20+
- PostgreSQL (local or Azure)

### Optional
- Azure Functions Core Tools v4 (for Functions)
- Azure CLI (for Azure services)
- VS Code (for debugging)

## 🚀 Next Steps

1. **Configure PostgreSQL**:
   - Install locally, OR
   - Update `.env` with Azure PostgreSQL connection

2. **Run the application**:
   ```bash
   cd api && npm run dev
   # Visit http://localhost:3001/health
   ```

3. **Enable Azure Services** (optional):
   - Create Azure resources (Storage, OpenAI, Search, etc.)
   - Update `.env` with endpoints and keys
   - Or leave blank to use managed identity in production

4. **Set up Entra ID** (for production):
   - Create App Registration in Azure Portal
   - Update `.env` with tenant and client IDs
   - Set `ALLOW_DEV_AUTH_BYPASS=false`

## 📖 Documentation

- **[DEVELOPMENT.md](./DEVELOPMENT.md)** - Complete development guide
- **[README.md](./README.md)** - Project overview
- **[IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)** - Implementation status

## 🎉 Summary

The project is now **ready for local development** with:
- ✅ Proper environment variable loading
- ✅ Azure Entra ID authentication support
- ✅ Easy debugging in VS Code
- ✅ Clear documentation
- ✅ Quick start scripts

All environment variables now properly inherit from `.env`, and the project is configured to run on Azure with Entra ID authentication when ready!
