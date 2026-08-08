import type { Product } from "../domain/model";

export function loadProduct(id: number): Product {
  return { id, title: `product ${id}` };
}
