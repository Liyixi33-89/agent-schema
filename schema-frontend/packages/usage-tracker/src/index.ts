/**
 * 用量埋点 SDK（09FE）：事件模型 + 批量上报管线 + 合规白名单 + 幂等重试。
 * 独立包零依赖——业务代码只感知 track()；上报走 /api/metering/events 独立通道。
 */

/** 事件类型（09FE §2；上报侧映射到后端 usage_event.metric 口径）。 */
export type UsageEvent =
  | { type: 'seat.active'; surface: 'designer' | 'runtime' }
  | { type: 'ai.invoke'; feature: string; tokens: { in: number; out: number } }
  | { type: 'artifact.load'; pageId: string; hash: string };

/** 上报信封（09FE §2）：eventId 幂等键重试复用。 */
export interface Envelope {
  eventId: string;
  occurredAt: number;
  event: UsageEvent;
  /** metric 口径映射（后端 09BE §4 表）。 */
  metric: string;
  quantity: number;
  attrs?: Record<string, string | number | boolean>;
}

export interface TrackerConfig {
  endpoint?: string;
  /** 定时 flush 间隔（默认 5s）。 */
  flushIntervalMs?: number;
  /** 满 N 条立即 flush（默认 20）。 */
  batchSize?: number;
  /** buffer 容量上限（默认 100，溢出丢最旧并告警计数）。 */
  maxBuffer?: number;
  /** 上报通道注入（测试替身；默认 fetch keepalive）。 */
  transport?: (url: string, body: string) => Promise<boolean>;
  /** 时间源注入（测试替身）。 */
  now?: () => number;
  /** UUID 源注入（测试替身）。 */
  uuid?: () => string;
}

const DEFAULT_ENDPOINT = '/api/metering/events';
/** attrs 白名单键（与后端 MeteringPolicy.ATTR_KEYS 同源，09BE §1 合规红线）。 */
const ATTR_KEYS = new Set(['surface', 'feature', 'pageId', 'hash']);
/** payload 字符串长度上限。 */
const MAX_STRING_LEN = 64;

/** metric 口径映射（09FE §2 → 09BE §4）。 */
function metricOf(event: UsageEvent): { metric: string; quantity: number; attrs: Record<string, string | number> } | null {
  switch (event.type) {
    case 'seat.active':
      return { metric: 'seat.active', quantity: 1, attrs: { surface: event.surface } };
    case 'ai.invoke':
      // tokens 由 AI 网关服务端终审，前端仅漏斗参考——quantity 固定 1（发起计数）
      return { metric: 'ai.tokens.in', quantity: 1, attrs: { feature: event.feature } };
    case 'artifact.load':
      return { metric: 'build.count', quantity: 1, attrs: { pageId: event.pageId, hash: event.hash } };
    default:
      return null;
  }
}

/** 合规深扫描：只允许白名单键 + 标量值（业务字段值即丢弃）。 */
export function complianceScan(event: UsageEvent): string | null {
  const mapped = metricOf(event);
  if (!mapped) return '未知事件类型';
  for (const [key, value] of Object.entries(mapped.attrs)) {
    if (!ATTR_KEYS.has(key)) return `非白名单键: ${key}`;
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_LEN) return `attrs.${key} 超长(≤${MAX_STRING_LEN})`;
    } else if (typeof value !== 'number' && typeof value !== 'boolean') {
      return `attrs.${key} 必须为标量`;
    }
  }
  return null;
}

export class UsageTracker {
  private buffer: Envelope[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private droppedCount = 0;
  /** seat.active 前端按日去重标记（localStorage 键；非数据仅标记）。 */
  private seatDayKey: string | null = null;
  private readonly cfg: Required<Pick<TrackerConfig, 'endpoint' | 'flushIntervalMs' | 'batchSize' | 'maxBuffer'>>;
  private readonly transport: (url: string, body: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(config: TrackerConfig = {}) {
    this.cfg = {
      endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
      flushIntervalMs: config.flushIntervalMs ?? 5000,
      batchSize: config.batchSize ?? 20,
      maxBuffer: config.maxBuffer ?? 100,
    };
    this.transport = config.transport ?? defaultTransport;
    this.now = config.now ?? Date.now;
    this.uuid = config.uuid ?? randomUuid;
  }

  /** 采集入口：合规校验 → 入队（微秒级，不阻塞业务）。 */
  track(event: UsageEvent): void {
    const violation = complianceScan(event);
    if (violation) {
      this.droppedCount++;
      if (typeof console !== 'undefined') console.warn('[usage-tracker] 事件被合规丢弃:', violation);
      return;
    }
    // seat.active 按用户+自然日去重（省流量；服务端终审兜底）
    if (event.type === 'seat.active') {
      const day = dayOf(this.now());
      if (this.seatDayKey === day) return;
      this.seatDayKey = day;
      try { localStorage.setItem('seat:last-day', day); } catch { /* 隐私模式忽略 */ }
    }
    const mapped = metricOf(event)!;
    const envelope: Envelope = {
      eventId: this.uuid(),
      occurredAt: this.now(),
      event,
      metric: mapped.metric,
      quantity: mapped.quantity,
      attrs: mapped.attrs,
    };
    this.buffer.push(envelope);
    if (this.buffer.length > this.cfg.maxBuffer) {
      // 溢出丢最旧并告警计数（09FE §3 ②）
      this.buffer.shift();
      this.droppedCount++;
    }
    if (this.buffer.length >= this.cfg.batchSize) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = setInterval(() => void this.flush(), this.cfg.flushIntervalMs);
    }
  }

  /**
   * flush：eventId 不变的可靠重试（幂等键红线——重试必须复用原 eventId）。
   * 失败保留 buffer 下轮重试；sendBeacon 降级 keepalive fetch。
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.slice(0, 100);
    const body = JSON.stringify({
      events: batch.map((e) => ({
        eventId: e.eventId,
        occurredAt: new Date(e.occurredAt).toISOString(),
        metric: e.metric,
        quantity: e.quantity,
        attrs: e.attrs,
      })),
    });
    let ok = false;
    try {
      ok = await this.transport(this.cfg.endpoint, body);
    } catch {
      ok = false;
    }
    if (ok) {
      this.buffer = this.buffer.filter((e) => !batch.includes(e));
    }
    // 失败保留 buffer；定时器由下次 track/flush 继续
    if (this.timer !== null && this.buffer.length === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** visibilitychange(hidden) 立即 flush（sendBeacon 保底）。 */
  onVisibilityHidden(): void {
    if (this.buffer.length === 0) return;
    const body = JSON.stringify({
      events: this.buffer.slice(0, 100).map((e) => ({
        eventId: e.eventId,
        occurredAt: new Date(e.occurredAt).toISOString(),
        metric: e.metric,
        quantity: e.quantity,
        attrs: e.attrs,
      })),
    });
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(this.cfg.endpoint, body);
      this.buffer = [];
    } else {
      void this.flush();
    }
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** 测试探针：读取 buffer 中的 eventId（断言幂等复用）。 */
  bufferedEventIds(): string[] {
    return this.buffer.map((e) => e.eventId);
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function defaultTransport(url: string, body: string): Promise<boolean> {
  return fetch(url, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body,
  }).then((r) => r.status === 202 || r.ok, () => false);
}

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 降级 UUID v4（非 crypto 环境占位）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function dayOf(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${mm}${dd}`;
}
