import { DomainError } from '../core/errors';
import { newId } from '../core/id';
import { TwinStore } from '../domain/store';
import { TopologySnapshot } from '../domain/snapshot';
import { AuditService } from './audit-service';
import { TopologyService } from './topology-service';

export interface AnalyzeOptions {
  /** 显式钉住版本：失败重试和历史回看必须携带，保证继续使用同一个明确版本。 */
  version?:number;
  /** 失败重试时带上既有分析 id，尝试会追加到同一条分析记录上。 */
  analysisId?:string;
  /**
   * 遍历前置钩子（确定性故障注入/同步点）：在快照已捕获、遍历未开始时触发，
   * 可返回 Promise 以把遍历推迟到发布动作交错完成之后。
   * 抛错则本次尝试失败，但快照与版本上下文已绑定，可用相同参数重试。
   */
  beforeTraversal?:(ctx:{snapshot:TopologySnapshot; attempt:number})=>void|Promise<void>;
}

export interface RootCauseHop { edgeId:string; from:string; to:string; weight:number; hop:number; traceId:string }
export interface RootCausePath { pathId:string; seedAssetId:string; rootAssetId:string; hops:RootCauseHop[]; totalWeight:number; depth:number }
export interface RootCauseCandidate { assetId:string; maxWeight:number; pathCount:number; reason:string }
export interface RootCauseRunSummary {
  analysisId:string;
  incidentId:string;
  attempts:number;
  status:'completed'|'failed';
  version:number;
  snapshotId:string;
  startedAt:number;
  finishedAt?:number;
  error?:string;
}

export const MAX_TRAVERSAL_DEPTH = 8;

export class RootCauseService {
  /** analysisId -> 分析运行记录（含失败尝试），用于失败重试与审计追溯。 */
  private runs = new Map<string,RootCauseRunSummary>();

  constructor(
    private store:TwinStore,
    private topology:TopologyService,
    private audit?:AuditService,
  ){}

  /**
   * 执行根因分析。
   *
   * 竞态修复约定：
   * - 进入方法后第一件事是同步捕获拓扑快照（在任何 await 之前），
   *   随后的遍历只读取该快照，不再访问 store.topology；
   * - 发布切换只追加新版本，进行中的分析持有的快照不受影响；
   * - 重试必须显式带回 version（或由既有 analysisId 恢复），杜绝"重试时悄悄换版本"。
   */
  async analyze(incidentId:string, options:AnalyzeOptions = {}){
    const incident = this.store.incidents.get(incidentId);
    if(!incident) throw new DomainError('INCIDENT_NOT_FOUND', 'incident not found');

    let run:RootCauseRunSummary|undefined;
    if(options.analysisId){
      run = this.runs.get(options.analysisId);
      if(!run) throw new DomainError('ANALYSIS_NOT_FOUND', `analysis ${options.analysisId} not found`);
      if(run.incidentId !== incidentId){
        throw new DomainError('ANALYSIS_CONTEXT_MISMATCH', `analysis ${options.analysisId} belongs to another incident`);
      }
      if(run.status === 'completed'){
        throw new DomainError('ANALYSIS_ALREADY_COMPLETED', `analysis ${options.analysisId} already completed on version ${run.version}`);
      }
      if(options.version !== undefined && options.version !== run.version){
        throw new DomainError('VERSION_CONTEXT_MISMATCH',
          `analysis ${options.analysisId} is pinned to version ${run.version}, cannot retry with ${options.version}`);
      }
    }

    // —— 分析开始：同步捕获且仅此一次捕获完整拓扑快照 ——
    const snapshot = this.topology.captureSnapshot(
      run ? { version:run.version } : (options.version !== undefined ? { version:options.version } : { at:incident.detectedAt }),
    );

    const analysisId = run?.analysisId ?? newId('rca');
    const startedAt = snapshot.capturedAt;
    if(!run){
      run = {
        analysisId, incidentId, attempts:0, status:'failed',
        version:snapshot.version.version, snapshotId:snapshot.snapshotId, startedAt,
      };
      this.runs.set(analysisId, run);
      this.audit?.record('root-cause.start', analysisId, {
        incidentId,
        version:snapshot.version.version,
        snapshotId:snapshot.snapshotId,
        effectiveAt:snapshot.version.effectiveAt,
        mode:options.version !== undefined ? 'pinned' : 'effective-at',
      });
    }
    run.attempts += 1;
    const attempt = run.attempts;

    try {
      await options.beforeTraversal?.({snapshot, attempt});

      // 让发布与分析真正交错：快照已固定，此处让出事件循环期间发布新版本。
      await Promise.resolve();

      const seeds = [...new Set(incident.assetIds)].sort();
      for(const seed of seeds){
        if(!snapshot.hasNode(seed)){
          throw new DomainError('SEED_NOT_IN_SNAPSHOT',
            `seed asset ${seed} does not exist in topology version ${snapshot.version.version} (snapshot ${snapshot.snapshotId})`);
        }
      }

      const paths:RootCausePath[] = [];
      for(const seed of seeds){
        paths.push(...this.traverseUpstream(snapshot, seed, incident.assetIds));
      }

      const result = this.buildResult(analysisId, incidentId, snapshot, seeds, paths, attempt, run);

      run.status = 'completed';
      run.finishedAt = Date.now();
      this.audit?.record('root-cause.complete', analysisId, {
        incidentId,
        version:snapshot.version.version,
        snapshotId:snapshot.snapshotId,
        attempts:attempt,
        pathCount:paths.length,
        fingerprint:result.fingerprint,
      });
      return result;
    } catch(err){
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof DomainError ? err.code : 'ANALYSIS_FAILED';
      run.finishedAt = Date.now();
      this.audit?.record('root-cause.failed', analysisId, {
        incidentId,
        version:snapshot.version.version,
        snapshotId:snapshot.snapshotId,
        attempt,
        code,
        message,
      });
      throw err;
    }
  }

