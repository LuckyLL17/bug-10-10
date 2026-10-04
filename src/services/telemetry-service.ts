import { newId } from '../core/id'; import { TwinStore } from '../domain/store'; import { DomainEvent, Telemetry } from '../domain/types';
export class TelemetryService {
 constructor(private store:TwinStore){}
 ingest(input:Telemetry){ this.store.telemetry.push({...input}); const event:DomainEvent={id:newId('evt'),type:'telemetry',assetId:input.assetId,timestamp:input.observedAt,sequence:this.store.events.length+1,payload:{metric:input.metric,value:input.value,quality:input.quality}}; this.store.events.push(event); return event; }
 history(assetId:string,metric?:string){return this.store.telemetry.filter(t=>t.assetId===assetId&&(!metric||t.metric===metric)).sort((a,b)=>a.observedAt-b.observedAt)}
 replay(from:number,to:number){return this.store.events.filter(e=>e.timestamp>=from&&e.timestamp<=to).sort((a,b)=>a.timestamp-b.timestamp||a.sequence-b.sequence)}
}
