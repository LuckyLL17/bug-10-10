import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../app';
import { TwinStore } from '../domain/store';
import { TopologyVersion } from '../domain/types';
import { AuditService } from '../services/audit-service';
import { RootCauseService } from '../services/root-cause-service';
import { TopologyService } from '../services/topology-service';

function makeServices() {
  const store = new TwinStore();
  const topology = new TopologyService(store);
  const audit = new AuditService();
  const causes = new RootCauseService(store, topology, audit);
  return { store, topology, audit, causes };
}

function addIncident(store: TwinStore, id: string, assetIds: string[], detectedAt: number) {
  store.incidents.set(id, { id, severity: 'high', status: 'open', assetIds, detectedAt, evidence: [] });
}

/** Every part of a result must correspond to exactly one stored topology version. */
function assertAnalysisConsistent(result: any, store: TwinStore, audit: AuditService, primary: string) {
  const stored = store.topology.find(v => v.version === result.topologyVersion);
  assert.ok(stored, `topology version ${result.topologyVersion} referenced by result must exist`);

  // snapshot nodes/edges in the result are exactly the stored version's structure
  assert.deepEqual(result.snapshot.nodes, [...(stored.nodes ?? [])]);
  assert.deepEqual(result.snapshot.edges, stored.edges.map(e => ({ from: e.from, to: e.to, weight: e.weight })));
  assert.equal(result.topologyEffectiveAt, stored.effectiveAt);

  // every candidate is an upstream edge of the primary asset inside the same snapshot
  const edgeKeys = new Set(result.snapshot.edges.map((e: any) => `${e.from}->${e.to}`));
  for (const c of result.candidates) {
    assert.ok(edgeKeys.has(`${c.assetId}->${primary}`), `candidate ${c.assetId} must come from the result's own snapshot`);
    assert.ok(c.traceId.startsWith(`${result.analysisId}:`), 'traceId must belong to this analysis run');
    assert.ok(c.traceId.endsWith(`@v${result.topologyVersion}`), 'traceId version must match result version');
  }
  // deterministic ordering: weight desc
  for (let i = 1; i < result.candidates.length; i++) {
    assert.ok(result.candidates[i - 1].weight >= result.candidates[i].weight);
  }

  // audit entry bound to the same analysis and the same version
  const entries = audit.list(result.incidentId).filter(e => e.action === 'root-cause.analyze');
  const entry = entries.find(e => e.id === result.auditId);
  assert.ok(entry, 'result must reference an existing audit entry');
  assert.equal(entry!.metadata.analysisId, result.analysisId);
  assert.equal(entry!.metadata.topologyVersion, result.topologyVersion);
  assert.equal(entry!.metadata.topologyEffectiveAt, result.topologyEffectiveAt);
  assert.equal(entry!.metadata.candidateCount, result.candidates.length);
}

/** Structural equality ignoring per-run identifiers. */
function structural(result: any) {
  const { analysisId, auditId, ...rest } = result;
  return { ...rest, candidates: rest.candidates.map((c: any) => ({ assetId: c.assetId, weight: c.weight, reason: c.reason })) };
}

test('published versions are immutable and self-contained', () => {
  const { store, topology } = makeServices();
  const body: TopologyVersion = { version: 1, effectiveAt: 0, edges: [{ from: 'a', to: 'b', weight: 1 }] };
  const stored = topology.publish(body);

  // mutating the caller's object after publish must not leak into the store
  body.edges.push({ from: 'x', to: 'y', weight: 9 });
  assert.equal(store.topology[0].edges.length, 1);

  // the stored version is frozen: it cannot be rewritten in place
  assert.throws(() => (stored.edges as any).push({ from: 'x', to: 'y', weight: 9 }), TypeError);
  assert.throws(() => ((stored.edges[0] as any).weight = 99), TypeError);

  // snapshots are copies: mutating one must not rewrite history
  const snap = topology.snapshotByVersion(1);
  snap.edges.push({ from: 'x', to: 'y', weight: 9 });
  snap.nodes.push('x', 'y');
  assert.equal(store.topology[0].edges.length, 1);
  assert.deepEqual(topology.snapshotByVersion(1).nodes, ['a', 'b']);
});

test('a snapshot captured before a publish is never rewritten by it', () => {
  const { topology } = makeServices();
  topology.publish({ version: 1, effectiveAt: 100, edges: [{ from: 'a', to: 'c', weight: 0.9 }] });
  const snap = topology.snapshot(150);
  const before = JSON.parse(JSON.stringify(snap));

  topology.publish({ version: 2, effectiveAt: 120, nodes: ['d', 'e'], edges: [{ from: 'd', to: 'e', weight: 0.1 }] });

  assert.deepEqual(snap, before, 'an already-captured snapshot must be untouched by later publishes');
  assert.equal(snap.version, 1);
});

