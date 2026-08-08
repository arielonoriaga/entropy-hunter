// Anti-pattern on purpose: optional soup, most combinations invalid.
export interface Request {
  data?: string;
  error?: string;
  loading: boolean;
  cancelled: boolean;
  retryAt: number | null;
}

// Anti-pattern on purpose: a flattened order entity (order* data clump).
export interface Checkout {
  orderId: number;
  orderDate: string;
  orderTotal: number;
  customerName: string;
}

// The fix: discriminated union. Contributes nothing to the score.
export type RequestState =
  | { kind: "idle" }
  | { kind: "loading"; startedAt: number }
  | { kind: "done"; data: string }
  | { kind: "failed"; error: string };
