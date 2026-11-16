// Transitive reachability over the dependents graph, as bitsets.
//
// Every node of a strongly connected component reaches the same set, and a
// component's set is the union of its successors' sets — so one bitset per
// component, built in reverse topological order (which is the order Tarjan
// emits components), replaces a BFS from every file. Leaves (nothing depends
// on them — most files) share one empty set.

const WORD_BITS = 32;

export interface Reach {
  // Nodes transitively reachable from `node`, itself excluded.
  count(node: number): number;
  // Lowest-numbered reachable node also present in `mask`, or -1.
  firstIn(node: number, mask: Uint32Array): number;
  // Is `node` on a cycle (in a strongly connected group of 2+ nodes)?
  cyclic(node: number): boolean;
}

export function bitmask(size: number, members: Iterable<number>): Uint32Array {
  const mask = new Uint32Array(Math.ceil(size / WORD_BITS));
  for (const m of members) mask[m >>> 5] |= 1 << (m & 31);
  return mask;
}

function popcount(bits: Uint32Array): number {
  let total = 0;
  for (let w = 0; w < bits.length; w++) {
    let x = bits[w];
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    total += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return total;
}

// Tarjan's algorithm, iterative (import chains can be deeper than the stack).
// Returns each node's component id; ids are assigned in reverse topological
// order, i.e. a component is numbered after every component it can reach.
function components(edges: number[][]): { of: Int32Array; members: number[][] } {
  const n = edges.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const of = new Int32Array(n).fill(-1);
  const members: number[][] = [];
  const stack: number[] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const frames: [node: number, nextEdge: number][] = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const node = frame[0];
      if (frame[1] < edges[node].length) {
        const next = edges[node][frame[1]++];
        if (index[next] === -1) {
          index[next] = low[next] = counter++;
          stack.push(next);
          onStack[next] = 1;
          frames.push([next, 0]);
        } else if (onStack[next]) {
          low[node] = Math.min(low[node], index[next]);
        }
        continue;
      }
      frames.pop();
      if (frames.length) {
        const parent = frames[frames.length - 1][0];
        low[parent] = Math.min(low[parent], low[node]);
      }
      if (low[node] !== index[node]) continue;
      const group: number[] = [];
      let member: number;
      do {
        member = stack.pop()!;
        onStack[member] = 0;
        of[member] = members.length;
        group.push(member);
      } while (member !== node);
      members.push(group);
    }
  }
  return { of, members };
}

// edges[i] = nodes directly reachable from node i.
export function transitiveReach(edges: number[][]): Reach {
  const n = edges.length;
  const words = Math.ceil(n / WORD_BITS);
  const empty = new Uint32Array(words);
  const { of, members } = components(edges);
  const sets: Uint32Array[] = [];

  for (let id = 0; id < members.length; id++) {
    const group = members[id];
    let bits: Uint32Array | null = null;
    for (const node of group) {
      for (const next of edges[node]) {
        bits ??= new Uint32Array(words);
        bits[next >>> 5] |= 1 << (next & 31);
        // A different component here is always already built (reverse
        // topological numbering); the same component adds its members below.
        const reached = of[next] === id ? empty : sets[of[next]];
        if (reached !== empty) for (let w = 0; w < words; w++) bits[w] |= reached[w];
      }
    }
    sets.push(bits ?? empty);
  }

  const sizes = new Int32Array(members.length).fill(-1);
  const has = (bits: Uint32Array, node: number) => (bits[node >>> 5] >>> (node & 31)) & 1;
  return {
    cyclic: (node) => members[of[node]].length > 1,
    count(node) {
      const id = of[node];
      if (sizes[id] === -1) sizes[id] = popcount(sets[id]);
      return sizes[id] - has(sets[id], node);
    },
    firstIn(node, mask) {
      const bits = sets[of[node]];
      if (bits === empty) return -1;
      for (let w = 0; w < words; w++) {
        let hit = bits[w] & mask[w];
        if (w === node >>> 5) hit &= ~(1 << (node & 31));
        if (hit) return w * WORD_BITS + (31 - Math.clz32(hit & -hit));
      }
      return -1;
    },
  };
}
