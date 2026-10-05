import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addIncident, makeHarness, registerAssets, topo } from './helpers';

/**
 * 回归对照：用相同的确定性交错调度，分别驱动
 *  - buggyRead：旧实现模式（遍历时每次回到 store 重新选版本）
 *  - snapshotRead：修复后模式（开始时捕获一次快照）
 * 证明旧模式在 await 交错点会被发布切换换版本，快照模式不会。
 */
test('regression contrast: re-reading current version across await mixes versions, snapshot does not', async()=>{
  const h = makeHarness();
  registerAssets(h.store, [
    ['s1','sensor'],['p1','pump'],['p2','pump'],
  ]);
  await h.topology.publish(topo(1, 1000, [['p1','s1',0.9]]));
  addIncident(h.store, 'inc', ['s1'], 2000);

  // —— 旧模式：每个节点扩展都"当场"调一次 current(at) ——
  const buggyRead = async():Promise<{selectedVersions:number[]}> => {
    const selectedVersions:number[] = [];
    const at = 2000;
    selectedVersions.push(h.topology.getVersion(effectiveVersionAt(h, at)).version);
    await new Promise<void>(res=>setImmediate(res)); // 模拟遍历中的异步交错
    selectedVersions.push(h.topology.getVersion(effectiveVersionAt(h, at)).version);
    return {selectedVersions};
  };

  // —— 新模式：开始时同步捕获一次 ——
  const snapshotRead = async()=>{
    const snapshot = h.topology.captureSnapshot({at:2000});
    const before = snapshot.version.version;
    await new Promise<void>(res=>setImmediate(res));
    const after = snapshot.version.version;
    return {before, after, snapshotId:snapshot.snapshotId};
  };

  // 让发布精确发生在两个读取之间
  const interleaver = async(reader:()=>Promise<any>)=>{
    const p = reader();
    await Promise.resolve();
    await h.topology.publish(topo(2, 500, [['p2','s1',0.1]]));
    return p;
  };

  const buggy = await interleaver(buggyRead);
  assert.deepEqual(buggy.selectedVersions, [1,2], '前置对照：旧模式必须确实出现跨版本读取（v1→v2），否则测试没有证明竞态机制');

  // 再发一个 v3，快照模式同样不受影响
  const snap = await (async()=>{
    const p2 = snapshotRead();
    await Promise.resolve();
    await h.topology.publish(topo(3, 500, [['p2','s1',0.2]]));
    return p2;
  })();
  assert.equal(snap.before, 2);
  assert.equal(snap.after, 2, '快照在 await 后仍指向捕获时的版本');
});

function effectiveVersionAt(h:ReturnType<typeof makeHarness>, at:number):number{
  let chosen = 0;
  for(const v of h.topology.listVersions()) if(v.effectiveAt<=at && v.version>chosen) chosen = v.version;
  return chosen;
}
