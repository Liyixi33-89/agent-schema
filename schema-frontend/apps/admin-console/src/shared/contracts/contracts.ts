/**
 * 运行时响应校验（阶段 C 重构范例——外部数据不裸类型断言）：
 * 契约结构不合法 → 抛 ContractError（进入明确错误态，不再返回 null 冒充「不可用/无样本」）；
 * 合法无样本（如 series: []）→ 返回空数组，与损坏响应严格区分。
 * 全部为纯函数，可单测。
 */

/** 契约解析失败（响应结构与后端契约不符——必须进入错误态，不能当合法空数据）。 */
export class ContractError extends Error {
  readonly endpoint: string;
  constructor(endpoint: string, detail: string) {
    super(`响应契约校验失败（${endpoint}）：${detail}`);
    this.name = 'ContractError';
    this.endpoint = endpoint;
  }
}

/** 平台探活（无权限要求）。 */
export interface HealthInfo { status: string; db: string; version: string; timestamp: string }

/** 租户健康总览（10BE §4.1 overview——近 1h 聚合；状态字段严格按后端真源）。 */
export interface TenantHealthOverview {
  db: string;
  activeUsersLastHour: number;
  apiThroughputLastHour: { calls: number; source: string };
  errorRateLastHour: { errors: number; source: string };
  scriptCompileLastHour: { total: number; success: number; successRate: number | null };
  resourceUsage: { storageMb: number };
  timestamp: string;
}

export interface ThroughputPoint { minute: string; calls: number }
export interface CompilePoint { hour: string; total: number; success: number; failed: number; blocked: number; medianDurationMs: number | null }
export interface RecentErrorItem { kind: string; at: string; type: string; resource: string; userId?: number; durationMs?: number }

/** SLA 月度契约（PRD11 §2.1——availability null 表示采样中，不代替为 100%）。 */
export interface SlaMonthly {
  yearMonth: string;
  targetSla: number;
  availability: number | null;
  totalMinutes: number;
  excludedMaintenanceMinutes: number;
  effectiveMinutes: number;
  unavailableMinutes: number;
  incidents: { startAt: string; minutes: number }[];
  sampledMinutes: number;
  basis: Record<string, string>;
}

export interface MaintenanceWindow {
  id: number; tenantId: number; title: string; startAt: string; endAt: string;
  announcedAt?: string; status: string;
}

/** 维护窗口登记入参（POST /api/ops/sla/maintenance-windows 请求体）。 */
export interface MaintenanceWindowInput {
  title: string; startAt: string; endAt: string; emergency: boolean;
}

// ---------- 基础守卫 ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null { return typeof v === 'string' ? v : null; }
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// ---------- 各接口响应校验 ----------

export function parseHealthInfo(raw: unknown): HealthInfo {
  if (!isObj(raw)) throw new ContractError('/api/ops/health', '响应不是对象');
  const status = str(raw.status); const db = str(raw.db);
  const version = str(raw.version); const timestamp = str(raw.timestamp);
  if (!status || !db || !version || !timestamp) {
    throw new ContractError('/api/ops/health', 'status/db/version/timestamp 缺失或类型不符');
  }
  return { status, db, version, timestamp };
}

export function parseTenantOverview(raw: unknown): TenantHealthOverview {
  if (!isObj(raw)) throw new ContractError('/api/ops/health/tenant/overview', '响应不是对象');
  const db = str(raw.db); const timestamp = str(raw.timestamp);
  const activeUsers = num(raw.activeUsersLastHour);
  const api = isObj(raw.apiThroughputLastHour) ? num(raw.apiThroughputLastHour.calls) : null;
  const apiSrc = isObj(raw.apiThroughputLastHour) ? str(raw.apiThroughputLastHour.source) : null;
  const err = isObj(raw.errorRateLastHour) ? num(raw.errorRateLastHour.errors) : null;
  const errSrc = isObj(raw.errorRateLastHour) ? str(raw.errorRateLastHour.source) : null;
  const compileRaw: Record<string, unknown> | null = isObj(raw.scriptCompileLastHour) ? raw.scriptCompileLastHour : null;
  const compileTotal = compileRaw ? num(compileRaw.total) : null;
  const compileSuccess = compileRaw ? num(compileRaw.success) : null;
  const compileRate = compileRaw ? compileRaw.successRate : null; // null=采样中合法
  const storage = isObj(raw.resourceUsage) ? num(raw.resourceUsage.storageMb) : null;
  if (db === null || timestamp === null || activeUsers === null
    || api === null || apiSrc === null || err === null || errSrc === null
    || compileTotal === null || compileSuccess === null || storage === null) {
    throw new ContractError('/api/ops/health/tenant/overview', '必填统计字段缺失或类型不符');
  }
  if (compileRate !== null && num(compileRate) === null) {
    throw new ContractError('/api/ops/health/tenant/overview', 'successRate 非数字且非 null');
  }
  return {
    db, activeUsersLastHour: activeUsers, timestamp,
    apiThroughputLastHour: { calls: api, source: apiSrc },
    errorRateLastHour: { errors: err, source: errSrc },
    scriptCompileLastHour: {
      total: compileTotal, success: compileSuccess,
      successRate: compileRate === null ? null : (num(compileRate) as number),
    },
    resourceUsage: { storageMb: storage as number },
  };
}

