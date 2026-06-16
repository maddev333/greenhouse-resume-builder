"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FactKeyNamespace = exports.ExplicitRelationshipType = exports.InferredRelationshipType = exports.KNOWN_SECTIONS = exports.SectionId = exports.IngestionRequestStatus = exports.RelationshipStatus = exports.AnnotationStatus = exports.FactStatus = exports.SourceType = exports.ExtractionRunStatus = exports.DedupStatus = void 0;
// === Dedup & Person status ===
var DedupStatus;
(function (DedupStatus) {
    DedupStatus["SystemMatched"] = "system_matched";
    DedupStatus["RecruiterSelected"] = "recruiter_selected";
    DedupStatus["NeedsReview"] = "needs_review";
})(DedupStatus || (exports.DedupStatus = DedupStatus = {}));
// === Extraction Run status ===
var ExtractionRunStatus;
(function (ExtractionRunStatus) {
    ExtractionRunStatus["Queued"] = "queued";
    ExtractionRunStatus["InProgress"] = "in_progress";
    ExtractionRunStatus["Completed"] = "completed";
    ExtractionRunStatus["Failed"] = "failed";
})(ExtractionRunStatus || (exports.ExtractionRunStatus = ExtractionRunStatus = {}));
// === Source document type ===
var SourceType;
(function (SourceType) {
    SourceType["Web"] = "web";
    SourceType["Upload"] = "upload";
})(SourceType || (exports.SourceType = SourceType = {}));
// === FactVersion status ===
var FactStatus;
(function (FactStatus) {
    FactStatus["Extracted"] = "extracted";
    FactStatus["Inferred"] = "inferred";
    FactStatus["Edited"] = "edited";
})(FactStatus || (exports.FactStatus = FactStatus = {}));
// === Annotation status ===
var AnnotationStatus;
(function (AnnotationStatus) {
    AnnotationStatus["Open"] = "open";
    AnnotationStatus["Resolved"] = "resolved";
})(AnnotationStatus || (exports.AnnotationStatus = AnnotationStatus = {}));
// === Relationship status ===
var RelationshipStatus;
(function (RelationshipStatus) {
    RelationshipStatus["Suggested"] = "suggested";
    RelationshipStatus["Confirmed"] = "confirmed";
    RelationshipStatus["Rejected"] = "rejected";
})(RelationshipStatus || (exports.RelationshipStatus = RelationshipStatus = {}));
// === Ingestion request status (API-level) ===
var IngestionRequestStatus;
(function (IngestionRequestStatus) {
    IngestionRequestStatus["Pending"] = "pending";
    IngestionRequestStatus["Active"] = "active";
    IngestionRequestStatus["Completed"] = "completed";
    IngestionRequestStatus["Failed"] = "failed";
})(IngestionRequestStatus || (exports.IngestionRequestStatus = IngestionRequestStatus = {}));
// === Section IDs for ontology sections ===
var SectionId;
(function (SectionId) {
    SectionId["Summary"] = "summary";
    SectionId["Experience"] = "experience";
    SectionId["Skills"] = "skills";
    SectionId["Education"] = "education";
})(SectionId || (exports.SectionId = SectionId = {}));
exports.KNOWN_SECTIONS = Object.values(SectionId);
// === Relationship types (MVP) ===
var InferredRelationshipType;
(function (InferredRelationshipType) {
    InferredRelationshipType["SharedEmployer"] = "shared_employer";
    InferredRelationshipType["WorkedTogether"] = "worked_together";
})(InferredRelationshipType || (exports.InferredRelationshipType = InferredRelationshipType = {}));
var ExplicitRelationshipType;
(function (ExplicitRelationshipType) {
    ExplicitRelationshipType["MentorOf"] = "mentor_of";
    ExplicitRelationshipType["PeerOf"] = "peer_of";
    ExplicitRelationshipType["ReferedBy"] = "referred_by";
    ExplicitRelationshipType["CollaboratedWith"] = "collaborated_with";
})(ExplicitRelationshipType || (exports.ExplicitRelationshipType = ExplicitRelationshipType = {}));
// === FactKey namespace patterns ===
var FactKeyNamespace;
(function (FactKeyNamespace) {
    FactKeyNamespace["Employment"] = "employment";
    FactKeyNamespace["Education"] = "education";
    FactKeyNamespace["Skills"] = "skills";
    FactKeyNamespace["Summary"] = "summary";
})(FactKeyNamespace || (exports.FactKeyNamespace = FactKeyNamespace = {}));
//# sourceMappingURL=enums.js.map