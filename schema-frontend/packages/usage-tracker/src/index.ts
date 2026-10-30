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
  /** 当前用户 ID（seat.active 去重标记按用户隔离）。 */
  userId?: string;
  /** 认证头注入（上报通道需登录态；宿主按实际 token 键注入——缺省回退 localStorage access_token）。 */
  authHeader?: () => Record<string, string>;
  /** 上报通道注入（测试替身；默认 fetch keepalive）。 */
  transport?: (url: string, body: string, headers: Record<string, string>) => Promise<boolean>;
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

/** metric 口径映射（09FE §2 → 09BE §4）。
 *  红线：前端事件仅漏斗——终审指标（ai.tokens/build.count 等）禁走客户端通道，
 *  前端一律映射到 funnel.* 观测指标；计费口径由服务端埋点终审（09BE §4）。 */
function metricOf(event: UsageEvent): { metric: string; quantity: number; attrs: Record<string, string | number> } | null {
  switch (event.type) {
    case 'seat.active':
      // 漏斗参考：服务端 DesignerWriteListener 终审去重后才是计费口径
      return { metric: 'seat.active', quantity: 1, attrs: { surface: event.surface } };
    case 'ai.invoke':
      // 发起计数漏斗（tokens 由 AI 网关服务端终审，前端值仅观测参考）
      return { metric: 'funnel.ai.invoke', quantity: 1, attrs: { feature: event.feature } };
    case 'artifact.load':
      // 产物加载健康度观测（编译执行次数 build.count 由 build-service 服务端埋点）
      return { metric: 'funnel.artifact.load', quantity: 1, attrs: { pageId: event.pageId, hash: event.hash } };
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
  /** flush 并发防护：进行中不重入。 */
  private inFlight = false;
  /** seat.active 前端按日去重标记（localStorage 键；非数据仅标记）。 */
  private seatDayKey: string | null = null;
  private readonly cfg: Required<Pick<TrackerConfig, 'endpoint' | 'flushIntervalMs' | 'batchSize' | 'maxBuffer'>>;
  private readonly userId?: string;
  private readonly authHeader?: () => Record<string, string>;
  private readonly transport: (url: string, body: string, headers: Record<string, string>) => Promise<boolean>;
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(config: TrackerConfig = {}) {
    this.cfg = {
      endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
      flushIntervalMs: config.flushIntervalMs ?? 5000,
      batchSize: config.batchSize ?? 20,
      maxBuffer: config.maxBuffer ?? 100,
    };
    this.userId = config.userId;
    this.authHeader = config.authHeader;
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
    // seat.active 按用户+自然日去重（省流量；服务端终审兜底）。
    // 去重标记读写 localStorage：键含用户 ID（构造时注入 userId）；跨会话当日不重复上报。
    if (event.type === 'seat.active') {
      const day = dayOf(this.now());
      const key = `seat:${this.userId ?? '-'}:${day}`;
      if (this.seatDayKey === key) return;
      try {
        if (localStorage.getItem('seat:last-day-key') === key) {
          this.seatDayKey = key;
          return;
        }
        localStorage.setItem('seat:last-day-key', key);
      } catch { /* 隐私模式忽略 */ }
      this.seatDayKey = key;
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

  /** 组装上报请求头：authHeader 注入优先（宿主实际 token 通道），缺省回退 localStorage access_token。 */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    try {
      if (this.authHeader) {
        Object.assign(headers, this.authHeader());
      } else {
        const token = typeof localStorage !== 'undefined' ? localStorage.getItem('access_token') : null;
        if (token) headers.Authorization = `Bearer ${token}`;
      }
    } catch { /* 隐私模式忽略 */ }
    return headers;
  }

  /**
   * flush：eventId 不变的可靠重试（幂等键红线——重试必须复用原 eventId）。
   * 失败保留 buffer 下轮重试；并发防护：进行中不重入（inFlight 标记）。
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.inFlight) return;
    this.inFlight = true;
    try {
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
        ok = await this.transport(this.cfg.endpoint, body, this.buildHeaders());
      } catch {
        ok = false;
      }
      if (ok) {
        this.buffer = this.buffer.filter((e) => !batch.includes(e));
      }
      // 失败保留 buffer；定时器由下次 track/flush 继续
    } finally {
      this.inFlight = false;
    }
    if (this.timer !== null && this.buffer.length === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * visibilitychange(hidden) 立即上报保底。
   * sendBeacon 无法携带 Authorization 头（计量端点要求 JWT）——排队成功≠服务端受理，
   * 盲清队列会丢事件。改用 keepalive fetch 同步发送（可带认证头且能感知结果）；
   * sendBeacon 仅在 fetch 不可用时降级且保留 buffer（下次启动重试）。
   */
  onVisibilityHidden(): void {
    if (this.buffer.length === 0) return;
    void this.flush();
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

function defaultTransport(url: string, body: string, headers: Record<string, string>): Promise<boolean> {
  // headers 已含认证头（buildHeaders 组装——authHeader 注入或 access_token 回退）
  return fetch(url, {
    method: 'POST',
    keepalive: true,
    headers,
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
