/**
 * 应用内共享展示组件（跨 feature 复用——区域状态条/三态卡片/权限与错误提示）。
 */
export {
  statusTag, HealthSummary, RegionStatusBar, SeriesCard,
  ThroughputSeries, CompileSeries, RecentErrorsTable,
  ForbiddenAlert, ErrorRetryAlert,
  type RegionStatus,
} from './HealthSummary';