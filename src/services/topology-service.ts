import { DomainError } from '../core/errors'; import { TwinStore } from '../domain/store'; import { TopologyEdge, TopologySnapshot, TopologyVersion } from '../domain/types';

const cloneEdges = (edges: TopologyEdge[]): TopologyEdge[] => edges.map(e => ({ from: e.from, to: e.to, weight: e.weight }));

/** Deterministic edge ordering: weight desc, then endpoints asc for stable tie-breaks. */
const byWeightDesc = (a: TopologyEdge, b: TopologyEdge) =>
  b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);

function normalize(version: TopologyVersion): Required<TopologyVersion> {
  const nodes = new Set<string>(version.nodes ?? []);
  for (const e of version.edges) { nodes.add(e.from); nodes.add(e.to); }
  return { version: version.version, effectiveAt: version.effectiveAt, nodes: [...nodes].sort(), edges: cloneEdges(version.edges) };
}

/** Deep-freeze a published version so no later code path can rewrite history. */
function freezeVersion(v: Required<TopologyVersion>): Required<TopologyVersion> {
  for (const e of v.edges) Object.freeze(e);
  Object.freeze(v.edges); Object.freeze(v.nodes);
  return Object.freeze(v);
}

export class TopologyService {
  constructor(private store: TwinStore) {}

  publish(version: TopologyVersion) {
    if (version.version !== this.store.topology.length + 1) throw new DomainError('VERSION_GAP', 'topology version must be sequential');
    // Store an immutable, self-contained copy. Once published, a version can
    // never be mutated, so any snapshot captured before a later publish keeps
    // seeing the complete old structure and is never rewritten in place.
    const stored = freezeVersion(normalize(version));
    this.store.topology.push(stored);
    return stored;
  }

  versions() {
    return this.store.topology.map(v => ({ version: v.version, effectiveAt: v.effectiveAt, nodeCount: (v.nodes ?? []).length, edgeCount: v.edges.length }));
  }

  /** Capture a complete snapshot of the version effective at business time `at`. */
  snapshot(at: number): TopologySnapshot {
    const candidates = this.store.topology.filter(v => v.effectiveAt <= at);
    if (!candidates.length) throw new DomainError('NO_TOPOLOGY', 'no effective topology');
    return this.toSnapshot(candidates[candidates.length - 1]);
  }

  /** Capture a snapshot of an explicit version: retry with a pinned context, or historical lookback. */
  snapshotByVersion(version: number): TopologySnapshot {
    const found = this.store.topology.find(v => v.version === version);
    if (!found) throw new DomainError('TOPOLOGY_VERSION_NOT_FOUND', `topology version ${version} not found`);
    return this.toSnapshot(found);
  }

  private toSnapshot(v: TopologyVersion): TopologySnapshot {
    const nodes = v.nodes ?? [...new Set(v.edges.flatMap(e => [e.from, e.to]))].sort();
    return { version: v.version, effectiveAt: v.effectiveAt, nodes: [...nodes], edges: cloneEdges(v.edges) };
  }

  /** Edges incident to `assetId`, read exclusively from the given snapshot. */
  impact(assetId: string, snapshot: TopologySnapshot) {
    return snapshot.edges
      .filter(e => e.from === assetId || e.to === assetId)
      .sort(byWeightDesc)
      .map(e => ({ ...e, traceId: `topo_v${snapshot.version}:${e.from}->${e.to}` }));
  }
}
