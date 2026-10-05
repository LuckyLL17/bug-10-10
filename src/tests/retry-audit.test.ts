import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addIncident, assertResultCoherent, expectError, makeHarness, publishDivergentVersions, registerAssets, topo } from './helpers';
import { DomainError } from '../core/errors';

// ---------------------------------------------------------------------------
// 场景 4：失败重试必须继续使用明确的版本上下文
// ---------------------------------------------------------------------------
test('failed analysis retries keep the pinned version and full audit chain', async()=>{
  const h = makeHarness();
  await publishDivergentVersions(h, 1000);
  addIncident(h.store, 'inc-a', ['sensor-a'], 5000);

  // 第一次：显式钉在 v1，遍历前钩子令首次尝试失败（故障发生在快照捕获之后）
  let hookAttempt = 0;
  await assert.rejects(
    h.causes.analyze('inc-a', {
      version:1,
      beforeTraversal:({attempt})=>{
        hookAttempt = attempt;
        throw new DomainError('TRANSIENT_FAULT', 'simulated traversal crash');
      },
    }),
    expectError('TRANSIENT_FAULT'),
  );
  assert.equal(hookAttempt, 1);
  // 失败时结果未返回，analysisId 通过审计链回溯（审计绑定的用途之一）
  const firstAnalysisId = h.audit.list().filter(e=>e.action==='root-cause.start').at(-1)!.entityId;
  assert.ok(firstAnalysisId);

  // 失败记录绑定版本上下文
  const failedRun = h.causes.getRun(firstAnalysisId!);
  assert.deepEqual({status:failedRun.status, version:failedRun.version, attempts:failedRun.attempts},
    {status:'failed', version:1, attempts:1});
  const failAudit = h.audit.list(firstAnalysisId!);
  assert.deepEqual(failAudit.map(e=>e.action), ['root-cause.start','root-cause.failed']);
  assert.equal(failAudit[1].metadata.version, 1);
  assert.equal(failAudit[1].metadata.code, 'TRANSIENT_FAULT');

  // 不带 analysisId 的"裸重试"且未指定版本时，按业务时间会解析到当前版本 v2 ——
  // 因此重试必须显式带版本：用相同 v1 + analysisId 重试，上下文被恢复
  const retried = await h.causes.analyze('inc-a', {version:1, analysisId:firstAnalysisId});
  assert.equal(retried.analysisId, firstAnalysisId);
  assert.equal(retried.attempt, 2, '尝试序号追加到同一条分析');
  assert.equal(retried.version, 1);
  assertResultCoherent(retried, 1, h);

  // 审计链完整：start -> failed -> complete，且版本/snapshotId 全程一致
  const chain = h.audit.list(firstAnalysisId!).map(e=>e.action);
  assert.deepEqual(chain, ['root-cause.start','root-cause.failed','root-cause.complete']);
  const versions = new Set(h.audit.list(firstAnalysisId!).map(e=>e.metadata.version));
  assert.deepEqual([...versions], [1]);
  const snapshots = new Set(h.audit.list(firstAnalysisId!).map(e=>e.metadata.snapshotId));
  assert.equal(snapshots.size, 1);

  const completedRun = h.causes.getRun(firstAnalysisId!);
  assert.equal(completedRun.status, 'completed');
  assert.equal(completedRun.attempts, 2);
  assert.equal(completedRun.snapshotId, retried.snapshotId);

  // 已完成的分析不允许再次重试
  await assert.rejects(
    h.causes.analyze('inc-a', {version:1, analysisId:firstAnalysisId}),
    expectError('ANALYSIS_ALREADY_COMPLETED'),
  );
});

