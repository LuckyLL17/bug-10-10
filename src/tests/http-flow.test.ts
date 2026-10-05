import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app';
import { FastifyInstance } from 'fastify';

test('HTTP flow: concurrent publish/analyze keeps pinned snapshots and coherent audit', async()=>{
  const app:FastifyInstance = buildApp();
  after(async()=>{ await app.close(); });

  for(const [id,kind] of [['s1','sensor'],['p1','pump'],['v1','valve'],['s2','sensor'],['p2','pump']] as const){
    const res = await app.inject({method:'POST',url:'/assets',payload:{id,kind,name:id,status:'healthy',criticality:1,tags:[]}});
    assert.equal(res.statusCode, 200);
  }

  const pub1 = await app.inject({method:'POST',url:'/topology',payload:{
    version:1, effectiveAt:1000,
    edges:[{from:'p1',to:'s1',weight:0.9},{from:'v1',to:'p1',weight:0.8}],
  }});
  assert.equal(pub1.statusCode, 200, pub1.body);

  // 通过遥测 + 检测生成 incident（detectedAt 将来自遥测 observedAt）
  await app.inject({method:'POST',url:'/telemetry',payload:{assetId:'s1',metric:'temp',value:99,unit:'C',observedAt:3000,quality:'good'}});
  const detected = await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'s1',metric:'temp',threshold:50}});
  assert.equal(detected.statusCode, 200, detected.body);
  const incident = detected.json();

  // 钉住 v1 的分析，与发布 v2（回溯生效）并发
  const pinned = app.inject({method:'GET',url:`/incidents/${incident.id}/root-cause?version=1`});
  await Promise.resolve(); await Promise.resolve();
  const pub2 = await app.inject({method:'POST',url:'/topology',payload:{
    version:2, effectiveAt:500,
    edges:[{from:'p2',to:'s2',weight:0.2},{from:'p2',to:'s1',weight:0.1}],
  }});
  assert.equal(pub2.statusCode, 200, pub2.body);

  const pinnedRes = (await pinned).json();
  assert.equal(pinnedRes.version, 1);
  assert.deepEqual(pinnedRes.nodes.map((n:any)=>n.id).sort(), ['p1','s1','v1']);
  for(const h of pinnedRes.paths.flatMap((p:any)=>p.hops)){
    assert.match(h.edgeId, /^edge_v1_/);
    assert.match(h.traceId, /^trace_v1_/);
  }

  // 不带版本的新分析按业务时间(3000)解析，此时当前版本为 v2
  const fresh = (await app.inject({method:'GET',url:`/incidents/${incident.id}/root-cause`})).json();
  assert.equal(fresh.version, 2);
  assert.ok(fresh.nodes.some((n:any)=>n.id==='p2'));

  // 历史版本回看端点
  const v1Lookup = (await app.inject({method:'GET',url:'/topology/versions/1'})).json();
  assert.equal(v1Lookup.version, 1);
  assert.equal(v1Lookup.edges.length, 2);

  // 失败重试走 HTTP：v1 快照旧有效（本次没有失败，改为校验 run 查询与审计）
  const run = (await app.inject({method:'GET',url:`/root-cause/${pinnedRes.analysisId}`})).json();
  assert.deepEqual({status:run.status,version:run.version,attempts:run.attempts},{status:'completed',version:1,attempts:1});

  const audit = (await app.inject({method:'GET',url:`/audit?entityId=${pinnedRes.analysisId}`})).json();
  assert.deepEqual(audit.map((e:any)=>e.action), ['root-cause.start','root-cause.complete']);
  assert.equal(audit[0].metadata.snapshotId, pinnedRes.snapshotId);
  assert.equal(audit[1].metadata.fingerprint, pinnedRes.fingerprint);

  // 版本号必须连续
  const bad = await app.inject({method:'POST',url:'/topology',payload:{version:5,effectiveAt:9000,edges:[]}});
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'VERSION_GAP');
});
