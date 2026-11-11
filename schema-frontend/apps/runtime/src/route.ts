export interface RouteInfo {
  kind: 'app' | 'page' | 'preview';
  appId?: string;
  pageId?: string;
  recordId?: string;
  grantId?: string;
}

export function parseRuntimeHash(hash: string): RouteInfo | null {
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