test('retry cannot silently switch version context', async()=>{
  const h = makeHarness();
  await publishDivergentVersions(h, 1000);
  addIncident(h.store, 'inc-a', ['sensor-a'], 5000);

  // v1 分析失败
  let id = '';
  await assert.rejects(h.causes.analyze('inc-a',{version:1,beforeTraversal:()=>{throw new DomainError('TRANSIENT_FAULT','boom')}}));
  // 从返回错误中拿不到 id 时，用最近一条 start 审计恢复（这也是审计回溯的用途）
  id = h.audit.list().filter(e=>e.action==='root-cause.start').at(-1)!.entityId;

  // 重试时错传 v2：必须被版本上下文冲突拒绝，而不是用 v2 产出"看似成功"的结果
  await assert.rejects(
    h.causes.analyze('inc-a', {version:2, analysisId:id}),
    expectError('VERSION_CONTEXT_MISMATCH'),
  );

  // 仍可用正确版本恢复
  const ok = await h.causes.analyze('inc-a', {version:1, analysisId:id});
  assert.equal(ok.version, 1);
  assert.equal(ok.attempt, 2);
});

test('seed absent from pinned snapshot fails explicitly and is retryable on another version', async()=>{
  const h = makeHarness();
  await publishDivergentVersions(h, 1000);
  // 另注册一个只存在于独立 v3 版本里的设备
  registerAssets(h.store, [['lonely','sensor']]);
  await h.topology.publish(topo(3, 2000, [['pump-a','lonely',0.5]]));

  // incident 的种子集合横跨两个互不相交的版本：sensor-a 只在 v1/v2 节点集，lonely 只在 v3
  addIncident(h.store, 'inc-multi', ['sensor-a','lonely'], 5000);

  // 钉在 v1：lonely 不在 v1 快照内 -> 失败，错误携带明确版本上下文
  let id = '';
  await assert.rejects(
    h.causes.analyze('inc-multi',{version:1})
      .catch(e=>{ const start=h.audit.list().filter(x=>x.action==='root-cause.start').at(-1)!; id=start.entityId; throw e; }),
    expectError('SEED_NOT_IN_SNAPSHOT'),
  );
  assert.ok(id);
  assert.equal(h.causes.getRun(id).version, 1);

  // 不能在同一条分析上换版本重试（上下文保护）
  await assert.rejects(
    h.causes.analyze('inc-multi',{version:2,analysisId:id}),
    expectError('VERSION_CONTEXT_MISMATCH'),
  );
  // 但可以用新的明确版本上下文重新分析 v2 —— sensor-a 不在 v2，同样失败，
  // 证明失败与重试都严格围绕显式版本，而非"碰当前版本"
  await assert.rejects(
    h.causes.analyze('inc-multi',{version:2}),
    expectError('SEED_NOT_IN_SNAPSHOT'),
  );
});

test('publish interleaving between failed attempts cannot change the retried snapshot', async()=>{
  const h = makeHarness();
  registerAssets(h.store, [
    ['s1','sensor'],['p1','pump'],['p2','pump'],
  ]);
  await h.topology.publish(topo(1, 1000, [['p1','s1',0.9]]));
  addIncident(h.store, 'inc', ['s1'], 2000);

  let id = '';
  const firstAttempt = h.causes.analyze('inc',{
    version:1,
    beforeTraversal:async()=>{
      const start=h.audit.list().filter(x=>x.action==='root-cause.start').at(-1)!; id=start.entityId;
      // 在"已捕获快照、遍历未完成"的窗口内发布一个当前生效的新版本
      await h.topology.publish(topo(2, 500, [['p2','s1',0.3]]));
      // 然后让本次尝试失败
      throw new DomainError('TRANSIENT_FAULT','crash after new version published');
    },
  });
  await assert.rejects(firstAttempt, expectError('TRANSIENT_FAULT'));

  // 重试：尽管当前版本已是 v2，同一分析 id 的重试仍锁定 v1
  const retried = await h.causes.analyze('inc',{version:1,analysisId:id});
  assert.equal(retried.version, 1);
  assert.equal(retried.snapshotId, h.topology.captureSnapshot({version:1}).snapshotId);
  assert.deepEqual(retried.candidates.map(c=>c.assetId), ['p1']);
  assertResultCoherent(retried, 1, h);
});
