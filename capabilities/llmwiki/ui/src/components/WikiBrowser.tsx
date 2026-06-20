import { useState } from "react"
import type { CollectionInfo, SearchHit, SectionResult } from "@greenhouse-resume-builder/llmwiki-shared"
import { SearchBar } from "./SearchBar"
import { HitList, ManifestView } from "./HitList"
import { SectionViewer } from "./SectionViewer"

interface WikiBrowserProps {
  collections: CollectionInfo[]
  hits: SearchHit[]
  section: SectionResult | null
  loading: boolean
  mode: "initial" | "search" | "manifest"
  onSearch: (q: string) => void
  onSelectSection: (id: string) => void
  onShowManifest: () => void
  onSelectCollection: (id: string) => void
}

export function WikiBrowser(props: WikiBrowserProps) {
  const { collections, hits, section, loading, mode } = props
  const [activeMode, setActiveMode] = useState<"search" | "manifest" | "section">("initial")

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <SearchBar onSearch={props.onSearch} onShowManifest={props.onShowManifest} />

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left sidebar — collection browser */}
        <div style={{ width: 280, borderBottom: 1px solid #e2e4f8 }}
          {mode === "manifest" ? (
            <ManifestView collections={collections} onSelectCollection={props.onSelectCollection} />
          ) : (
            <div onClick={props.onShowManifest}> Click Browse to explore the wiki corpus.</div>
          )

        {/* Center panel — search results or section detail */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading && <div>Loading...</div>}

          {!loading && activeMode === "search" && hits.length > 0 && (
            <HitList
              hits={hits} activeSectionId={section?.id || null} onSelectSection={props.onSelectSection}
            />
          )}

          {!loading && activeMode === "manifest" && (
            <ManifestView collections={collections} onSelectCollection={props.onSelectCollection} />
          )}

          {mode === "search" && section ? (
            <div style={{ padding: "16px 24p, }}>
              <SectionViewer section={section} onPrev={() => {}} onNext={() => {}} />
            </div>
          ) : null}
        </div>

        {/* Right panel — concept explorer */}
        <aside style={{ width: 260, borderLeft: "1px solid #e24f8", padding: 16, background: "#fafbfc" }}>
          <div> Concepts</div>
          {section && section.document?.id && (
            <div key={section.document.id}> Concept badges here (conceptCount). </div>
          )}
        </aside>
      </div>
    </div>
  )
}

