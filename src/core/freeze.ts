/**
 * 递归冻结纯 JSON 结构。已发布的拓扑版本必须按值冻结：
 * 发布完成后任何引用都不能事后改写历史版本的节点/边，
 * 否则进行中的分析即便持有引用也会被"偷换"输入。
 */
export function deepFreeze<T>(value:T):Readonly<T>{
  if(value === null || typeof value !== 'object') return value;
  if(Object.isFrozen(value)) return value;
  if(Array.isArray(value)){
    for(const item of value) deepFreeze(item);
  } else {
    for(const key of Object.getOwnPropertyNames(value)){
      const v=(value as Record<string,unknown>)[key];
      if(v !== null && typeof v === 'object') deepFreeze(v);
    }
  }
  return Object.freeze(value);
}

/**
 * 异步互斥锁。Node 事件循环中同步代码块天然原子，
 * 该锁用于让多步发布流程（校验 -> 解析节点 -> 落库 -> 审计）整体不可交错，
 * 并为将来发布流程出现 await 步骤时提供同样的保证。
 */
export class Mutex {
  private tail:Promise<void> = Promise.resolve();
  async run<T>(fn:()=>Promise<T>|T):Promise<T>{
    const previous = this.tail;
    let release!:()=>void;
    this.tail = new Promise<void>(resolve=>{ release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}
