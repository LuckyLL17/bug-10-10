import { FastifyInstance } from 'fastify';
import { TwinStore } from '../domain/store';
import { Asset } from '../domain/types';
import { TelemetryService } from '../services/telemetry-service';
import { AnomalyService } from '../services/anomaly-service';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';
import { WorkflowService } from '../services/workflow-service';
import { AuditService } from '../services/audit-service';
import { DomainError } from '../core/errors';

export function registerRoutes(app:FastifyInstance,store:TwinStore){
  const audit = new AuditService();
  const telemetry = new TelemetryService(store);
  const anomalies = new AnomalyService(store);
  const topology = new TopologyService(store, audit);
  const causes = new RootCauseService(store, topology, audit);
  const workflows = new WorkflowService(store);

  const fail = (res:any, e:any, fallbackCode=400) => {
    if(e instanceof DomainError) return res.code(fallbackCode).send({code:e.code,message:e.message});
    return res.code(500).send({code:'INTERNAL',message:e?.message ?? String(e)});
  };

  app.get('/health',async()=>({ok:true}));

  app.post('/assets',async(req,res)=>{
    try{
      const b = req.body as Asset;
      const asset:Asset = {id:b.id,name:b.name,kind:b.kind,status:b.status ?? 'healthy',criticality:b.criticality ?? 1,tags:[...(b.tags ?? [])]};
      store.assets.set(asset.id, asset);
      audit.record('asset.register', asset.id, {kind:asset.kind});
      return asset;
    }catch(e:any){ return fail(res,e); }
  });

  app.post('/topology',async(req,res)=>{
    try{ return await topology.publish(req.body as any) }catch(e:any){ return fail(res,e); }
  });
  app.get('/topology/versions',async()=>topology.listVersions());
  app.get('/topology/versions/:version',async(req,res)=>{
    try{
      const v = Number((req.params as any).version);
      return topology.getVersion(v);
    }catch(e:any){ return res.code(404).send({code:e.code,message:e.message}); }
  });

  app.post('/telemetry',async(req)=>{const e=telemetry.ingest(req.body as any);audit.record('telemetry.ingest',e.id,{assetId:e.assetId});return e});
  app.get('/telemetry/replay',async(req)=>{const q=req.query as any;return telemetry.replay(Number(q.from),Number(q.to))});
  app.post('/anomalies/detect',async(req,res)=>{try{return anomalies.detect((req.body as any).assetId,(req.body as any).metric,Number((req.body as any).threshold))}catch(e:any){return fail(res,e)}});

  app.get('/incidents/:id/root-cause',async(req,res)=>{
    try{
      const q = req.query as any;
      const options:any = {};
      if(q.version !== undefined) options.version = Number(q.version);
      if(q.analysisId) options.analysisId = q.analysisId;
      return await causes.analyze((req.params as any).id, options);
    }catch(e:any){
      if(e instanceof DomainError){
        const status = ['INCIDENT_NOT_FOUND','ANALYSIS_NOT_FOUND'].includes(e.code) ? 404 : 409;
        return res.code(status).send({code:e.code,message:e.message,version:(e as any).version});
      }
      return res.code(500).send({code:'INTERNAL',message:e?.message});
    }
  });
  app.get('/root-cause/:analysisId',async(req,res)=>{
    try{ return causes.getRun((req.params as any).analysisId) }
    catch(e:any){ return res.code(404).send({code:e.code,message:e.message}); }
  });

  app.post('/work-orders',async(req,res)=>{
    try{return workflows.create((req.body as any).incidentId,(req.body as any).steps||[])}catch(e:any){return fail(res,e)}
  });
  app.post('/work-orders/:id/transition',async(req,res)=>{
    try{return workflows.transition((req.params as any).id,(req.body as any).state)}catch(e:any){return fail(res,e)}
  });

  app.get('/audit',async(req)=>audit.list((req.query as any).entityId));
}
