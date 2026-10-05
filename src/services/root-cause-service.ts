import { DomainError } from '../core/errors'; import { newId } from '../core/id'; import { TwinStore } from '../domain/store'; import { AuditService } from './audit-service'; import { TopologyService } from './topology-service';

export interface RootCauseOptions {
  /** Pin an explicit topology version so a retry reproduces the exact context of an earlier attempt. */
  topologyVersion?: number;
}

export class RootCauseService {
  constructor(private store: TwinStore, private topology: TopologyService, private audit: AuditService) {}

  analyze(incidentId: string, options: RootCauseOptions = {}) {
    const incident = this.store.incidents.get(incidentId);
    if (!incident) throw new DomainError('INCIDENT_NOT_FOUND', 'incident not found');

    const analysisId = newId('rca');

    // Capture exactly one complete snapshot at the start of the analysis.
    // Every node/edge read below comes from this object alone, so a concurrent
    // publish can never splice another version's nodes or edges into this
    // root cause path, and can never rewrite this analysis's input.
    const snapshot = options.topologyVersion !== undefined
      ? this.topology.snapshotByVersion(options.topologyVersion)
      : this.topology.snapshot(incident.detectedAt);

    const nodeSet = new Set(snapshot.nodes);
    const unknownAssets = incident.assetIds.filter(id => !nodeSet.has(id));

    // Traverse only the captured snapshot; dedupe edges shared by several incident assets.
    const primary = incident.assetIds[0];
    const seen = new Set<string>();
    const upstream: Array<{ from: string; to: string; weight: number }> = [];
    for (const assetId of incident.assetIds) {
      for (const e of this.topology.impact(assetId, snapshot)) {
        if (e.to !== primary) continue;
        const key = `${e.from}->${e.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        upstream.push(e);
      }
    }
    upstream.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

    const candidates = upstream.map(e => ({
      assetId: e.from,
      weight: e.weight,
      reason: 'topology dependency',
      traceId: `${analysisId}:${e.from}->${e.to}@v${snapshot.version}`,
    }));
    const confidence = Math.min(.99, .55 + upstream.length * .1);

    // Bind the audit record to the exact same snapshot version as the result.
    const auditEntry = this.audit.record('root-cause.analyze', incidentId, {
      analysisId,
      topologyVersion: snapshot.version,
      topologyEffectiveAt: snapshot.effectiveAt,
      pinnedVersion: options.topologyVersion ?? null,
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
      candidateCount: candidates.length,
      confidence,
    });

    return {
      analysisId,
      incidentId,
      topologyVersion: snapshot.version,
      topologyEffectiveAt: snapshot.effectiveAt,
      snapshot: { nodes: [...snapshot.nodes], edges: snapshot.edges.map(e => ({ ...e })) },
      confidence,
      candidates,
      warnings: unknownAssets.map(id => `asset ${id} not present in topology v${snapshot.version}`),
      auditId: auditEntry.id,
    };
  }
}
