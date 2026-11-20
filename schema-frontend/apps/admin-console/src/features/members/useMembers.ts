/**
 * 成员管理 feature 数据 Hook：复用通用 useAsyncData（取消/竞态/刷新语义统一）。
 */
import { useAsyncData } from '../../shared/async';
import { fetchMembers, type MemberItem } from './api';
import type { AsyncState } from '../../shared/async';

export type Region<T> = AsyncState<T> & { reload: () => void };

export function useMembers(): Region<MemberItem[]> {
  return useAsyncData(fetchMembers, []);
}