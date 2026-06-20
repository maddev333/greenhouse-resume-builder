import type { SectionResult } from "@greenhouse-resume-builder/llmwiki-shared";

interface SectionViewerProps {
  section: SectionResult | null;
  onPrev?: () => void;
  onNext?: () => void;
}

export function SectionViewer({ section, onPrev, onNext }: SectionViewerProps) {
  if (!section) return (
    <div style={{ padding: "40px 20px", fontStyle: "italic", color: "#65676b" }}>
      Select a hit to view its content.
    </div>
  );

  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{section.document?.title || "?"}</div>
      <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
        {section.heading_path}
      </div>

      {/* Section body text */}
      <pre style={{ background: "#f6f8fa", padding: 12, borderRadius: 6, overflowX: "auto", fontSize: 13, lineHeight: 1.6 }}>
        {section.body || "(empty section)"}
      </pre>

      {/* Prev/Next navigation */}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        {onPrev && (
          <button onClick={onPrev}>← Previous</button>
        )}
        {onNext && (
          <button onClick={onNext}>Next →</button>
        )}
      </div>
    </>
  );
}
