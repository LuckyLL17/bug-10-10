import { TopologyEdge, TopologyNode, TopologyVersion } from './types';

/**
 * TopologySnapshot 是一次分析在"开始时刻"捕获的拓扑视图。
 *
 * 关键不变量（修复节点旧版本/边新版本竞态的核心）：
 * 1. snapshot 持有一个且仅一个已发布 TopologyVersion 的值引用（该版本已 deepFreeze），
 *    后续发布只向 store 追加新版本，不可能改写 snapshot 内部；
 * 2. 根因遍历期间只允许访问 snapshot 上的 nodes/edges，禁止再回查 store；
 * 3. snapshotId 对 (version, effectiveAt, 节点集合, 边集合) 做确定性哈希：
 *    相同输入的重复分析得到相同 snapshotId，结果可解释、可比对、可追溯；
 * 4. 每条边有版本范围内的确定性 id，路径上的 traceId 同样确定性生成，
 *    不再使用每次随机的 UUID。
 */
export class TopologySnapshot {
  readonly snapshotId:string;
  readonly capturedAt:number;
  readonly nodeById:ReadonlyMap<string,TopologyNode>;
  readonly edgeById:ReadonlyMap<string,TopologyEdge>;
  readonly incomingByNode:ReadonlyMap<string,readonly TopologyEdge[]>;
  readonly outgoingByNode:ReadonlyMap<string,readonly TopologyEdge[]>;

  private constructor(
    readonly version:Readonly<TopologyVersion>,
    now:number,
  ){
    this.snapshotId = TopologySnapshot.fingerprint(version);
    this.capturedAt = now;
    this.nodeById = new Map(version.nodes.map(n=>[n.id,n]));
    this.edgeById = new Map(version.edges.map(e=>[e.id,e]));
    const incoming = new Map<string,TopologyEdge[]>();
    const outgoing = new Map<string,TopologyEdge[]>();
    for(const edge of version.edges){
      (incoming.get(edge.to) ?? incoming.set(edge.to,[]).get(edge.to))!.push(edge);
      (outgoing.get(edge.from) ?? outgoing.set(edge.from,[]).get(edge.from))!.push(edge);
    }
    this.incomingByNode = incoming;
    this.outgoingByNode = outgoing;
  }

  /** 从一个已发布（已冻结）版本捕获快照。捕获本身只做同步读取，不跨 await。 */
  static capture(version:Readonly<TopologyVersion>, now:number):TopologySnapshot{
    return new TopologySnapshot(version, now);
  }

  hasNode(id:string):boolean{ return this.nodeById.has(id); }
  node(id:string):TopologyNode{
    const node = this.nodeById.get(id);
    if(!node) throw new Error(`snapshot v${this.version.version} does not contain node ${id}`);
    return node;
  }
  incoming(id:string):readonly TopologyEdge[]{ return this.incomingByNode.get(id) ?? EMPTY; }
  outgoing(id:string):readonly TopologyEdge[]{ return this.outgoingByNode.get(id) ?? EMPTY; }

  /** 路径中每一跳的确定性追踪标识：绑定版本、边、所在路径深度。 */
  traceId(edge:TopologyEdge, hop:number, seedId:string):string{
    return `trace_v${this.version.version}_${edge.id}_hop${hop}_seed${seedId}`;
  }

  toJSON(){
    return {
      snapshotId:this.snapshotId,
      version:this.version.version,
      effectiveAt:this.version.effectiveAt,
      capturedAt:this.capturedAt,
      nodeCount:this.version.nodes.length,
      edgeCount:this.version.edges.length,
    };
  }

  /** 对版本完整内容（节点+边+版本标识）做 FNV-1a 哈希。 */
  static fingerprint(v:Readonly<TopologyVersion>):string{
    const canonical = JSON.stringify({
      version:v.version,
      effectiveAt:v.effectiveAt,
      nodes:v.nodes.map(n=>[n.id,n.name,n.kind,n.status,n.criticality,[...n.tags].sort()]),
      edges:v.edges.map(e=>[e.from,e.to,e.weight]),
    });
    let hash = 0x811c9dc5;
    for(let i=0;i<canonical.length;i++){
      hash ^= canonical.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `snap_v${v.version}_${(hash>>>0).toString(16).padStart(8,'0')}`;
  }
}
const EMPTY:readonly TopologyEdge[] = Object.freeze([]);
