/**
 * 工作台壳层共享工具（渐进重构第三批——自 main.tsx 原样抽出，行为不变）：
 * - Session/useSession：Cookie 通道会话态（本地仅存展示用账号名，凭证零存储）
 * - ROLE_LABELS/statusTag：角色与状态标签渲染
 * - handleError：统一错误提示
 */
import React from 'react';
import { message, Tag } from 'antd';
import { broadcastLogout, logout as sdkLogout, watchAuthChannel } from '@schema/auth-sdk';
import { ApiClient } from '../shared/api';
export interface Session {
  account: string;
}

export function useSession(): [Session | null, () => void] {
  // Cookie 通道：本地不存凭证——首屏以会话标记过渡（真实登录态由服务端 401 判定兜底）
  const [session, setSession] = React.useState<Session | null>(() =>
    sessionStorage.getItem('schema_session') === '1'
      ? { account: localStorage.getItem('schema_account') ?? '' } : null,
  );
  const expire = React.useCallback(() => {
    sessionStorage.removeItem('schema_session');
    setSession(null);
  }, []);
  const logout = React.useCallback(() => {
    void sdkLogout().then((result) => {
      if (!result.revoked) {
        // 服务端撤销失败：本地已清屏但 HttpOnly 会话可能仍有效——明确提示，不伪装安全退出
        message.warning(`登出未完成：${result.message ?? '服务端撤销失败'}，请关闭浏览器或稍后重试`);
      }
      broadcastLogout();
      expire();
    });
  }, [expire]);
  // 多标签协调：他端登出即时感知（不等下一次请求 401）
  React.useEffect(() => watchAuthChannel((msg) => {
    if (msg.type === 'logout') expire();
  }), [expire]);
  // 401 静默刷新失败 → 回登录页（ApiClient 回调注入）
  React.useEffect(() => {
    ApiClient.onSessionExpired = expire;
    return () => { ApiClient.onSessionExpired = null; };
  }, [expire]);
  return [session, logout];
}

export const ROLE_LABELS: Record<string, string> = {
  app_admin: '应用管理员', developer: '开发者', user: '使用者',
};

export function statusTag(status: string): React.ReactElement {
  if (status === 'ARCHIVED') return <Tag color="orange">已归档</Tag>;
  if (status === 'DELETING') return <Tag color="red">删除中</Tag>;
  return <Tag color="green">使用中</Tag>;
}

// 错误提示归集至 @schema/shared-ui（第三阶段）——保持原路径 re-export，调用面零改动
export { showError as handleError } from '@schema/shared-ui';
