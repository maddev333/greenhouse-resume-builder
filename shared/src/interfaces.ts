/**
 * Core entity interfaces for the Greenhouse Resume Builder MVP.
 * These map directly to Cosmos DB container documents.
 */

// ===== Base interface for all entities =====
export interface BaseEntity {
  id: string;
  tenantId: string;
  createdAt: string; // ISO-8601
  updatedAt?: string; // ISO-8601
}

// ===== People =====
export interface Person extends BaseEntity {
  canonicalName: string;
  aliases: string[];
  dedupStatus: 'system_matched' | 'recruiter_selected' | 'needs_review';
  systemMatchScore?: number;
}

// ===== SourceDocuments =====
export interface SourceDocument {
  id: string; // sourceDocumentId
  tenantId: string;
  personId?: string;
  sourceType: 'web' | 'upload';
  
  // Web-specific
  uri?: string;
  capturedAt?: string;
  contentHash?: string;
  
  // Upload-specific
  blobPath?: string;
  mimeType?: string;
  uploadedAt?: string;
  
  extractionRunId: string;
  createdAt: string;
}

// ===== ExtractionRuns =====
export interface ExtractionRun {
  id: string; // runId (also Durable Function orchestration ID)
  tenantId: string;
  requestedByUserId: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  sourceDocumentIds: string[];
  personId?: string; // resolved person once the pipeline completes (drives UI navigation)
  createdAt: string;
  completedAt?: string;
  failedReason?: string;
  updatedAt?: string; // updated on each status change
}

// ===== FactVersions =====
export interface FactVersion {
  id: string; // factVersionId
  tenantId: string;
  personId: string;
  extractionRunId: string;
  sectionId: 'summary' | 'experience' | 'skills' | 'education';
  factKey: string; // e.g., 'employment.employer_name'
  factValue: string | object;
  normalizedValue: string;
  extractedAt: string;
  confidence?: number;
  status: 'extracted' | 'inferred' | 'edited';
  sourceDocumentIds: string[];
}

// ===== BulletMappings =====
export interface BulletMapping {
  id: string; // bulletId (stable composite identity)
  tenantId: string;
  personId: string;
  extractionRunId: string;
  sectionId: 'summary' | 'experience' | 'skills' | 'education';
  bulletText: string;
  bulletSignature: string; // stable hash for diffing
  citationFactVersionIds: string[];
  citationSourceDocumentIds: string[];
  latestForBullet: boolean;
  createdAt: string;
}

// ===== Annotations =====
export interface Annotation {
  id: string; // annotationId
  tenantId: string;
  personId: string;
  targetType: 'factVersion';
  targetFactVersionId: string;
  commentText: string;
  createdByUserId: string;
  createdAt: string;
  status?: 'open' | 'resolved';
}

// ===== Relationships =====
export interface Relationship {
  id: string; // relationshipId
  tenantId: string;
  fromPersonId: string;
  toPersonId: string;
  relationshipType: string; // e.g., 'shared_employer', 'mentor_of'
  status: 'suggested' | 'confirmed' | 'rejected';
  inferredByAgent: boolean;
  confidence?: number;
  evidenceFactVersionIds: string[];
  evidenceSourceDocumentIds: string[];
  confirmedByUserId?: string;
  confirmedAt?: string;
  rejectedByUserId?: string;
  rejectedAt?: string;
}

// ===== API Request/Response types =====

export interface CreateIngestionRequestInput {
  tenantId: string;
  sourceDocuments: SourceDocumentInput[];
  personId?: string; // optional recruiter override for dedup selection
}

export interface SourceDocumentInput {
  name: string;
  mimeType: string;
  blobPath?: string; // URL or container-relative path from upload
  uri?: string;     // for web sources
  sourceType: 'web' | 'upload';
}

export interface IngestionRunResponse {
  runId: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  sourceDocumentIds: string[];
  createdAt: string;
  completedAt?: string;
  failedReason?: string;
  updatedAt?: string;
}

export interface ResumeBulletResponse {
  bulletId: string;
  sectionId: string;
  bulletText: string;
  citationFactVersionIds: string[];
  citationSourceDocumentIds: string[];
  confidence?: number;
}

export interface FactVersionResponse {
  factVersionId: string;
  extractionRunId: string;
  sectionId: string;
  factKey: string;
  factValue: string | object;
  normalizedValue: string;
  extractedAt: string;
  confidence: number;
}

export interface DiffResult {
  bulletId: string;
  type: 'added' | 'removed' | 'changed';
  previousBulletText?: string;
  currentBulletText: string;
  citationChangeSummary: string;
}
