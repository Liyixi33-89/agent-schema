/**
 * 设计器登录面板（渐进重构第三批——自 main.tsx 原样抽出，行为不变）：
 * HttpOnly Cookie 通道——匿名 csrf 初始化 + 登录后本地仅存展示用账号名。
 */
import React from 'react';
import { Button, Card, Form, Input, message } from 'antd';
import { api } from '../shared/api';

export default function LoginPanel({ onLogin }: { onLogin: (account: string) => void }): React.ReactElement {
  const [form] = Form.useForm();
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => { void api.initCsrf(); }, []);   // 匿名 csrf（登录 CSRF 防护）
  return (
    <Card title="Schema 设计器 · 登录" style={{ maxWidth: 380, margin: '80px auto' }}>
      <Form form={form} onFinish={async (v: { account: string; password: string }) => {
        setLoading(true);
        try {
          await api.login(v.account, v.password);
          sessionStorage.setItem('schema_session', '1');
          localStorage.setItem('schema_account', v.account);
          localStorage.setItem('schema_tenant', localStorage.getItem('schema_tenant') ?? '1');
          onLogin(v.account);
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setLoading(false);
        }
      }}>
        <Form.Item name="account" rules={[{ required: true, message: '请输入账号' }]}>
          <Input placeholder="账号" />
        </Form.Item>
        <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="密码" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={loading}>登录</Button>
      </Form>
    </Card>
  );
}
