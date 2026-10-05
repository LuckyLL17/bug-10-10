import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addIncident, assertResultCoherent, makeHarness, publishDivergentVersions, registerAssets, topo } from './helpers';

// ---------------------------------------------------------------------------
// 场景 1：并发发布与分析 —— 分析开始后捕获的快照不被发布切换改写
// ---------------------------------------------------------------------------
test('concurrent publish during analysis never mixes nodes/edges across versions', async()=>{
  const h = makeHarness();
  registerAssets(h.store, [
    ['s1','sensor'],['p1','pump'],['v1','valve'],['r1','reactor'],
    ['s2','sensor'],['p2','pump'],['v2','valve'],['r2','reactor'],
    ['s3','sensor'],['p3','pump'],['v3','valve'],['r3','reactor'],
  ]);
  // 只发布 v1；分析进行中再发布 v2/v3（effectiveAt 回溯到分析时点之前，
  // 这正是旧实现里 current() 在遍历中途读到新版本、导致混合快照的场景）。
  await h.topology.publish(topo(1, 1000, [
    ['p1','s1',0.9],['v1','p1',0.8],['r1','v1',0.7],
  ]));
  addIncident(h.store, 'inc-1', ['s1'], 2000);

  const TARGET_RUNS = 60;
  const results:any[] = [];
  const blockers:Array<()=>void> = [];
  let started = 0;

  // 确定性交错：每个分析在快照捕获后、遍历前停在 gate 上，
  // 等 60 个分析都已捕获快照后，批量放行并在放行间隙发布 v2、v3。
  let releaseAll:()=>void = ()=>{};
  const allBlocked = new Promise<void>(resolve=>{ releaseAll = resolve; });

  const analyses:Promise<any>[] = [];
  for(let i=0;i<TARGET_RUNS;i++){
    const p = h.causes.analyze('inc-1', {
      beforeTraversal:()=>{
        started += 1;
        if(started === TARGET_RUNS) releaseAll();
        return new Promise<void>(res=>{ blockers.push(res); });
      },
    }).then(r=>{ results.push(r); return r; });
    analyses.push(p);
    await Promise.resolve();
  }

  await allBlocked;
  assert.equal(started, TARGET_RUNS);

  // 此时所有分析都已捕获 v1 快照；在它们遍历前/中发布 v2、v3（回溯生效）。
  // v2/v3 与 v1 共享种子 s1，但上游节点与边完全换成 *-2/*-3 集合：
  // 旧实现每次 impact 重读 current()，中途切换就会拼出 s1(旧)+p2(新) 的混合路径。
  const publishDuringAnalysis = (async()=>{
    await h.topology.publish(topo(2, 1500, [
      ['p2','s1',0.95],['v2','p2',0.85],['r2','v2',0.75],
    ]));
    // 放一半分析去遍历
    blockers.splice(0, TARGET_RUNS/2).forEach(fn=>fn());
    await Promise.resolve(); await Promise.resolve();
    await h.topology.publish(topo(3, 500, [
      ['p3','s1',0.3],['v3','p3',0.2],['r3','v3',0.1],
    ]));
    blockers.splice(0).forEach(fn=>fn());
  })();

  await Promise.all(analyses);
  await publishDuringAnalysis;

  assert.equal(results.length, TARGET_RUNS);
  // 所有进行中的分析必须仍然完整落在 v1 上
  for(const r of results){
    assert.equal(r.version, 1, '进行中的分析被发布切换改写了版本');
    assertResultCoherent(r, 1, h);
    assert.deepEqual(r.nodes.map((n:any)=>n.id).sort(), ['p1','r1','s1','v1']);
    for(const c of r.candidates) assert.ok(['p1','v1','r1'].includes(c.assetId));
  }

  // 发布完成后新开始的分析（按 detectedAt=2000 选版本）看到最新结构
  const after = await h.causes.analyze('inc-1');
  assert.equal(after.version, 3);
  assertResultCoherent(after, 3, h);
});