  getRun(analysisId:string):RootCauseRunSummary{
    const run = this.runs.get(analysisId);
    if(!run) throw new DomainError('ANALYSIS_NOT_FOUND', `analysis ${analysisId} not found`);
    return run;
  }

  /**
   * 沿"入边"做有界上游遍历。输入只来自 snapshot：
   * 每一跳的边、节点、traceId 均解析自同一个版本，结构上不可能混入别的版本。
   */
  private traverseUpstream(snapshot:TopologySnapshot, seedId:string, seedScope:string[]):RootCausePath[]{
    const paths:RootCausePath[] = [];
    type Frame = { node:string; hops:RootCauseHop[]; total:number };
    const stack:Frame[] = [{node:seedId, hops:[], total:0}];
    const visited = new Set<string>([`${seedId}:`]);

    while(stack.length){
      const frame = stack.pop()!;
      const incoming = snapshot.incoming(frame.node);
      const terminal = frame.hops.length > 0;
      if(terminal){
        paths.push({
          pathId:`path_v${snapshot.version.version}_${frame.hops.map(h=>h.edgeId).join('|')}`,
          seedAssetId:seedId,
          rootAssetId:frame.node,
          hops:frame.hops,
          totalWeight:frame.total,
          depth:frame.hops.length,
        });
      }
      if(frame.hops.length >= MAX_TRAVERSAL_DEPTH || incoming.length === 0) continue;

      const ordered = [...incoming].sort((a,b)=>b.weight-a.weight || a.from.localeCompare(b.from));
      for(const edge of ordered){
        if(edge.from === seedId && frame.hops.length === 0) continue;
        const hop:RootCauseHop = {
          edgeId:edge.id,
          from:edge.from,
          to:edge.to,
          weight:edge.weight,
          hop:frame.hops.length + 1,
          traceId:snapshot.traceId(edge, frame.hops.length + 1, seedId),
        };
        const key = `${edge.from}:${frame.hops.map(h=>h.edgeId).join(',')}`;
        if(visited.has(key)) continue;
        visited.add(key);
        stack.push({node:edge.from, hops:[...frame.hops, hop], total:frame.total + edge.weight});
      }
    }
    // 确定性顺序：按权重降序、深度、根节点 id
    paths.sort((a,b)=>b.totalWeight-a.totalWeight || a.depth-b.depth || a.rootAssetId.localeCompare(b.rootAssetId) || a.seedAssetId.localeCompare(b.seedAssetId));
    return paths;
  }

