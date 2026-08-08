// Anti-pattern on purpose: domain reaching outward into infrastructure.
import { loadProduct } from "../infrastructure/repo";

export function describeProduct(id: number): string {
  const p = loadProduct(id);
  return p.title;
}
