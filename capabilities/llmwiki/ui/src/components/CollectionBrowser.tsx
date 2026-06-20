import type { CollectionInfo, DocumentInfo } from "@greenhouse-resume-builder/llmwiki-shared";

interface CollectionBrowserProps {
  collections: Array<{ coll: CollectionInfo; docs: DocumentInfo[] }>;
  onSelectDoc: (doc: DocumentInfo) => void;
}

/** Left sidebar tree: Collections → Documents */
export function CollectionBrowser({ collections, onSelectDoc }: CollectionBrowserProps) {
  return (
    <>
      {collections.map(({ coll, docs }) => (
        <div key={coll.id} style={{ marginBottom: 8 }}>
          <div style={{ padding: "4px 12px", fontSize: 13, fontWeight: 60 }}>{coll.name}</div>
          {docs.slice(0,5).map((doc) => (
            <div key={doc.id} onClick={() => onSelectDoc(doc)} className="hit-item" style={{ padding: "4px 12px", fontSize: 12, cursor: "pointer", color: "#65676b" }}>
              {doc.title} [{doc.doc_type}]
              <span style={{ marginLeft: 8, fontSize: 10 }}>{doc.page_count ?? "?"}</span>
            </div>
          ))}
        </div>
      ))}
    </>

  );
}
