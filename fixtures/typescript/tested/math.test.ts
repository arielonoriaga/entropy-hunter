import { clampToRange } from "./math";

test("clampToRange clamps", () => {
  if (clampToRange(5, 0, 10) !== 5) throw new Error("fail");
});
