/**
 * 维护公告 feature（13BE §6 /api/ops/notices）——API 适配层。
 * 契约校验失败抛 ContractError（进入明确错误态），不返回 null 冒充空数据。
 */
import { req } from '../../api';
import { ContractError } from '../../shared/contracts';

export interface NoticeItem {
  id: number; title: string; content: string; level: string; active: boolean; updatedAt?: string;
}

export function parseNotices(raw: unknown): NoticeItem[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { list?: unknown }).list)) {
    throw new ContractError('/api/ops/notices', 'list 缺失或不是数组');
  }
  const out: NoticeItem[] = [];
  for (const v of (raw as { list: unknown[] }).list) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'number' || typeof o.title !== 'string'
      || typeof o.content !== 'string' || typeof o.level !== 'string') continue;
    out.push({
      id: o.id, title: o.title, content: o.content, level: o.level,
      active: o.active === true,
      updatedAt: typeof o.updated_at === 'string' ? o.updated_at : undefined,
    });
  }
  return out;
}

export async function fetchNotices(signal?: AbortSignal): Promise<NoticeItem[]> {
  return parseNotices(await req('GET', '/api/ops/notices', undefined, signal));
}

export function publishNotice(input: { title: string; content: string; level: string }): Promise<unknown> {
  return req('POST', '/api/ops/notices', input);
}

export function deactivateNotice(): Promise<unknown> {
  return req('PUT', '/api/ops/notices/deactivate');
}