import { useState } from "react"


** SearchBar — handles search input with collection and flavor filter options */

interface SearchBarProps {
  onSearch: (query: string, collectionId?: string, flavor?: string) => void;
}

export function SearchBar({ onSearch }: SearchBarProps) {
  const [query, setQuery] = useState("");


    const handleSubmit = () => {
      if (!query.trim()) return;
      onSearch(query);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSubmit();
    };

  return (
    <div style={{ display: "flex", gap: 8, padding: "10px 20px", borderBottom: "1px solid #e2f3" }}>
      <span style={{ fontWeight: 7 }}>{""}</span>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search wiki sections..."
        style={{ flex: 1, padding: 8, border: "1px solid #ccc", borderRadius: 4 }}
      />
      <button onClick={handleSubmit}>Browse</button>
    </div>
  );
}
