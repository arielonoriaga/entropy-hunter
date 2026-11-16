import { describe, expect, test } from "bun:test";
import { bitmask, transitiveReach } from "../src/graph";

// Reference implementation: BFS from every node (what the engine used to do).
function bfsReach(edges: number[][]): Set<number>[] {
  return edges.map((_, start) => {
    const seen = new Set<number>([start]);
    const queue = [start];
    while (queue.length) {
      for (const next of edges[queue.pop()!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    seen.delete(start);
    return seen;
  });
}

// Deterministic pseudo-random graph (mulberry32) — no flaky seeds.
function randomGraph(nodes: number, edgeCount: number, seed: number): number[][] {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const edges: number[][] = Array.from({ length: nodes }, () => []);
  for (let i = 0; i < edgeCount; i++) {
    const from = Math.floor(next() * nodes);
    const to = Math.floor(next() * nodes);
    if (from !== to && !edges[from].includes(to)) edges[from].push(to);
  }
  return edges;
}

describe("transitiveReach", () => {
  test("chain, diamond and an isolated node", () => {
    //  0 → 1 → 3,  0 → 2 → 3,  4 alone
    const reach = transitiveReach([[1, 2], [3], [3], [], []]);
    expect([0, 1, 2, 3, 4].map((n) => reach.count(n))).toEqual([3, 1, 1, 0, 0]);
  });

  test("members of a cycle reach each other but never count themselves", () => {
    //  0 → 1 → 2 → 0,  2 → 3
    const reach = transitiveReach([[1], [2], [0, 3], []]);
    expect([0, 1, 2, 3].map((n) => reach.count(n))).toEqual([3, 3, 3, 0]);
  });

  test("firstIn returns the lowest reachable masked node, excluding the start", () => {
    const reach = transitiveReach([[1], [2], [0, 3], []]);
    expect(reach.firstIn(0, bitmask(4, [0, 3]))).toBe(3); // 0 itself is not "reached"
    expect(reach.firstIn(1, bitmask(4, [0, 3]))).toBe(0);
    expect(reach.firstIn(3, bitmask(4, [0, 1, 2]))).toBe(-1);
  });

  test("matches a BFS from every node on random graphs, sparse through cyclic", () => {
    for (const [nodes, edgeCount, seed] of [[70, 40, 1], [70, 120, 2], [70, 400, 3], [130, 260, 4]]) {
      const edges = randomGraph(nodes, edgeCount, seed);
      const expected = bfsReach(edges);
      const reach = transitiveReach(edges);
      for (let node = 0; node < nodes; node++) {
        expect(reach.count(node)).toBe(expected[node].size);
        const everything = bitmask(nodes, Array.from({ length: nodes }, (_, i) => i));
        const lowest = expected[node].size ? Math.min(...expected[node]) : -1;
        expect(reach.firstIn(node, everything)).toBe(lowest);
      }
    }
  });
});