  private buildResult(
    analysisId:string,
    incidentId:string,
    snapshot:TopologySnapshot,
    seeds:string[],
    paths:RootCausePath[],
    attempt:number,
    run:RootCauseRunSummary,
  ){
    const byRoot = new Map<string,{max:number;count:number}>();
    for(const p of paths){
      const agg = byRoot.get(p.rootAssetId) ?? {max:0,count:0};
      agg.max = Math.max(agg.max,p.totalWeight);
      agg.count += 1;
      byRoot.set(p.rootAssetId,agg);
    }
    const candidates:RootCauseCandidate[] = [...byRoot.entries()]
      .map(([assetId,agg])=>({assetId,maxWeight:agg.max,pathCount:agg.count,reason:'topology dependency'}))
      .sort((a,b)=>b.maxWeight-a.maxWeight || a.assetId.localeCompare(b.assetId));

    const confidence = Math.min(0.99, 0.55 + paths.length * 0.05);
    const version = snapshot.version.version;

    // 结果自带完整版本结构：节点/边与版本标识一一对应。
    const nodes = seeds.flatMap(seed => collectPathNodes(snapshot, seed, paths));
    const uniqueNodes = [...new Map(nodes.map(n=>[n.id,n])).values()].sort((a,b)=>a.id.localeCompare(b.id));
    const edgeIds = new Set<string>();
    for(const p of paths) for(const h of p.hops) edgeIds.add(h.edgeId);
    const edges = [...edgeIds].map(id=>snapshot.edgeById.get(id)!).sort((a,b)=>a.id.localeCompare(b.id));

    const payload = {
      incidentId,
      seedAssetIds:seeds,
      version,
      effectiveAt:snapshot.version.effectiveAt,
      snapshotId:snapshot.snapshotId,
      candidates,
      paths,
      nodes:uniqueNodes,
      edges,
      confidence,
    };
    const fingerprint = fingerprintResult(payload);

    return {
      analysisId,
      attempt,
      attempts:attempt,
      ...payload,
      fingerprint,
      audit:{
        startAction:'root-cause.start',
        completeAction:'root-cause.complete',
        entityId:analysisId,
        version,
        snapshotId:snapshot.snapshotId,
      },
    };
  }
}

function collectPathNodes(snapshot:TopologySnapshot, seed:string, paths:RootCausePath[]){
  const ids = new Set<string>([seed]);
  for(const p of paths.filter(p=>p.seedAssetId===seed)){
    for(const hop of p.hops){ ids.add(hop.from); ids.add(hop.to); }
  }
  return [...ids].map(id=>snapshot.node(id));
}

/** 结果指纹：只对版本相关的确定性内容取哈希，使相同输入的重复分析得到相同指纹。 */
function fingerprintResult(payload:{
  incidentId:string; seedAssetIds:string[]; version:number; effectiveAt:number; snapshotId:string;
  candidates:RootCauseCandidate[]; paths:RootCausePath[]; confidence:number;
}):string{
  const canonical = JSON.stringify({
    incidentId:payload.incidentId,
    seeds:payload.seedAssetIds,
    version:payload.version,
    snapshotId:payload.snapshotId,
    confidence:payload.confidence,
    candidates:payload.candidates,
    paths:payload.paths.map(p=>[p.pathId,p.seedAssetId,p.rootAssetId,p.hops.map(h=>[h.edgeId,h.traceId]),p.totalWeight,p.depth]),
  });
  let hash = 0x811c9dc5;
  for(let i=0;i<canonical.length;i++){ hash ^= canonical.charCodeAt(i); hash = Math.imul(hash,0x01000193); }
  return `rca_v${payload.version}_${(hash>>>0).toString(16).padStart(8,'0')}`;
}
