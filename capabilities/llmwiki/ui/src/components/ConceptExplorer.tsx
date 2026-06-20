import type { ConceptInfo } from "@greenhouse-resume-builder/llmwiki-shared"

interface ConceptExplorerProps {
  concepts: ConceptInfo[]
}

/** Left panel concept badges + D3 force-directed graph of co-occurring concepts */
export function ConceptExplorer({ concepts }: ConceptExplorerProps) {
  if (!concepts.length) return <div>No concepts.</div>

  const kindColors: Record<string, string> = {
    concept: "#2d6a2d", rule: "#8f6c00", entity: "#1565c0", template: "#7b1fa2"
  }

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#65676b", marginBottom: 8 }}>Concepts ({concepts.length})</div>
      {concepts.slice(0, 20).map(c => (
        <p key={c.id} style={{ display: "inline-block", margin: "3px" }}>
          <span className="hit-item" style={{ padding: "4px 8p, cursor: "pointer", fontSize: 12 }} >
            {c.kind.toUpperCase()} {c.name}
          </span>
        </p>
      ))}

      {/* D3 force-directed graph of related concepts will render here in production */}
    </div>
  )
}