test('one analysis uses exactly one snapshot even when a publish lands mid-sequence', () => {
  const { store, topology, audit, causes } = makeServices();
  topology.publish({ version: 1, effectiveAt: 0, edges: [{ from: 'a', to: 'p', weight: 0.9 }, { from: 'b', to: 'p', weight: 0.8 }] });
  addIncident(store, 'inc-1', ['p', 'q'], 1000); // multiple assets: per-asset reads must share one snapshot

  const r1 = causes.analyze('inc-1');
  assert.equal(r1.topologyVersion, 1);
  assertAnalysisConsistent(r1, store, audit, 'p');

  // publish a completely different structure; re-analysis picks v2 as a whole, never a mix
  topology.publish({ version: 2, effectiveAt: 0, edges: [{ from: 'z', to: 'p', weight: 0.7 }] });
  const r2 = causes.analyze('inc-1');
  assert.equal(r2.topologyVersion, 2);
  assertAnalysisConsistent(r2, store, audit, 'p');
  assert.deepEqual(r2.candidates.map((c: any) => c.assetId), ['z']);

  // v1 result still matches v1's stored structure: no cross-version splice
  assertAnalysisConsistent(r1, store, audit, 'p');
});

test('repeated concurrent analyses on the same input are reproducible and traceable', async () => {
  const { store, topology, audit, causes } = makeServices();
  topology.publish({ version: 1, effectiveAt: 0, edges: [{ from: 'a', to: 'p', weight: 0.9 }, { from: 'b', to: 'p', weight: 0.9 }, { from: 'c', to: 'p', weight: 0.5 }] });
  addIncident(store, 'inc-1', ['p'], 1000);

  const results = await Promise.all([...Array(20)].map(() => Promise.resolve().then(() => causes.analyze('inc-1'))));

  const first = JSON.stringify(structural(results[0]));
  for (const r of results) {
    assert.equal(JSON.stringify(structural(r)), first, 'same input must yield the same structure');
    assertAnalysisConsistent(r, store, audit, 'p');
  }
  // each run is still individually traceable
  assert.equal(new Set(results.map(r => r.analysisId)).size, 20);
  assert.equal(new Set(results.map(r => r.auditId)).size, 20);
  // deterministic tie-break on equal weights
  assert.deepEqual(results[0].candidates.map((c: any) => c.assetId), ['a', 'b', 'c']);
});

test('different node/edge sets per version resolve by effective time', () => {
  const { store, topology, audit, causes } = makeServices();
  topology.publish({ version: 1, effectiveAt: 100, edges: [{ from: 'a', to: 'p', weight: 0.9 }] });
  topology.publish({ version: 2, effectiveAt: 200, edges: [{ from: 'a', to: 'p', weight: 0.9 }, { from: 'b', to: 'p', weight: 0.8 }] });
  topology.publish({ version: 3, effectiveAt: 300, nodes: ['d', 'p'], edges: [{ from: 'd', to: 'p', weight: 0.7 }] });
  addIncident(store, 'inc-1', ['p'], 150);
  addIncident(store, 'inc-2', ['p'], 250);
  addIncident(store, 'inc-3', ['p'], 350);

  const r1 = causes.analyze('inc-1');
  const r2 = causes.analyze('inc-2');
  const r3 = causes.analyze('inc-3');

  assert.equal(r1.topologyVersion, 1);
  assert.deepEqual(r1.candidates.map((c: any) => c.assetId), ['a']);
  assert.equal(r2.topologyVersion, 2);
  assert.deepEqual(r2.candidates.map((c: any) => c.assetId), ['a', 'b']);
  assert.equal(r3.topologyVersion, 3);
  assert.deepEqual(r3.candidates.map((c: any) => c.assetId), ['d']);
  assert.deepEqual(r3.snapshot.nodes, ['d', 'p']);

  for (const r of [r1, r2, r3]) assertAnalysisConsistent(r, store, audit, 'p');
});

test('failed retries keep an explicit version context', () => {
  const { store, topology, audit, causes } = makeServices();
  topology.publish({ version: 1, effectiveAt: 0, edges: [{ from: 'a', to: 'p', weight: 0.9 }] });
  topology.publish({ version: 2, effectiveAt: 0, edges: [{ from: 'b', to: 'p', weight: 0.8 }] });
  addIncident(store, 'inc-1', ['p'], 1000);

  const first = causes.analyze('inc-1', { topologyVersion: 1 });
  assert.equal(first.topologyVersion, 1);

  // a retry pinned to v1 after v2 became current reproduces the exact same context
  const retry = causes.analyze('inc-1', { topologyVersion: 1 });
  assert.equal(retry.topologyVersion, 1);
  assert.deepEqual(structural(retry), structural(first));

  // pinning a version that does not exist fails with a clear, typed error...
  assert.throws(() => causes.analyze('inc-1', { topologyVersion: 99 }), /topology version 99 not found/);
  // ...and the follow-up retry still runs against the explicit context, not a drifted one
  const afterError = causes.analyze('inc-1', { topologyVersion: 1 });
  assert.equal(afterError.topologyVersion, 1);
  assert.deepEqual(structural(afterError), structural(first));

  // missing incident fails typed as well, and succeeds once the incident exists
  assert.throws(() => causes.analyze('inc-missing'), /incident not found/);
  addIncident(store, 'inc-missing', ['p'], 1000);
  assert.equal(causes.analyze('inc-missing', { topologyVersion: 2 }).topologyVersion, 2);

  assertAnalysisConsistent(retry, store, audit, 'p');
});

