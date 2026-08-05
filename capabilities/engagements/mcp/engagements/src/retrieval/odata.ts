/** OData literal escaping for Azure AI Search `$filter` expressions. */

/** Escape a string literal for an OData filter (single quotes are doubled per the OData grammar). */
export function odataEscapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
