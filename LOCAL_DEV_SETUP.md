# Local Development Quick Start

## Architecture
- **Azurite** → Durable Functions internal tables/queues (port 10000)
- **Real Azure** → Blob Storage, Search, Document Intelligence via `DefaultAzureCredential` (from `.env`)

Azurite is a local emulator for **Durable Functions only**. All business logic uses your real Azure account.

## Prerequisites
```bash
npm install -g azurite  # installs the Azure Storage Emulator
az login                # authenticate for DefaultAzureCredential
```

## Start Everything
1. **Azurite** (in background): `nohup azurite --silent > /tmp/azurite.log 2>&1 &`
2. **Functions**: `cd functions && npm start`
3. **API**: from root or `api/`, confirm `.env` has all credentials

## Troubleshooting
- `Connection refused on 127.0.0.1:10000` → Azurite not running (`pgrep -f azurite`)
- Key auth errors → Your storage account has key access disabled; Azurite is the correct route
- Azure credential errors → Run `az login` first
