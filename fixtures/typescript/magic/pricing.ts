// Anti-pattern on purpose: unnamed literals and stringly-typed logic.
export function price(qty: number, status: string): number {
  if (status === "premium") {
    return qty * 0.85 * 99.99;
  }
  if (qty > 12) {
    return qty * 89.99;
  }
  switch (status) {
    case "vip":
      return qty * 79.99;
  }
  return qty * 99.99;
}

// The fix: named constants don't count as magic.
export const TAX_RATE = 0.21;
