export interface RouteInfo {
  /** approval：审批中心（spec 022 T3）。 */
  kind: 'app' | 'page' | 'preview' | 'approval';
  appId?: string;
  pageId?: string;
  recordId?: string;
  grantId?: string;
  /** 审批中心：直接打开的实例 id（可选——无则显示列表）。 */
  instanceId?: string;
}

export function parseRuntimeHash(hash: string): RouteInfo | null {
  // 审批中心：`#/approval` 或 `#/approval/{instanceId}`
  const approval = hash.match(/^#\/approval(?:\/([A-Za-z0-9-]+))?$/);
  if (approval) {
    return { kind: 'approval', ...(approval[1] ? { instanceId: approval[1] } : {}) };
  }
  const app = hash.match(/^#\/app\/(\d+)(?:\/page\/(\d+)(?:\/(\d+))?)?$/);
  if (app) {
    return { kind: 'app', appId: app[1], ...(app[2] ? { pageId: app[2] } : {}),
      ...(app[3] ? { recordId: app[3] } : {}) };
  }
  const preview = hash.match(/^#\/preview\?grant=([A-Za-z0-9-]+)$/);
  if (preview) return { kind: 'preview', grantId: preview[1] };
  const page = hash.match(/^#\/page\/(\d+)(?:\/(\d+))?$/);
  return page ? { kind: 'page', pageId: page[1], ...(page[2] ? { recordId: page[2] } : {}) } : null;
}

/** 构造审批中心 hash（详情可带实例 id；关闭详情传 null）。 */
export function approvalHash(instanceId?: string | null): string {
  return instanceId != null && instanceId !== ''
    ? `#/approval/${instanceId}`
    : '#/approval';
}