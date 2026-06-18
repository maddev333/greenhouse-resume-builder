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
    /** Raw bytes (Buffer) or base64-encoded string (how the API forwards uploads over JSON). */
    data?: Buffer | string;
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

/** Parse an AnalyzeResult into newline-joined page text (falling back to raw content). */
function parseAnalyzeResult(result: { pages?: any[]; content?: string }): string {
  const pageText = (result.pages ?? [])
    .map((page) =>
      (page.lines ?? [])
        .map((line: any) => line.content?.trim() ?? '')
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n---\n\n');
  return pageText || (result.content ?? '');
}

/** Analyze a single document from a URL via Document Intelligence; returns extracted text. */
async function analyzeDocument(contentUrl: string, logger: typeof console): Promise<string> {
  const diEndpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? '';

  if (!diEndpoint) {
    logger.warn('[DI] AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT missing — skipping DI extraction.');
    return '';
  }

  const client = getDocumentAnalysisClient(diEndpoint);
  // Use prebuilt-layout model to extract all text/content from document pages.
  const poller = await client.beginAnalyzeDocumentFromUrl('prebuilt-layout', contentUrl);
  return parseAnalyzeResult(await poller.pollUntilDone());
}

// ── Analyze a document directly from its bytes (no Blob staging needed). ──────

/**
 * Analyze a document directly from its in-memory bytes — no Blob storage required.
 * Document Intelligence accepts the file as the request body, so a Storage account is
 * unnecessary; only AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT plus a credential is needed.
 * Auth uses Entra ID (az login / managed identity) unless AZURE_DOCUMENT_INTELLIGENCE_KEY is set.
 */
async function analyzeBuffer(buffer: Buffer, logger: typeof console): Promise<string> {
  const diEndpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? '';

  if (!diEndpoint) {
    logger.warn('[DI] AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT missing — cannot analyze document bytes.');
    return '';
  }

  const client = getDocumentAnalysisClient(diEndpoint);
  // prebuilt-layout extracts all text/content; the Buffer is uploaded directly as the request body.
  const poller = await client.beginAnalyzeDocument('prebuilt-layout', buffer);
  return parseAnalyzeResult(await poller.pollUntilDone());
}

// ── Local text extraction helpers (no Blob / DI required) ──────────────────────

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml',
  'html', 'htm', 'log', 'yaml', 'yml', 'vtt', 'srt',
]);

