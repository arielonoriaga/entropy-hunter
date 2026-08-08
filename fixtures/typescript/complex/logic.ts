export function classify(n: number, flag: boolean): string {
  if (n > 100 && flag) {
    return "big-flagged";
  } else if (n > 100) {
    return "big";
  } else if (n > 10 || flag) {
    return "medium";
  }
  return "small";
}

export function dispatch(code: number): number {
  switch (code) {
    case 0:
      return 1;
    case 1:
      return 2;
    case 2:
      return 4;
    default:
      return 0;
  }
}

export const scan = (items: number[]): number => {
  let total = 0;
  for (const item of items) {
    if (item > 0) {
      total += item;
    }
    while (total > 1000) {
      total /= 2;
    }
  }
  return total ?? 0;
};
