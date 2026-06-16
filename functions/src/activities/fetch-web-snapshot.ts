/** FetchAndSnapshotWebSources: HTTP GET public URLs → Blob Storage blob://web-snapshots/{runId}/{hash}.html. */

import crypto from 'crypto';
import { app } from 'durable-functions';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { actx } from '../services/agent-runtime';

export interface WebSourceResult {
  runId: string;
  uri:   string;                    // original URL
  hash:  string;                    // content SHA-256
  blobPath?: string;                // container-relative path (if uploaded)
  contentLength?: number;
  mimeType?: string;
  contentSnippet?: string;            // first 4096 chars for section agents
}

/** Fetch a public URL and return its text content. */
async function fetchUrlAsText(uri: string, timeoutMs = 15_000): Promise<{ text: string; mimeType?: string }> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const resp = await fetch(uri, { signal: controller.signal });
    clearTimeout(id);
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${uri}`);
    
    const mimeType = resp.headers.get('content-type')?.split(';')[0] || 'text/html';
    const text = await resp.text();
    
    return { text, mimeType };
  } catch (err: any) {
    clearTimeout(id);
    throw new Error(`Failed to fetch ${uri}: ${err.message || err}`);
  }
}

/** HTML-to-plain-text converter (lightweight — no DOM library for MVP). */
function htmlToPlainText(html: string): string {
  // Strip HTML tags while preserving readability
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')   // remove scripts
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')      // remove styles
    .replace(/<br\s*\/?>/gi, '\n')                        // br → newline
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')            // block elements → newline
    .replace(/<[^>]+>/g, ' ')                             // remove remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')                                // collapse whitespace
    .trim();
  return text;
}

/** Get or create a BlobServiceClient from env vars. */
function getBlobClient(): BlobServiceClient | null {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME ?? '';
  const accountKey  = process.env.AZURE_STORAGE_ACCOUNT_KEY  ?? '';
  const suffix      = process.env.AZURE_STORAGE_ENDPOINT_SUFFIX ?? 'core.windows.net';

  if (accountName && accountKey) {
    const cred = new StorageSharedKeyCredential(accountName, accountKey);
    return new BlobServiceClient(
      `https://${accountName}.blob.${suffix}`,
      cred,
    );
  }

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (connStr) return BlobServiceClient.fromConnectionString(connStr);

  // IL5 / production: managed identity (no keys). Requires AZURE_STORAGE_ACCOUNT_NAME.
  if (accountName) {
    return new BlobServiceClient(`https://${accountName}.blob.${suffix}`, new DefaultAzureCredential());
  }
  return null;
}

/** Upload text blob to Azure Blob Storage. */
async function uploadToBlob(
  client: BlobServiceClient,
  runId: string,
  uri: string,
  content: string,
): Promise<string> {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const safeName = encodeURIComponent(uri).replace(/%/g, '_');
  const containerName = process.env.AZURE_WEB_SNAPSHOT_CONTAINER ?? 'web-snapshots';
  const blobPath = `web-snapshots/${runId}/${hash}.html`;

  const containerClient = client.getContainerClient(containerName);
  await containerClient.createIfNotExists();
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
  
  // Blob SDK v12 upload expects content as string | Buffer | Blob | ReadableStream | NodeJS.ReadableStream
  await blockBlobClient.upload(content, content.length, { blobHTTPHeaders: { blobContentType: 'text/html' } });

  return blobPath;
}

/** Web snapshot activity — iterates source documents with URIs, fetches each page, writes to Blob. */
export async function fetchAndSnapshotWebSources(
  _context: any,
  input: { runId: string; webUrls?: string[] },
): Promise<WebSourceResult[]> {
  const runId = input.runId;
  // Accept explicit URLs from orchestrator (passed via source documents)
  const urls = input?.webUrls ?? [];
  
  if (urls.length === 0 || !urls.some(Boolean)) {
    return [];
  }

  const client = getBlobClient();
  const results: WebSourceResult[] = [];
  
  console.log(`[WebSnapshot] Processing ${urls.length} URLs for run ${runId}`);
  
  // Process each URL sequentially (to avoid overwhelming the orchestrator's async channel)
  for (const uri of urls.filter(Boolean) as string[]) {
    try {
      const fetched = await fetchUrlAsText(uri);
      const plainText = htmlToPlainText(fetched.text);
      
      let blobPath: string | undefined;
      if (client) {
        try {
          blobPath = await uploadToBlob(client, runId, uri, fetched.text);
        } catch (blobErr: any) {
          console.warn(`[WebSnapshot] Blob upload failed for ${uri}: ${blobErr.message}`);
        }
      }

      // Only return results with content snippets for section agents to use
      if (plainText.length > 0) {
        const snippet = plainText.slice(0, 4096); // Keep first 4KB for context
        
        console.log(`[WebSnapshot] Fetched ${uri}: ${fetched.text.length} chars → snippet ${(snippet.match(/\n/g) || []).length + 1} lines`);
        
        results.push({
          runId,
          uri,
          hash: crypto.createHash('sha256').update(fetched.text).digest('hex'),
          blobPath,
          contentLength: fetched.text.length,
          mimeType: fetched.mimeType,
          contentSnippet: snippet,
        });
      }
    } catch (err: any) {
      console.warn(`[WebSnapshot] Failed ${uri}: ${err.message}`);
      // Continue processing remaining URLs despite failures
    }
  }

  console.log(`[WebSnapshot] Successfully processed ${results.length}/${urls.length} URLs`);
  return results;
}

app.activity('FetchAndSnapshotWebSources', {
  handler: (input: any, context: any) => fetchAndSnapshotWebSources(actx(context), input),
});
