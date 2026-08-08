import type { LanguageAnalyzer } from "./analyzer";
import { rustAnalyzer } from "./rust";
import { typescriptAnalyzer } from "./typescript";

// Plugin registry — add a language by implementing LanguageAnalyzer and
// appending it here.
export const analyzers: LanguageAnalyzer[] = [rustAnalyzer, typescriptAnalyzer];

export function analyzerFor(path: string): LanguageAnalyzer | null {
  return analyzers.find((a) => a.detect(path)) ?? null;
}

export type { LanguageAnalyzer } from "./analyzer";
