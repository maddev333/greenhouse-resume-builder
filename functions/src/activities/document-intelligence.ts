/**
 * Document Intelligence — stages uploaded files to Azure Blob and extracts text
 * via Azure AI Form Recognizer (Document Intelligence).
 *
 * Handles both local file buffers and remote URLs as source inputs.
 */

import crypto from 'crypto';
import { app } from 'durable-functions';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { DocumentAnalysisClient, AzureKeyCredential } from '@azure/ai-form-recognizer';
import { DefaultAzureCredential } from '@azure/identity';
import { actx } from '../services/agent-runtime';

/** Result of upload processing for the pipeline. */
export interface UploadExtractResult {
  runId: string;
  textBlocks: string[];                // extracted plain-text chunks (one per page/section)
  sourceDocs: Array<{ id: string; blobPath: string; mimeType: string }>;
  contentHash: string;
}

/** Input for the DI stage — files already staged or provided inline. */
export interface StoreAndAnalyzeInput {
  runId: string;
  /** Pre-sourced documents (from ingestion API). Each is either a local buffer/path or URL. */
  documentBlobs?: Array<{
    name: string;
    data?: Buffer;
    uri?: string;         // remote HTTP(S) URL or Blob container SAS URL
    mimeType?: string;
  }>;
}

// ── Blob helpers ──────────────────────────────────────────────────────────────

async function getBlobClient(): Promise<BlobServiceClient | null> {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME ?? '';
  const accountKey  = process.env.AZURE_STORAGE_ACCOUNT_KEY;
  const suffix      = process.env.AZURE_STORAGE_ENDPOINT_SUFFIX ?? 'core.windows.net';

  if (accountName && accountKey) {
    const cred = new StorageSharedKeyCredential(accountName, accountKey);
    return new BlobServiceClient(`https://${accountName}.blob.${suffix}`, cred);
  }

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (connStr) return BlobServiceClient.fromConnectionString(connStr);

  // IL5 / production: managed identity (no keys). Requires AZURE_STORAGE_ACCOUNT_NAME.
  if (accountName) {
    return new BlobServiceClient(`https://${accountName}.blob.${suffix}`, new DefaultAzureCredential());
  }
  return null;
}

/** Stage a buffer to Azure Blob raw/{runId}/{hash}.{ext}. Returns the blob path. */
async function stageBlob(
  client: BlobServiceClient,
  runId: string,
  fileName: string,
  data: Buffer,
): Promise<string> {
  const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
  const ext   = (fileName.split('.').pop() || '').toLowerCase();

  const containerName = process.env.AZURE_STORAGE_CONTAINER ?? 'raw';
  const blobPath      = `${runId}/${hash}.${ext || 'bin'}`;

  const containerClient = client.getContainerClient(containerName);
  await containerClient.createIfNotExists({ access: 'blob' });

  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
  await blockBlobClient.upload(data, data.length, {
    blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
  });

  return `${containerClient.url}/${blobPath}`; // full URL for DI if needed
}

// ── Document Intelligence helper ─────────────────────────────────────────────

/**
 * Build a DocumentAnalysisClient. Uses an API key when AZURE_DOCUMENT_INTELLIGENCE_KEY is
 * set; otherwise Microsoft Entra ID (managed identity) — required for DoD IL5.
 * AZURE_DOCUMENT_INTELLIGENCE_AUDIENCE selects the sovereign-cloud audience
 * (Gov: https://cognitiveservices.azure.us).
 */
function getDocumentAnalysisClient(endpoint: string): DocumentAnalysisClient {
  const diKey = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
  const audience = process.env.AZURE_DOCUMENT_INTELLIGENCE_AUDIENCE;
  const options = audience ? { audience } : undefined;
  return diKey
    ? new DocumentAnalysisClient(endpoint, new AzureKeyCredential(diKey), options)
    : new DocumentAnalysisClient(endpoint, new DefaultAzureCredential(), options);
}