/** 时序信封校验：series 必须是数组（缺失/非数组 → 契约错误）；空数组是合法无样本。 */
function parseSeries<T>(endpoint: string, raw: unknown, item: (v: unknown) => T | null): T[] {
  if (!isObj(raw) || !Array.isArray(raw.series)) {
    throw new ContractError(endpoint, 'series 缺失或不是数组');
  }
  const out: T[] = [];
  for (const it of raw.series) { const p = item(it); if (p !== null) out.push(p); }
  return out; // 部分坏行剔除——不因单点坏数据丢弃整段时序
}

export function parseThroughput(raw: unknown): ThroughputPoint[] {
  return parseSeries<ThroughputPoint>('/api/ops/health/tenant/api-throughput', raw, (v) => {
    if (!isObj(v)) return null;
    const minute = str(v.minute); const calls = num(v.calls);
    return minute !== null && calls !== null ? { minute, calls } : null;
  });
}

export function parseCompile(raw: unknown): CompilePoint[] {
  return parseSeries<CompilePoint>('/api/ops/health/tenant/script-compile', raw, (v) => {
    if (!isObj(v)) return null;
    const hour = str(v.hour); const total = num(v.total);
    const success = num(v.success); const failed = num(v.failed); const blocked = num(v.blocked);
    const median = v.medianDurationMs == null ? null : num(v.medianDurationMs);
    if (hour === null || total === null || success === null || failed === null || blocked === null) return null;
    if (median === null && v.medianDurationMs != null) return null;
    return { hour, total, success, failed, blocked, medianDurationMs: median };
  });
}

export function parseRecentErrors(raw: unknown): RecentErrorItem[] {
  if (!isObj(raw) || !Array.isArray(raw.list)) {
    throw new ContractError('/api/ops/health/tenant/recent-errors', 'list 缺失或不是数组');
  }
  const out: RecentErrorItem[] = [];
  for (const v of raw.list) {
    if (!isObj(v)) continue;
    const kind = str(v.kind); const at = str(v.at); const type = str(v.type); const resource = str(v.resource);
    if (kind === null || at === null || type === null || resource === null) continue;
    out.push({
      kind, at, type, resource,
      userId: v.userId == null ? undefined : (num(v.userId) ?? undefined),
      durationMs: v.durationMs == null ? undefined : (num(v.durationMs) ?? undefined),
    });
  }
  return out;
}

export function parseSlaMonthly(raw: unknown): SlaMonthly {
  if (!isObj(raw)) throw new ContractError('/api/ops/sla/monthly', '响应不是对象');
  const yearMonth = str(raw.yearMonth); const targetSla = num(raw.targetSla);
  const availability = raw.availability == null ? null : num(raw.availability);
  const totalMinutes = num(raw.totalMinutes);
  const excluded = num(raw.excludedMaintenanceMinutes);
  const effective = num(raw.effectiveMinutes);
  const unavailable = num(raw.unavailableMinutes);
  const sampled = num(raw.sampledMinutes);
  const basis = isObj(raw.basis) ? (raw.basis as Record<string, string>) : null;
  if (yearMonth === null || targetSla === null
    || totalMinutes === null || excluded === null || effective === null
    || unavailable === null || sampled === null || basis === null) {
    throw new ContractError('/api/ops/sla/monthly', '必填统计字段或 basis 缺失');
  }
  if (!Array.isArray(raw.incidents)) {
    throw new ContractError('/api/ops/sla/monthly', 'incidents 不是数组');
  }
  const incidents: { startAt: string; minutes: number }[] = [];
  for (const v of raw.incidents) {
    if (!isObj(v)) continue;
    const startAt = str(v.startAt); const minutes = num(v.minutes);
    if (startAt !== null && minutes !== null) incidents.push({ startAt, minutes });
  }
  return {
    yearMonth, targetSla, availability, totalMinutes,
    excludedMaintenanceMinutes: excluded, effectiveMinutes: effective,
    unavailableMinutes: unavailable, sampledMinutes: sampled, incidents, basis,
  };
}

export function parseMaintenanceWindows(raw: unknown): MaintenanceWindow[] {
  if (!isObj(raw) || !Array.isArray(raw.list)) {
    throw new ContractError('/api/ops/sla/maintenance-windows', 'list 缺失或不是数组');
  }
  const out: MaintenanceWindow[] = [];
  for (const v of raw.list) {
    if (!isObj(v)) continue;
    const id = num(v.id); const tenantId = num(v.tenant_id);
    const title = str(v.title); const startAt = str(v.start_at); const endAt = str(v.end_at);
    const status = str(v.status);
    if (id === null || tenantId === null || title === null || startAt === null || endAt === null || status === null) continue;
    const announcedAt = str(v.announced_at) ?? undefined;
    out.push({ id, tenantId, title, startAt, endAt, announcedAt, status });
  }
  return out;
}

/** SLA 月度查询参数（YYYY-MM 校验 + 解析；非法输入 null——调用方不发起请求）。 */
export function parseYearMonth(v: string): { year: number; month: number } | null {
  if (!/^\d{4}-\d{2}$/.test(v)) return null;
  const [y, m] = v.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  return { year: y, month: m };
}