/**
 * 应用内共享契约解析（跨 feature 复用——ContractError + 各接口响应校验纯函数）。
 */
export {
  ContractError, parseCompile, parseHealthInfo, parseMaintenanceWindows, parseRecentErrors,
  parseSlaMonthly, parseTenantOverview, parseThroughput, parseYearMonth,
  type CompilePoint, type HealthInfo, type MaintenanceWindow,
  type RecentErrorItem, type SlaMonthly, type TenantHealthOverview, type ThroughputPoint,
} from './contracts';