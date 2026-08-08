// Anti-pattern on purpose: three sibling ifs re-check isLoggedIn() instead
// of nesting once inside a single guard with early-return branches.
export function resolveAddress(
  isLoggedIn: () => boolean,
  hasSelectedAddress: () => boolean,
  wantsSave: () => boolean,
  free: () => string,
): string {
  if (isLoggedIn() && hasSelectedAddress()) {
    return "selected";
  }
  if (isLoggedIn() && wantsSave()) {
    return "saved";
  }
  return free();
}

// Unrelated, single condition — must not be flagged (nothing to consolidate).
export function isEven(n: number): boolean {
  if (n % 2 === 0) {
    return true;
  }
  return false;
}
