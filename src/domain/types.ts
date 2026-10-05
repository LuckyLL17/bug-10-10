export type AssetKind = 'pump' | 'valve' | 'sensor' | 'reactor';
export type AssetStatus = 'healthy' | 'degraded' | 'failed';
export type EventType = 'telemetry' | 'alarm' | 'command' | 'ack';
export interface Asset { id:string; name:string; kind:AssetKind; status:AssetStatus; criticality:number; tags:string[] }
export interface Telemetry { assetId:string; metric:string; value:number; unit:string; observedAt:number; quality:'good'|'suspect'|'bad' }
export interface DomainEvent { id:string; type:EventType; assetId:string; timestamp:number; sequence:number; payload:Record<string, unknown> }
export interface Incident { id:string; severity:'low'|'medium'|'high'|'critical'; status:'open'|'investigating'|'contained'|'resolved'; assetIds:string[]; detectedAt:number; evidence:string[] }

/**
 * 拓扑版本：节点集合 + 边集合 + 连续版本号 + 生效时间。
 * 一个版本是一个自包含、不可变的完整设备结构：节点和边属于同一个版本，
 * 永远不允许把版本 A 的节点和版本 B 的边拼进同一条分析路径。
 */
export interface TopologyNode { id:string; name:string; kind:AssetKind; status:AssetStatus; criticality:number; tags:string[] }
export interface TopologyEdge { id:string; from:string; to:string; weight:number }
export interface TopologyVersion {
  version:number;
  effectiveAt:number;
  nodes:TopologyNode[];
  edges:TopologyEdge[];
}
/** 发布请求里的边不需要带 id，服务端按 (version,from,to) 生成确定性边标识。 */
export type TopologyPublishInput = {
  version:number;
  effectiveAt:number;
  nodes?:Array<string | TopologyNode>;
  edges:Array<{from:string;to:string;weight:number}>;
};

export interface WorkOrder { id:string; incidentId:string; state:'draft'|'approved'|'executing'|'completed'|'cancelled'; steps:string[]; compensationRequired:boolean }