// ---------------------------------------------------------------------------
// 场景 2：多轮重复运行 —— 相同输入得到可解释、可追溯且完全一致的结果
// ---------------------------------------------------------------------------
test('repeated analyses on identical input are deterministic and traceable', async()=>{
  const h = makeHarness();
  await publishDivergentVersions(h);
  addIncident(h.store, 'inc-x', ['sensor-a'], 5000);

  const rounds = await Promise.all([
    h.causes.analyze('inc-x'),
    h.causes.analyze('inc-x'),
    h.causes.analyze('inc-x',{version:1}),
    h.causes.analyze('inc-x',{version:1}),
  ]);

  const [a,b,c,d] = rounds;
  for(const r of rounds){ assertResultCoherent(r, r.version, h); }

  // 默认与钉版本各自组内完全一致（结构、指纹、traceId/pathId）
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(c.fingerprint, d.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint, 'v1 与 v2 结构不同，指纹必须不同');
  assert.deepEqual(
    JSON.parse(JSON.stringify({paths:a.paths,nodes:a.nodes,edges:a.edges,candidates:a.candidates,confidence:a.confidence})),
    JSON.parse(JSON.stringify({paths:b.paths,nodes:b.nodes,edges:b.edges,candidates:b.candidates,confidence:b.confidence})),
  );
  assert.equal(a.snapshotId, b.snapshotId);
  assert.equal(a.version, 2);
  assert.equal(c.version, 1);

  // 每次分析都有独立 analysisId 与完整审计链
  const ids = new Set(rounds.map(r=>r.analysisId));
  assert.equal(ids.size, 4);
  for(const r of rounds){
    const entries = h.audit.list(r.analysisId);
    assert.deepEqual(entries.map(e=>e.action), ['root-cause.start','root-cause.complete']);
  }
});

// ---------------------------------------------------------------------------
// 场景 3：不同节点/边集合 + 历史版本回看
// ---------------------------------------------------------------------------
test('historical version lookback pins the exact node/edge set of that version', async()=>{
  const h = makeHarness();
  await publishDivergentVersions(h, 1000);
  // v1: *-a 上游链；v2: *-b 上游链，两套版本共享种子 sensor-a
  addIncident(h.store, 'inc-a', ['sensor-a'], 5000);

  // 历史回看 v1：只能看到 *-a 结构
  const v1 = await h.causes.analyze('inc-a', {version:1});
  assert.equal(v1.version, 1);
  assertResultCoherent(v1, 1, h);
  assert.deepEqual(v1.nodes.map((n:any)=>n.id).sort(), ['pump-a','reactor-a','sensor-a','valve-a']);
  assert.ok(v1.candidates.some(c=>c.assetId==='reactor-a'));
  assert.ok(!v1.candidates.some(c=>c.assetId.endsWith('-b')));
  for(const e of v1.edges) assert.ok(e.id.startsWith('edge_v1_'));

  // v2 回看：*-b 结构
  const v2 = await h.causes.analyze('inc-a', {version:2});
  assertResultCoherent(v2, 2, h);
  assert.deepEqual(v2.nodes.map((n:any)=>n.id).sort(), ['pump-b','reactor-b','sensor-a','valve-b']);
  assert.deepEqual(v2.candidates.map((c:any)=>c.assetId).sort(), ['pump-b','reactor-b','valve-b']);
  // v2 的边绝不可能出现在 v1 结果里（即便两个版本共享同一批端点 id 也不行）
  for(const edgeOfV2 of v2.edges.map((e:any)=>e.id)){
    assert.ok(!v1.edges.some((e:any)=>e.id===edgeOfV2));
  }

  // 用不存在的版本回看必须报错而不是悄悄回退当前版本
  await assert.rejects(h.causes.analyze('inc-a',{version:99}), (e:any)=>e.code==='UNKNOWN_TOPOLOGY_VERSION');

  // 快照内容不随后续发布而改变：再发 v3 后重放 v1，指纹与路径逐字节一致
  await h.topology.publish(topo(3, 6000, [
    ['pump-a','sensor-a',0.1], // 同一批设备但权重/结构变了
  ]));
  const v1Again = await h.causes.analyze('inc-a', {version:1});
  assert.equal(v1Again.snapshotId, v1.snapshotId);
  assert.equal(v1Again.fingerprint, v1.fingerprint);
  assert.deepEqual(JSON.parse(JSON.stringify(v1Again.paths)), JSON.parse(JSON.stringify(v1.paths)));
});

test('published versions are immutable by value after publishing', async()=>{
  const h = makeHarness();
  registerAssets(h.store, [['s1','sensor'],['p1','pump']]);
  const payload = topo(1, 1000, [['p1','s1',0.9]]);
  const published = await h.topology.publish(payload);
  // 调用方事后篡改请求对象与"已发布"对象
  payload.edges[0].weight = 0.01;
  assert.throws(()=>{ (published.edges[0] as any).weight = 5; });
  const snap = h.topology.captureSnapshot({version:1});
  assert.equal(snap.version.edges[0].weight, 0.9);
  assert.ok(Object.isFrozen(snap.version.edges[0]));
});
