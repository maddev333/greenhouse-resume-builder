// === Dedup & Person status ===
export enum DedupStatus {
  SystemMatched = 'system_matched',
  RecruiterSelected = 'recruiter_selected',
  NeedsReview = 'needs_review',
}

// === Extraction Run status ===
export enum ExtractionRunStatus {
  Queued = 'queued',
  InProgress = 'in_progress',
  Completed = 'completed',
  Failed = 'failed',
}

// === Source document type ===
export enum SourceType {
  Web = 'web',
  Upload = 'upload',
}

// === FactVersion status ===
export enum FactStatus {
  Extracted = 'extracted',
  Inferred = 'inferred',
  Edited = 'edited',
}

// === Annotation status ===
export enum AnnotationStatus {
  Open = 'open',
  Resolved = 'resolved',
}

// === Relationship status ===
export enum RelationshipStatus {
  Suggested = 'suggested',
  Confirmed = 'confirmed',
  Rejected = 'rejected',
}

// === Ingestion request status (API-level) ===
export enum IngestionRequestStatus {
  Pending = 'pending',
  Active = 'active',
  Completed = 'completed',
  Failed = 'failed',
}

// === Section IDs for ontology sections ===
export enum SectionId {
  Summary = 'summary',
  Experience = 'experience',
  Skills = 'skills',
  Education = 'education',
}

export const KNOWN_SECTIONS = Object.values(SectionId);

// === Relationship types (MVP) ===
export enum InferredRelationshipType {
  SharedEmployer = 'shared_employer',
  WorkedTogether = 'worked_together',
}

export enum ExplicitRelationshipType {
  MentorOf = 'mentor_of',
  PeerOf = 'peer_of',
  ReferedBy = 'referred_by',
  CollaboratedWith = 'collaborated_with',
}

export type RelationshipType = InferredRelationshipType | ExplicitRelationshipType;

// === FactKey namespace patterns ===
export enum FactKeyNamespace {
  Employment = 'employment',
  Education = 'education',
  Skills = 'skills',
  Summary = 'summary',
}