/** True when a file can be decoded directly as UTF-8 text (no OCR needed). */
function isTextLike(name: string, mimeType?: string): boolean {
  const mt = (mimeType || '').toLowerCase();
  if (mt.startsWith('text/')) return true;
  if (mt === 'application/json' || mt === 'application/xml' || mt === 'application/x-yaml') return true;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/** Strip tags/entities from HTML so the extractor sees readable prose. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Coerce an inline upload payload (Buffer, base64 string, or serialized Buffer) into a Buffer. */
function toBuffer(data: Buffer | string | undefined): Buffer | null {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  const anyData = data as any; // Durable may serialize a Buffer as { type: 'Buffer', data: number[] }
  if (anyData?.type === 'Buffer' && Array.isArray(anyData.data)) return Buffer.from(anyData.data);
  return null;
}

// ── Main activity ─────────────────────────────────────────────────────────────

/**
 * Store uploads to Blob and analyze with AI Form Recognizer / Document Intelligence.
 *
 * Text-based files (.txt, .md, .csv, .html, .json, …) are decoded directly — no Azure
 * dependency. Binary files (PDF/image/Office docs) are sent directly to Document Intelligence
 * (no Blob storage required) when AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT is configured, authenticating
 * via Entra ID (az login / managed identity) or AZURE_DOCUMENT_INTELLIGENCE_KEY. When DI is not
 * configured, a clear warning is logged and the file yields no text (so the orchestrator fails loudly).
 */
export async function storeUploadsAndExtract(
  context: any,
  input: StoreAndAnalyzeInput,
): Promise<UploadExtractResult> {
  const { runId } = input;

  context.logger.info(`[StoreAndExtract] Processing uploads for run ${runId}`);

  const textBlocks: string[] = [];
  const sourceDocs: Array<{ id: string; blobPath: string; mimeType: string }> = [];

  const client = await getBlobClient();
  const diEndpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const documentBlobs = input.documentBlobs ?? [];

  for (const doc of documentBlobs) {
    const buf = toBuffer(doc.data);
    if (!buf) {
      // Web/URL-only entries are handled by the fetch-web-snapshot activity, not here.
      if (!doc.uri) context.logger.warn(`[StoreAndExtract] Skipping ${doc.name}: no file data provided.`);
      continue;
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

    // ── Path A: text-like files — decode directly (no Blob / DI needed). ──
    if (isTextLike(doc.name, doc.mimeType)) {
      const ext = (doc.name.split('.').pop() || '').toLowerCase();
      const raw = buf.toString('utf8');
      const text = (ext === 'html' || ext === 'htm' || (doc.mimeType || '').includes('html'))
        ? stripHtml(raw)
        : raw.trim();
      if (text) {
        textBlocks.push(text);
        sourceDocs.push({ id: `inline_${hash}`, blobPath: '', mimeType: doc.mimeType ?? 'text/plain' });
        context.logger.info(`[StoreAndExtract] Extracted ${text.length} chars of text from ${doc.name}`);
      } else {
        context.logger.warn(`[StoreAndExtract] ${doc.name} decoded to empty text.`);
      }
      continue;
    }

    // ── Path B: binary files (PDF/image/Office) — analyze via Document Intelligence. ──
    // No Blob storage required: the bytes are uploaded directly to Document Intelligence.
    // Auth uses Entra ID (az login / managed identity) unless AZURE_DOCUMENT_INTELLIGENCE_KEY is set.
    if (diEndpoint) {
      let blobUrl = '';
      // Optionally stage to Blob for source tracking when storage is configured (not required for extraction).
      if (client) {
        try {
          blobUrl = await stageBlob(client, runId, doc.name, buf);
        } catch (err: any) {
          context.logger.warn(`[StoreAndExtract] Blob staging failed for ${doc.name} (${err.message}); analyzing bytes directly.`);
        }
      }
      try {
        const content = await analyzeBuffer(buf, context.logger as unknown as typeof console);
        if (content) {
          textBlocks.push(content);
          context.logger.info(`[StoreAndExtract] Document Intelligence extracted ${content.length} chars from ${doc.name}`);
        } else {
          context.logger.warn(`[StoreAndExtract] Document Intelligence returned no text for ${doc.name}.`);
        }
        sourceDocs.push({ id: blobUrl || `inline_${hash}`, blobPath: blobUrl, mimeType: doc.mimeType ?? 'application/octet-stream' });
      } catch (err: any) {
        context.logger.error(
          `[StoreAndExtract] Document Intelligence failed for ${doc.name}: ${err.message}. ` +
          `Ensure your identity has the "Cognitive Services User" role on the resource, or set AZURE_DOCUMENT_INTELLIGENCE_KEY.`,
        );
      }
    } else {
      context.logger.warn(
        `[StoreAndExtract] Cannot extract '${doc.name}' (${doc.mimeType || 'binary'}): Document Intelligence is not configured. ` +
        `Set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and sign in to Azure (az login / managed identity) or set AZURE_DOCUMENT_INTELLIGENCE_KEY. ` +
        `Alternatively, upload a text-based file (.txt/.md/.csv/.html/.json) for local extraction.`,
      );
    }
  }

  if (sourceDocs.length === 0 && textBlocks.length === 0) {
    context.logger.info(`[StoreAndExtract] No file text for run ${runId} — relying on web snapshot (if any).`);
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
