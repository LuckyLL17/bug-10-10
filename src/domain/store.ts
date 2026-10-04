import { Asset, DomainEvent, Incident, Telemetry, TopologyVersion, WorkOrder } from './types';
export class TwinStore {
  assets = new Map<string,Asset>(); telemetry:Telemetry[]=[]; events:DomainEvent[]=[]; incidents=new Map<string,Incident>(); workOrders=new Map<string,WorkOrder>(); topology:TopologyVersion[]=[];
}
