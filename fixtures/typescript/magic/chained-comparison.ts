// Anti-pattern on purpose: a chain of equality comparisons against the same
// identifier — the shape that collapses into one Set.has()/includes() check.
export function showExportButtons(tab: () => string): boolean {
  return (
    tab() !== "products" &&
    tab() !== "movimientos" &&
    tab() !== "resumen" &&
    tab() !== "entra-sale"
  );
}

// Not a chain: only two comparisons (the fix line exists below), and a
// single stray comparison against a different identifier.
export function isShortChain(status: string, role: string): boolean {
  return status !== "draft" && status !== "archived" && role !== "guest";
}

// The fix: a named allow/deny-list collapses the chain into one lookup.
const EXCLUDED_TABS = new Set(["products", "movimientos", "resumen", "entra-sale"]);
export function showExportButtonsFixed(tab: () => string): boolean {
  return !EXCLUDED_TABS.has(tab());
}