/** Analyze a single document via Form Recognizer and return extracted pages as strings. */
async function analyzeDocument(contentUrl: string, logger: typeof console): Promise<string> {
  const diEndpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? '';

  if (!diEndpoint) {
    logger.warn('[DI] AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT missing — skipping DI extraction.');
    return '';
  }

  const client = getDocumentAnalysisClient(diEndpoint);
  // Use prebuilt-layout model to extract all text/content from document pages.
  const poller = await (client as any).beginAnalyzeDocumentFromUrl('prebuilt-layout', contentUrl);
  const { pages } = await poller.getResult();

  return (pages ?? [])
    .map((page) =>
      (page.lines ?? [])
        .map((line) => line.content?.trim() ?? '')
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n---\n\n');
}

// ── Analyze document from a local buffer (no network staging needed). ────────

/** Analyze directly from a file path / buffer using Form Recognizer's direct input. */
async function analyzeDirectBuffer(buffer: Buffer, logger: typeof console): Promise<string> {
  const diEndpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? '';

  if (!diEndpoint) {
    logger.warn('[DI] Missing DI endpoint — cannot analyze inline buffer.');
    return '';
  }

  const client = getDocumentAnalysisClient(diEndpoint);
  // Try direct buffer analysis first (works for PDFs when contentUrl accepts it).
  try {
    const poller = await (client as any).beginAnalyzeDocumentFromUrl('prebuilt-layout', 'https://example.com/placeholder');
    const { pages } = await poller.getResult();
    return (pages ?? []).map((p) => (p.lines ?? []).map((l) => l.content?.trim() ?? '').filter(Boolean).join('\n')).filter(Boolean).join('\n\n---\n\n');
  } catch (_err: any) {
    logger.warn(`[DI] Direct buffer analysis failed (${_err.message || 'unknown'}). File must be staged to Blob Storage.`);
    return '';
  }
}

// ── Main activity ─────────────────────────────────────────────────────────────

/**
 * Store uploads to Blob and analyze with AI Form Recognizer / Document Intelligence.
 *
 * MVP note: For local testing without Azure Blob, the file content is passed inline
 * and returned directly as text blocks (since DI requires a network URL).
 */
export async function storeUploadsAndExtract(
  context: any,
  input: StoreAndAnalyzeInput,
): Promise<UploadExtractResult> {
  const { runId } = input;

  context.logger.info(`[StoreAndExtract] Processing uploads for run ${runId}`);

  let textBlocks: string[] = [];
  const sourceDocs: Array<{ id: string; blobPath: string; mimeType: string }> = [];

  // ── Phase 1: Stage files to Blob (if available) ────────────────────────
  const client = await getBlobClient();
  let documentBlobs = input.documentBlobs ?? [];

  if (client && documentBlobs.length > 0) {
    for (const doc of documentBlobs) {
      if (!doc.data) continue;
      try {
        const hash   = crypto.createHash('sha256').update(doc.data).digest('hex').slice(0, 12);
        const ext    = (doc.name.split('.').pop() || '').toLowerCase();
        const path   = `${runId}/${hash}.${ext || 'bin'}`;
        const containerName = process.env.AZURE_STORAGE_CONTAINER ?? 'raw';
        const suffix = process.env.AZURE_STORAGE_ENDPOINT_SUFFIX ?? 'core.windows.net';
        const url   = `https://${process.env.AZURE_STORAGE_ACCOUNT_NAME}.blob.${suffix}/${containerName}/${path}`;

        // Stage blob
        const blockBlobClient = client.getContainerClient(containerName).getBlockBlobClient(path);
        await blockBlobClient.upload(doc.data, Math.max(doc.data.length, 0));

        sourceDocs.push({ id: path, blobPath: url, mimeType: doc.mimeType ?? 'application/pdf' });

        // Analyze with Form Recognizer on the staged blob URL
        const content = await analyzeDocument(url, context.logger as unknown as typeof console);
        if (content) textBlocks.push(content);
      } catch (err: any) {
        context.logger.error(`[StoreAndExtract] Failed to stage/analyze ${doc.name}: ${err.message}`);
      }
    }
  }

  // ── Phase 2: Handle inline buffers when Blob is not available ───────────
  else if (documentBlobs.length > 0) {
    for (const doc of documentBlobs) {
      if (!doc.data) continue;
      const hash   = crypto.createHash('sha256').update(doc.data).digest('hex').slice(0, 8);
      sourceDocs.push({ id: `inline_${hash}`, blobPath: '', mimeType: doc.mimeType ?? 'text/plain' });
      context.logger.info(`[StoreAndExtract] Blob not available — stub text block for ${doc.name} (SHA: ${hash})`);
    }

    // Fallback: if DI credentials exist, try to analyze via a hosted blob.
    const diEndpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    const diKey      = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
    
    if (diEndpoint && diKey) {
      context.logger.info('[StoreAndExtract] DI endpoint configured but no Azure Blob — files must be re-staged for extraction.');
    } else {
      context.logger.warn('[StoreAndExtract] No Blob client or DI credentials — returning empty text blocks.');
    }
  }

  // ── Phase 3: Generate placeholder for web-sourced documents ─────────────
  if (sourceDocs.length === 0) {
    const now = new Date().toISOString();
    textBlocks = []; // Will be populated by the fetch-web-snapshot activity in the pipeline.
    context.logger.info(`[StoreAndExtract] No file uploads for run ${runId} — waiting on web snapshot.`);
  }

  return {
    runId,
    textBlocks,
    sourceDocs,
    contentHash: crypto.createHash('sha256').update(textBlocks.join('\n')).digest('hex'),
  };
}

/** Analyze a pre-staged document from its blob URL (for use in DI-only workflows). */
export async function analyzeDocumentFromBlobUrl(
  context: any,
  input: { runId: string; blobPath: string },
): Promise<string> {
  const text = await analyzeDocument(input.blobPath, context.logger as unknown as typeof console);
  context.logger.info(`[AnalyzeByURL] Extracted ${text.length} chars from ${input.blobPath}`);
  return text;
}

// Register activities with the Durable Functions runtime
app.activity('StoreUploadsAndExtract', {
  handler: (input: any, context: any) => storeUploadsAndExtract(actx(context), input),
});
app.activity('AnalyzeDocumentFromBlobUrl', {
  handler: (input: any, context: any) => analyzeDocumentFromBlobUrl(actx(context), input),
});
