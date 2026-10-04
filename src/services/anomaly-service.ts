import { newId } from '../core/id'; import { TwinStore } from '../domain/store'; import { Incident } from '../domain/types';
export class AnomalyService {
 constructor(private store:TwinStore){}
 detect(assetId:string,metric:string,threshold:number){ const samples=this.store.telemetry.filter(t=>t.assetId===assetId&&t.metric===metric).sort((a,b)=>a.observedAt-b.observedAt); const abnormal=samples.filter(s=>s.quality!=='bad'&&Math.abs(s.value)>=threshold); if(!abnormal.length)return null; const incident:Incident={id:newId('inc'),severity:abnormal.some(s=>Math.abs(s.value)>=threshold*2)?'critical':'high',status:'open',assetIds:[assetId],detectedAt:abnormal[abnormal.length-1].observedAt,evidence:abnormal.map(s=>`${s.metric}=${s.value}${s.unit}@${s.observedAt}`)}; this.store.incidents.set(incident.id,incident); return incident; }
}
