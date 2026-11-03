/**
 * 会话失效占位（2026-11-03 认证收口）：
 * 替代旧 location.reload()——失效后停止加载业务数据、不反复重载、不展示旧数据；
 * 清权限快照与页面 Schema 缓存（敏感缓存不跨会话残留），提供「重新登录」入口
 * （运行时无登录页——跳设计器登录，登录后返回原应用路由）。
 */
import React from 'react';
import { Button, Result, Typography } from 'antd';

export interface SessionExpiredProps {
  /** 清缓存回调（宿主注入——清 schema_page_cache_* 与权限快照存储）。 */
  onCleanup?: () => void;
  /** 重新登录入口跳转地址（缺省跳设计器登录页）。 */
  loginUrl?: string;
}

/** 会话失效时统一执行的清理：页面 Schema 缓存 + 权限相关本地存储。 */
export function clearSessionCaches(): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith('schema_page_cache_')
        || key?.startsWith('schema_perms_')
        || key?.startsWith('schema_me_')) {
      localStorage.removeItem(key);
    }
  }
}

export default function SessionExpired({
  onCleanup,
  loginUrl = '/designer/',
}: SessionExpiredProps): React.ReactElement {
  const [cleaned, setCleaned] = React.useState(false);
  React.useEffect(() => {
    onCleanup?.();
    clearSessionCaches();
    setCleaned(true);
  }, [onCleanup]);

  return (
    <Result
      status="403"
      title="登录已失效"
      subTitle={
        <Typography.Text type="secondary">
          会话已过期或被登出，页面已停止加载并清除了本地缓存。请重新登录后继续使用。
          {cleaned ? '' : '（正在清理本地缓存…）'}
        </Typography.Text>
      }
      extra={
        <Button type="primary" href={loginUrl}>
          重新登录
        </Button>
      }
    />
  );
}
