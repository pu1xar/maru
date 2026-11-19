// Main lane of a Claude transcript's parentUuid tree (docs/event-model.md 7.3). A port of
// docs/event-model-tools/lane_test.py, the script whose whole-corpus run produced the 7.3 table.
//
//   - a node is a line with a uuid; its parent is parentUuid, or none when that uuid is not loaded
//   - parent walks are cycle-guarded: a node closing a cycle loses its parent and becomes a root
//   - each root tree has its own P*, the last run-opening node in file order; the tree's main lane
//     is ancestors(P*) + subtree(P*) + the side subtrees of path nodes that hold no opener
//   - a side subtree of a path node that holds an opener is an alternate lane, named after its root
//   - a tree without an opener is all main

export interface LaneNode {
  uuid: string;
  parentUuid: string | null;
  opener: boolean;
}

export interface LaneFork {
  /** The path node the alternates hang from. */
  forkPointUuid: string;
  /** Alternate lane ids, in file order of their first node. */
  laneIds: string[];
}

export interface LaneResult {
  /** Node uuid -> alternate lane id. A node not in the map is on the main lane. */
  alt: Map<string, string>;
  forks: LaneFork[];
  /** Parent links dropped to break a cycle. */
  cycles: number;
  /** Nodes whose parentUuid is set but not loaded. */
  missingParents: number;
  /** P* of the root tree that holds the last opener, null without openers. */
  lastPStar: string | null;
}

export function laneIdFor(rootUuid: string): string {
  return `lane:${rootUuid}`;
}

/** `nodes` in file order. A repeated uuid keeps its first line. */
export function computeLanes(nodes: Iterable<LaneNode>): LaneResult {
  const order: LaneNode[] = [];
  const index = new Map<string, number>();
  for (const n of nodes) {
    if (index.has(n.uuid)) continue;
    index.set(n.uuid, order.length);
    order.push(n);
  }
  const count = order.length;
  const parent: number[] = new Array<number>(count).fill(-1);
  let missingParents = 0;
  for (let i = 0; i < count; i++) {
    const p = order[i]!.parentUuid;
    if (p === null) continue;
    const pi = index.get(p);
    if (pi === undefined) missingParents++;
    else parent[i] = pi;
  }

  // Cycle guard: walk up from every node, marking the walk; meeting the walk itself is a cycle.
  let cycles = 0;
  const state = new Uint8Array(count); // 0 unseen, 1 on the current walk, 2 done
  for (let i = 0; i < count; i++) {
    const walk: number[] = [];
    let x = i;
    while (x !== -1 && state[x] === 0) {
      state[x] = 1;
      walk.push(x);
      x = parent[x]!;
    }
    if (x !== -1 && state[x] === 1) {
      cycles++;
      parent[x] = -1;
    }
    for (const y of walk) state[y] = 2;
  }

  const children: number[][] = Array.from({ length: count }, () => []);
  const roots: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = parent[i]!;
    if (p === -1) roots.push(i);
    else children[p]!.push(i); // file order, since i ascends
  }

  // hasOpener(subtree), bottom-up; rootOf for grouping trees.
  const has = new Uint8Array(count);
  const rootOf = new Int32Array(count);
  for (const r of roots) {
    const post: number[] = [];
    const stack = [r];
    while (stack.length > 0) {
      const u = stack.pop()!;
      rootOf[u] = r;
      post.push(u);
      for (const c of children[u]!) stack.push(c);
    }
    for (let k = post.length - 1; k >= 0; k--) {
      const u = post[k]!;
      let h = order[u]!.opener;
      if (!h) for (const c of children[u]!) if (has[c]) { h = true; break; }
      has[u] = h ? 1 : 0;
    }
  }

  const lastOpenerOfRoot = new Map<number, number>();
  let lastOpener = -1;
  for (let i = 0; i < count; i++) {
    if (!order[i]!.opener) continue;
    lastOpenerOfRoot.set(rootOf[i]!, i);
    lastOpener = i;
  }

  const alt = new Map<string, string>();
  const forks: LaneFork[] = [];
  for (const [, pstar] of lastOpenerOfRoot) {
    const onPath = new Set<number>();
    for (let x = pstar; x !== -1; x = parent[x]!) onPath.add(x);
    // Path nodes from the root down, so forks come out in file order.
    const path = [...onPath].sort((a, b) => a - b);
    for (const pu of path) {
      let fork: LaneFork | null = null;
      for (const c of children[pu]!) {
        if (onPath.has(c) || !has[c]) continue;
        const laneId = laneIdFor(order[c]!.uuid);
        if (fork === null) {
          fork = { forkPointUuid: order[pu]!.uuid, laneIds: [] };
          forks.push(fork);
        }
        fork.laneIds.push(laneId);
        const stack = [c];
        while (stack.length > 0) {
          const y = stack.pop()!;
          alt.set(order[y]!.uuid, laneId);
          for (const z of children[y]!) stack.push(z);
        }
      }
    }
  }
  forks.sort((a, b) => index.get(a.forkPointUuid)! - index.get(b.forkPointUuid)!);
  return { alt, forks, cycles, missingParents, lastPStar: lastOpener === -1 ? null : order[lastOpener]!.uuid };
}
