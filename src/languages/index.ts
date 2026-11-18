import type { LanguageAnalyzer } from "./analyzer";
import { genericAnalyzerFor } from "./generic";
import { rustAnalyzer } from "./rust";
import { javascriptAnalyzer, jsxAnalyzer, typescriptAnalyzer } from "./typescript";

// Plugin registry — add a language by implementing LanguageAnalyzer and
// appending it here. Anything not covered by a dedicated plugin falls back
// to the generic (approximate) analyzer.
export const analyzers: LanguageAnalyzer[] = [rustAnalyzer, jsxAnalyzer, javascriptAnalyzer, typescriptAnalyzer];

export function analyzerFor(path: string): LanguageAnalyzer | null {
  return analyzers.find((a) => a.detect(path)) ?? genericAnalyzerFor(path);
}

export type { LanguageAnalyzer } from "./analyzer";
