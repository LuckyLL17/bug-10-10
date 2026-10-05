import { DomainError } from '../core/errors';
import { deepFreeze, Mutex } from '../core/freeze';
import { Clock, SystemClock } from '../core/clock';
import { TwinStore } from '../domain/store';
import { TopologySnapshot } from '../domain/snapshot';
import { Asset, TopologyEdge, TopologyNode, TopologyPublishInput, TopologyVersion } from '../domain/types';
import { AuditService } from './audit-service';

export interface SnapshotRequest {
  /** 显式钉住版本号（历史回看/失败重试使用），优先于 at。 */
  version?:number;
  /** 按业务时间选择当时生效的最新版本（全新分析使用）。 */
  at?:number;
}

export class TopologyService {
  private publishLock = new Mutex();
  private clock:Clock;

  constructor(
    private store:TwinStore,
    private audit?:AuditService,
    clock?:Clock,
  ){ this.clock = clock ?? new SystemClock(); }

  /**
   * 发布新版本：版本号严格连续；节点/边构成一个自包含的完整版本。
   * 发布按值深拷贝并冻结，之后调用方再改请求对象不会影响历史。
   * 整个发布在互斥区内完成，发布之间、发布与快照捕获不会交错出半完成状态。
   */
  async publish(input:TopologyPublishInput):Promise<TopologyVersion>{
    return this.publishLock.run(()=>this.doPublish(input));
  }

  private doPublish(input:TopologyPublishInput):TopologyVersion {
    const expected = this.store.topology.length + 1;
    if(input.version !== expected){
      throw new DomainError('VERSION_GAP', `topology version must be sequential, expected ${expected}, got ${input.version}`);
    }
    if(!Number.isFinite(input.effectiveAt)){
      throw new DomainError('INVALID_EFFECTIVE_AT', 'effectiveAt must be a finite number');
    }

    const nodes = this.resolveNodes(input);
    const nodeIds = new Set(nodes.map(n=>n.id));

    const seenEdges = new Set<string>();
    const edges:TopologyEdge[] = input.edges.map((raw,index)=>{
      if(!Number.isFinite(raw.weight)) throw new DomainError('INVALID_EDGE', `edge[${index}] weight must be finite`);
      if(!nodeIds.has(raw.from) || !nodeIds.has(raw.to)){
        throw new DomainError('DANGLING_EDGE', `edge[${index}] ${raw.from}->${raw.to} references unknown node`);
      }
      const key = `${raw.from}->${raw.to}`;
      if(seenEdges.has(key)) throw new DomainError('DUPLICATE_EDGE', `duplicate edge ${key} in version ${input.version}`);
      seenEdges.add(key);
      return { id:`edge_v${input.version}_${raw.from}__${raw.to}`, from:raw.from, to:raw.to, weight:raw.weight };
    });

    const version = deepFreeze(structuredClone({
      version:input.version,
      effectiveAt:input.effectiveAt,
      nodes,
      edges,
    })) as Readonly<TopologyVersion> as TopologyVersion;

    this.store.topology.push(version);
    this.audit?.record('topology.publish', `topology-v${version.version}`, {
      version:version.version,
      effectiveAt:version.effectiveAt,
      nodeCount:version.nodes.length,
      edgeCount:version.edges.length,
      snapshotId:TopologySnapshot.fingerprint(version),
    });
    return version;
  }

  private resolveNodes(input:TopologyPublishInput):TopologyNode[]{
    // 未显式声明节点时，以边端点为完整节点集合（端点必须是已注册设备）。
    const declaredIds = new Set<string>();
    const declared = new Map<string,TopologyNode>();
    for(const entry of input.nodes ?? []){
      const node = typeof entry === 'string' ? this.assetToNode(entry) : this.normalizeNode(entry);
      if(declared.has(node.id)) throw new DomainError('DUPLICATE_NODE', `duplicate node ${node.id} in version ${input.version}`);
      declared.set(node.id,node);
      declaredIds.add(node.id);
    }
    const fromEdges = new Set<string>();
    for(const e of input.edges){ fromEdges.add(e.from); fromEdges.add(e.to); }

    const all = new Map<string,TopologyNode>(declared);
    for(const id of fromEdges){
      if(!all.has(id)) all.set(id, this.assetToNode(id));
    }
    return [...all.values()].sort((a,b)=>a.id.localeCompare(b.id));
  }

  private assetToNode(id:string):TopologyNode{
    const asset:Asset|undefined = this.store.assets.get(id);
    if(!asset) throw new DomainError('UNKNOWN_NODE', `node ${id} is not a registered asset and was not declared`);
    return this.normalizeNode(asset);
  }

  private normalizeNode(a:Asset|TopologyNode):TopologyNode{
    return { id:a.id, name:a.name, kind:a.kind, status:a.status, criticality:a.criticality, tags:[...a.tags] };
  }

  /** 同步取版本：显式版本号优先，否则按生效时间选择。 */
  private resolveVersion(req:SnapshotRequest):Readonly<TopologyVersion>{
    if(req.version !== undefined){
      const v = this.store.topology[req.version-1];
      if(!v) throw new DomainError('UNKNOWN_TOPOLOGY_VERSION', `topology version ${req.version} does not exist`);
      return v;
    }
    if(req.at === undefined) throw new DomainError('NO_VERSION_SELECTOR', 'specify either version or effective time');
    let chosen:Readonly<TopologyVersion>|undefined;
    for(const v of this.store.topology){
      if(v.effectiveAt <= req.at && (!chosen || v.version > chosen.version)) chosen = v;
    }
    if(!chosen) throw new DomainError('NO_TOPOLOGY', `no effective topology at ${req.at}`);
    return chosen;
  }

  /**
   * 捕获快照。必须在一次分析的最开始、任何 await 之前同步调用：
   * 一旦返回，分析绑定的节点/边/版本标识就永久固定，
   * 期间无论发布多少新版本（即便回溯生效）都与本次分析无关。
   */
  captureSnapshot(req:SnapshotRequest):TopologySnapshot{
    // resolveVersion 与 capture 均为纯同步操作：事件循环中不会与
    // doPublish 的同步落库交错；已发布版本又被冻结，故快照一旦捕获即固定。
    const version = this.resolveVersion(req);
    return TopologySnapshot.capture(version, this.clock.now());
  }

  listVersions():readonly Readonly<TopologyVersion>[] { return [...this.store.topology]; }
  getVersion(version:number):Readonly<TopologyVersion>{
    const v = this.store.topology[version-1];
    if(!v) throw new DomainError('UNKNOWN_TOPOLOGY_VERSION', `topology version ${version} does not exist`);
    return v;
  }
}