test('historical versions remain lookback-able after newer publishes', () => {
  const { topology } = makeServices();
  topology.publish({ version: 1, effectiveAt: 100, edges: [{ from: 'a', to: 'p', weight: 0.9 }] });
  topology.publish({ version: 2, effectiveAt: 200, edges: [{ from: 'b', to: 'p', weight: 0.8 }] });
  topology.publish({ version: 3, effectiveAt: 300, edges: [{ from: 'c', to: 'p', weight: 0.7 }] });

  const v1 = topology.snapshotByVersion(1);
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.edges, [{ from: 'a', to: 'p', weight: 0.9 }]);
  assert.deepEqual(v1.nodes, ['a', 'p']);
  assert.deepEqual(topology.versions().map(v => v.version), [1, 2, 3]);
  assert.throws(() => topology.snapshotByVersion(4), /not found/);
});

test('interleaved publish/analyze storm never produces a mixed snapshot (service level)', () => {
  const { store, topology, audit, causes } = makeServices();
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (arr: string[]) => arr[Math.floor(rand() * arr.length)];

  const incidents: string[] = [];
  for (let round = 0; round < 200; round++) {
    if (round % 2 === 0) {
      const v = store.topology.length + 1;
      const edges = [...Array(1 + Math.floor(rand() * 4))].map(() => ({
        from: `n${Math.floor(rand() * 6)}`, to: 'p', weight: Math.round(rand() * 100) / 100,
      }));
      topology.publish({ version: v, effectiveAt: 0, edges });
    }
    const incId = `inc-${round}`;
    addIncident(store, incId, [pick(['p', 'n0', 'n1'])], 1000);
    incidents.push(incId);

    const result = causes.analyze(incId);
    assertAnalysisConsistent(result, store, audit, 'p');
  }
  assert.ok(store.topology.length >= 90, 'storm must have published many versions');
});

test('HTTP: concurrent publishes and analyses stay version-consistent end to end', async () => {
  const app = buildApp();
  const post = (url: string, payload: any): Promise<any> => app.inject({ method: 'POST', url, payload });
  const get = (url: string): Promise<any> => app.inject({ method: 'GET', url });

  await post('/topology', { version: 1, effectiveAt: 0, edges: [{ from: 'a', to: 'p', weight: 0.9 }] });
  await post('/telemetry', { assetId: 'p', metric: 'temp', value: 10, unit: 'C', observedAt: 1000, quality: 'good' });
  const incident = (await post('/anomalies/detect', { assetId: 'p', metric: 'temp', threshold: 1 })).json();
  assert.ok(incident.id);

  const analyze = async () => {
    const res = await get(`/incidents/${incident.id}/root-cause`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };

  const all: any[] = [];
  for (let round = 0; round < 10; round++) {
    // a batch of concurrent analyses, then a publish that may interleave with the next batch
    const batch = await Promise.all([...Array(5)].map(analyze));
    all.push(...batch);
    const v = round + 2;
    const pub = await post('/topology', { version: v, effectiveAt: 0, edges: [{ from: `up${v}`, to: 'p', weight: 0.5 }] });
    assert.equal(pub.statusCode, 200, pub.body);
  }

  const audits = (await get(`/audit?entityId=${incident.id}`)).json();
  for (const r of all) {
    // version id, snapshot content, candidates and audit must all correspond
    const topo = (await get(`/topology/${r.topologyVersion}`)).json();
    assert.deepEqual(r.snapshot.edges, topo.edges);
    assert.deepEqual(r.snapshot.nodes, topo.nodes);
    for (const c of r.candidates) {
      assert.ok(r.snapshot.edges.some((e: any) => e.from === c.assetId && e.to === 'p'));
      assert.ok(c.traceId.endsWith(`@v${r.topologyVersion}`));
    }
    const entry = audits.find((e: any) => e.id === r.auditId);
    assert.ok(entry, 'audit entry must exist for every analysis');
    assert.equal(entry.metadata.topologyVersion, r.topologyVersion);
  }
  // analyses spanned multiple versions across rounds — and every one is self-consistent
  assert.ok(new Set(all.map(r => r.topologyVersion)).size > 1);

  // retry through the API with an explicit pinned version reproduces the earlier context
  const v1 = all.find(r => r.topologyVersion === 1);
  const retry = (await get(`/incidents/${incident.id}/root-cause?topologyVersion=1`)).json();
  assert.equal(retry.topologyVersion, 1);
  assert.deepEqual(retry.snapshot, v1.snapshot);
  assert.deepEqual(retry.candidates.map((c: any) => c.assetId), v1.candidates.map((c: any) => c.assetId));

  // typed failures: unknown pinned version, unknown incident, bad param
  assert.equal((await get(`/incidents/${incident.id}/root-cause?topologyVersion=99`)).statusCode, 404);
  assert.equal((await get('/incidents/nope/root-cause')).statusCode, 404);
  assert.equal((await get(`/incidents/${incident.id}/root-cause?topologyVersion=abc`)).statusCode, 400);

  await app.close();
});
