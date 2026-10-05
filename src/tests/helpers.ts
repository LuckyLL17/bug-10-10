import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwinStore } from '../domain/store';
import { Asset, Incident, TopologyPublishInput } from '../domain/types';
import { TopologySnapshot } from '../domain/snapshot';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';
import { AuditService } from '../services/audit-service';
import { DomainError } from '../core/errors';

export interface Harness {
  store:TwinStore;
  topology:TopologyService;
  causes:RootCauseService;
  audit:AuditService;
}

export function makeHarness():Harness {
  const store = new TwinStore();
  const audit = new AuditService();
  const topology = new TopologyService(store, audit);
  const causes = new RootCauseService(store, topology, audit);
  return { store, topology, causes, audit };
}

export function registerAssets(store:TwinStore, specs:Array<[string,string]>){
  for(const [id,kind] of specs){
    const asset:Asset = {id,name:id,kind:kind as Asset['kind'],status:'healthy',criticality:1,tags:[]};
    store.assets.set(id, asset);
  }
}

export function topo(version:number, effectiveAt:number, edges:Array<[string,string,number]>, nodes?:string[]):TopologyPublishInput {
  return { version, effectiveAt, nodes: nodes ? [...nodes] : undefined, edges: edges.map(([from,to,weight])=>({from,to,weight})) };
}

export function addIncident(store:TwinStore, id:string, assetIds:string[], detectedAt:number):Incident {
  const incident:Incident = {id,severity:'high',status:'open',assetIds:[...assetIds],detectedAt,evidence:[]};
  store.incidents.set(id,incident);
  return incident;
}

/** 构造两套共享种子、但上游节点/边集合完全不同的版本。 */
export async function publishDivergentVersions(h:Harness, at = 1000){
  registerAssets(h.store, [
    ['sensor-a','sensor'],['pump-a','pump'],['valve-a','valve'],['reactor-a','reactor'],
    ['pump-b','pump'],['valve-b','valve'],['reactor-b','reactor'],
  ]);
  await h.topology.publish(topo(1, at, [
    ['pump-a','sensor-a',0.9],['valve-a','pump-a',0.8],['reactor-a','valve-a',0.7],
  ]));
  await h.topology.publish(topo(2, at + 100, [
    ['pump-b','sensor-a',0.6],['valve-b','pump-b',0.5],['reactor-b','valve-b',0.4],
  ]));
}

/** 结果一致性断言：版本/快照/节点/边/审计全部相互对应，无混合快照。 */
export function assertResultCoherent(result:any, expectedVersion:number, h:Harness){
  assert.equal(result.version, expectedVersion, '结果版本号必须等于快照版本');
  const stored = h.topology.getVersion(expectedVersion);
  assert.equal(result.snapshotId, TopologySnapshot.fingerprint(stored), 'snapshotId 必须由该版本完整内容导出');
  assert.equal(result.effectiveAt, stored.effectiveAt);

  // 所有节点必须来自该版本
  for(const node of result.nodes){
    assert.ok(stored.nodes.some(n=>n.id===node.id), `节点 ${node.id} 不属于版本 ${expectedVersion}`);
    const storedNode = stored.nodes.find(n=>n.id===node.id)!;
    assert.deepEqual(node, storedNode, `节点 ${node.id} 的结构必须与版本内定义一致`);
  }
  // 所有边必须来自该版本
  const edgeIds = new Set(stored.edges.map(e=>e.id));
  for(const edge of result.edges){
    assert.ok(edgeIds.has(edge.id), `边 ${edge.id} 不属于版本 ${expectedVersion}（检测到跨版本混合）`);
  }
  // 路径上每一跳都引用结果内的边、traceId 绑定版本
  for(const path of result.paths){
    for(const hop of path.hops){
      assert.ok(edgeIds.has(hop.edgeId), `路径跳边 ${hop.edgeId} 跨版本`);
      assert.match(hop.traceId, new RegExp(`^trace_v${expectedVersion}_edge_v${expectedVersion}_`),
        `traceId 与版本不一致: ${hop.traceId}`);
      assert.ok(result.nodes.some((n:any)=>n.id===hop.from) && result.nodes.some((n:any)=>n.id===hop.to),
        '路径端点必须在结果节点集合内');
    }
    assert.match(path.pathId, new RegExp(`^path_v${expectedVersion}_`));
    for(const cand of result.candidates){
      assert.ok(result.nodes.some((n:any)=>n.id===cand.assetId), `候选 ${cand.assetId} 不是该版本节点`);
    }
  }
  // 审计绑定
  assert.equal(result.audit.version, expectedVersion);
  assert.equal(result.audit.snapshotId, result.snapshotId);
  const start = h.audit.list(result.analysisId).find(e=>e.action==='root-cause.start');
  const done = h.audit.list(result.analysisId).find(e=>e.action==='root-cause.complete');
  assert.ok(start && done, '分析必须有开始/完成审计记录');
  assert.equal(start!.metadata.version, expectedVersion);
  assert.equal(start!.metadata.snapshotId, result.snapshotId);
  assert.equal(done!.metadata.snapshotId, result.snapshotId);
  assert.equal(done!.metadata.fingerprint, result.fingerprint);
}

export function expectError(code:string){
  return (err:unknown)=>{ assert.ok(err instanceof DomainError && err.code===code, `expected ${code}, got ${String(err)}`); return true; };
}
