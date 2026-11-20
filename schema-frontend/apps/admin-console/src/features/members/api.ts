/**
 * 成员管理 feature（03BE /api/org/members）——API 适配层。
 * 契约校验失败抛 ContractError（进入明确错误态），不返回 null 冒充空数据。
 */
import { req } from '../../api';
import { ContractError } from '../../shared/contracts';

export interface MemberItem { id: number; account: string; name?: string; status: string }

export function parseMembers(raw: unknown): MemberItem[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { list?: unknown }).list)) {
    throw new ContractError('/api/org/members', 'list 缺失或不是数组');
  }
  const out: MemberItem[] = [];
  for (const v of (raw as { list: unknown[] }).list) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'number' || typeof o.account !== 'string' || typeof o.status !== 'string') continue;
    out.push({ id: o.id, account: o.account, name: typeof o.name === 'string' ? o.name : undefined, status: o.status });
  }
  return out;
}

export async function fetchMembers(signal?: AbortSignal): Promise<MemberItem[]> {
  return parseMembers(await req('GET', '/api/org/members', undefined, signal));
}

export function createMember(input: { account: string; name: string }): Promise<unknown> {
  return req('POST', '/api/org/members', input);
}