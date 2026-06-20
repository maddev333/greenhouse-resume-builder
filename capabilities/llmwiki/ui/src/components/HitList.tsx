import type { SearchHit, CollectionInfo } from "@greenhouse-resume-builder/llmwiki-shared";

interface HitListProps {
  hits: SearchHit[];
  activeSectionId: string | null;
  onSelectSection: (sectionId: string) => void;
}

/** Render a list of search hits. Each hit becomes clickable to view the full section. */
export function HitList({ hits, activeSectionId, onSelectSection }: HitListProps) {
  if (!hits.length) return null;

  return (
    <>
      <div style={{ padding: "0 12px 6px", fontSize: 13, color: "#65676b" }}>
        {hits.length} hit{hits.length > 1 ? "s" : ""} found
      </div>
      {hits.map((hit) => (
        <div
          key={hit.section_id}
          className={`hit-item ${activeSectionId === hit.section_id ? "active" : ""}`}
          onClick={() => onSelectSection(hit.section_id)}
          style={{
            padding: 10, margin: "6px 8px", cursor: "pointer",
            border: activeSectionId === hit.section_id ? "2px solid #045eff" : "1px solid #e2e4f8", borderRadius: 6,
          }}
        >
          <div style={{ fontWeight: 600 }}>{hit.document_title || "?"}</div>
          <div style={{ fontSize: 12, color: "#65676b" }}>{hit.heading_path}</div>

          {/* Highlight matching portion of snippet */}
          <div style={{ marginTop: 4 }}>
            {hit.snippet ? (
              <code style={{ background: "#e8edf3", padding: "1px 2px", borderRadius: 3 }}>
                {hit.snippet.slice(0, 200)}
              </code>
            ) : <span style={{ fontSize: 13, color: "#65676b" }}>(no snippet)</span>}
          </div>

          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: 10, opacity: 0.8 }}>score: {hit.score.toFixed(3)}</span>
            {hit.collection_id && (<>{" "}·<span>{hit.collection_id}</span>{" "}</>)}
          </div>
        </div>
      ))}
    </>
  );
}

/** Collection cards — displayed in manifest mode when no search query. */
interface ManifestViewProps {
  collections: CollectionInfo[];
  onSelectCollection?: (id: string) => void;
}

export function ManifestView({ collections, onSelectCollection }: ManifestViewProps) {
  if (!collections.length) return null;

  return (
    <div style={{ padding: "6px 8p>
      <div style={{ padding: "0 12px 6px", fontSize: 13, color: "#65676b" }}>
        {collections.length} collection{collections.length > 1 ? "s" : ""} found
      </div>
      {collections.map((c) => (
        <div
          key={c.id}
          className="hit-item"
          onClick={() => onSelectCollection?.(c.id)}
          style={{ padding: 10, margin: "6px 8p", cursor: "pointer", border: "1px solid #e24f8", borderRadius: 6 }}
        >
          <div style={{ fontWeight: 600 }}>{c.name}</div>
          <div style={{ fontSize: 12, color: "#65676b" }}>
            {c.description?.slice(0, 80)}...
          </div>
          <div style={{ marginTop: 4, fontSize: 13 }}>
            {c.document_count} docs · {c.section_count} sections · {c.concept_count} concepts
          </div>
        </div>
      ))}
    </div>
  );
}
