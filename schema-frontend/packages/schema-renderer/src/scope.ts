/**
 * RenderScope（02FE §2 管线 ③ 前置）：字段级订阅的原子化 store。
 *
 * 设计权衡：不引 valtio——本包只需要「字段级 get/set + 订阅切片」语义，
 * 自实现微型响应式内核（~100 行）避免运行时依赖膨胀与 proxy 兼容性问题。
 * 对外契约与 valtio 快照等价：getSnapshot(key) 返回稳定引用。
 */

export type Listener = () => void;

/** 字段级原子存储：任意 JsonValue 按 key 存取，变化按订阅粒度精确通知。 */
export class RenderScope {
  private values = new Map<string, unknown>();
  private version = 0;
  private listeners = new Map<string, Set<Listener>>();
  private globalListeners = new Set<(keys: string[]) => void>();
  /** 批处理队列：一帧内多次 set 合并为一次通知（微任务批处理，03FE §3）。 */
  private pending = new Set<string>();
  private scheduled = false;
  private notifyQueue: (() => void)[] = [];

  /** 读值（不存在返回 undefined——表达式侧 FieldMissingError 语义由协议层判定）。 */
  get(key: string): unknown {
    return this.values.get(key);
  }

  /** 写值：值不变（Object.is）不通知；批处理窗口内合并通知。 */
  set(key: string, value: unknown): void {
    const prev = this.values.get(key);
    if (Object.is(prev, value)) return;
    this.values.set(key, value);
    this.version++;
    this.pending.add(key);
    this.scheduleFlush();
  }

  /** 批量写：单次通知（表单 setValues / 数据源装载场景）。 */
  setValues(entries: Record<string, unknown>): void {
    let changed = false;
    for (const [k, v] of Object.entries(entries)) {
      const prev = this.values.get(k);
      if (Object.is(prev, v)) continue;
      this.values.set(k, v);
      this.version++;
      this.pending.add(k);
      changed = true;
    }
    if (changed) this.scheduleFlush();
  }

  /** 字段级订阅（02FE §4）：仅当 keys 内字段变化触发 listener。返回退订函数。 */
  subscribe(keys: string[], listener: Listener): () => void {
    const key = keySetId(keys);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(key);
    };
  }

  /** 全量订阅（依赖扫描兜底——02FE §4「漏标退化为全量订阅」观测口径）。 */
  subscribeAll(listener: (keys: string[]) => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  /** 快照读取（受控组件 value 契约）：返回稳定引用或 undefined。 */
  getSnapshot(key: string): unknown {
    return this.values.get(key);
  }

  /** 当前版本号（测试断言与调试）。 */
  get revision(): number {
    return this.version;
  }

  /** 同步通知队列长度（测试批处理断言）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  private scheduleFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  /** 冲刷批处理：keys 求并集匹配订阅组（子集命中即通知）。 */
  private flush(): void {
    if (this.pending.size === 0) return;
    const changed = [...this.pending];
    this.pending.clear();
    const changedSet = new Set(changed);
    // 全量订阅兜底
    for (const g of this.globalListeners) g(changed);
    // 字段级订阅：订阅 keys 与变化集有交集即触发
    for (const [key, set] of this.listeners) {
      const keys = parseKeySetId(key);
      if (keys.some((k) => changedSet.has(k))) {
        for (const listener of set) this.notifyQueue.push(listener);
      }
    }
    // 通知去重（同一 listener 注册多个命中订阅组只触发一次）
    const unique = [...new Set(this.notifyQueue)];
    this.notifyQueue.length = 0;
    for (const listener of unique) listener();
  }
}

/** 订阅组标识：排序键序列（保证 [a,b] 与 [b,a] 同组）。 */
function keySetId(keys: string[]): string {
  return [...keys].sort().join('\u0000');
}

function parseKeySetId(id: string): string[] {
  return id.split('\u0000');
}
