/**
 * 预览凭证兑换页（渐进重构第四批——自 main.tsx 原样抽出，行为不变）：
 * M13：designer 签发 grant → 此处 exchange 换 15min 会话渲染（内存 Bearer 只读）。
 */
import React from 'react';
import { Typography } from 'antd';
import { RequestClient } from '../../shared/request';
import { FormPageHost } from '../page-host';

export default function PreviewPage({ grantId }: { grantId: string }): React.ReactElement {
  const [state, setState] = React.useState<{ phase: 'loading' } | { phase: 'error'; message: string } | {
    phase: 'ready'; token: string; pageId: string;
  }>({ phase: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // credentials:'omit' 强制匿名——预览端点拒正式会话 Cookie（03BE §4.1 通道隔离；
        // 浏览器登录态下自动附带 Cookie 会被 PREVIEW_CREDENTIAL_REJECTED，故显式剥离）
        // API 前缀与请求层同源真源 VITE_API_BASE（验收面 /accept 构建注入）——
        // 此前裸 /api/preview/exchange 在非根部署面（/accept）下 404，预览兑换不可用
        const resp = await fetch(`${import.meta.env.VITE_API_BASE ?? ''}/api/preview/exchange`, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grantId }),
        });
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { message?: string; code?: string };
          throw new Error(`[${resp.status}${body.code ? ' ' + body.code : ''}] ${body.message ?? '兑换失败'}`);
        }
        const body = (await resp.json()) as { accessToken?: string; pageId?: string };
        if (!cancelled) {
          if (!body.accessToken || !body.pageId) {
            throw new Error('兑换响应缺少 accessToken/pageId');
          }
          setState({
            phase: 'ready',
            token: body.accessToken,
            pageId: String(body.pageId),
          });
        }
      } catch (e) {
        if (!cancelled) setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [grantId]);

  if (state.phase === 'loading') return <Typography.Paragraph style={{ padding: 24 }}>预览凭证兑换中…</Typography.Paragraph>;
  if (state.phase === 'error') {
    return <Typography.Paragraph type="danger" style={{ padding: 24 }}>预览失败：{state.message}</Typography.Paragraph>;
  }
  // 预览专用客户端：内存 Bearer（preview JWT 内嵌 tenant claim——服务端侧解析，前端无需注入）
  const previewClient = new RequestClient({
    baseUrl: import.meta.env.VITE_API_BASE ?? '',
    getToken: () => state.token,
  });
  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ padding: '12px 24px 0' }}>
        预览模式（短时会话只读渲染；凭证 15 分钟有效）
      </Typography.Paragraph>
      <FormPageHost client={previewClient} pageId={state.pageId} />
    </div>
  );
}
