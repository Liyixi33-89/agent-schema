/**
 * 主题页签（spec 019 T3 · 13FE 最小交付）：
 * 基本信息 + 主题配置（primaryColor 色板 / darkMode 开关 / 圆角·间距·字体下拉）
 * + 即时预览（同一 resolve——所见即所得）+ 归档/恢复 + 两段式删除。
 * 主题保存走 AppTheme 白名单（theme-engine validateAppTheme 预校验——保存按钮态联动）。
 */
import React from 'react';
import { Button, ConfigProvider, Form, Input, message, Modal, Popconfirm, Radio, Select, Space, Switch, Typography, theme as antdTheme } from 'antd';
import { api, type AppCard } from '../../shared/api';
import { handleError } from '../../app/shellShared';
import { resolve, validateAppTheme, antdTokenOf, type AppTheme } from '@schema/theme-engine';

const PRIMARY_SWATCHES = [
  '#1677ff', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96', '#faad14',
];

export default function ThemeTab({ app, onBack }: { app: AppCard; onBack: () => void }): React.ReactElement {
  const [form] = Form.useForm();
  const [saving, setSaving] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  /** 即时预览生效 token（resolve 同一函数——A3 所见即所得）。 */
  const [preview, setPreview] = React.useState(() => resolve(null));
  // 两段式删除（13BE §3.1 P1）：precheck 影响面 → 输入完整应用名确认
  const [delOpen, setDelOpen] = React.useState(false);
  const [delImpact, setDelImpact] = React.useState<Record<string, unknown> | null>(null);
  const [delConfirm, setDelConfirm] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    form.resetFields();
    void api.appDetail(app.id).then((d) => {
      if (cancelled) return;
      let theme: AppTheme = {};
      try { theme = d.theme ? (JSON.parse(d.theme) as AppTheme) : {}; } catch { theme = {}; }
      form.setFieldsValue({
        name: d.name,
        description: d.description,
        primaryColor: theme.primaryColor ?? '#1677ff',
        darkMode: theme.darkMode ?? false,
        borderRadius: theme.tokens?.borderRadius ?? 6,
        spacing: theme.tokens?.spacing ?? 'default',
        fontFamily: theme.tokens?.fontFamily ?? 'system',
      });
      setPreview(resolve(theme));
      setLoaded(true);
    }).catch((e) => {
      if (!cancelled) {
        setLoadError(e instanceof Error ? e.message : String(e));
        handleError(e);
      }
    });
    return () => { cancelled = true; };
  }, [app.id, form, reload]);

  /** 表单值 → AppTheme → 预览 token（resolve 同源——设计态与运行时一致性由同一函数保证）。 */
  const syncPreview = React.useCallback((_: unknown, all: Record<string, unknown>): void => {
    const candidate: AppTheme = {
      primaryColor: all.primaryColor as string | undefined,
      darkMode: all.darkMode as boolean | undefined,
      tokens: {
        borderRadius: all.borderRadius as 4 | 6 | 8 | undefined,
        spacing: all.spacing as 'compact' | 'default' | 'loose' | undefined,
        fontFamily: all.fontFamily as string | undefined,
      },
    };
    setPreview(resolve(candidate));
  }, []);

  const openDelete = async (): Promise<void> => {
    try {
      const pre = await api.deletePrecheck(app.id);
      setDelImpact(pre.impact);
      setDelConfirm('');
      setDelOpen(true);
    } catch (e) { handleError(e); }
  };

  const previewSpec = React.useMemo(() => antdTokenOf(preview), [preview]);
  const containerStyle: React.CSSProperties = {
    borderRadius: preview.borderRadius,
    fontFamily: preview.fontFamily,
    border: '1px solid #d9d9d9',
    padding: previewSpec.token.padding,
    background: preview.darkMode ? '#141414' : '#fff',
    color: preview.darkMode ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.88)',
    transition: 'all 0.2s',
  };

  return (
    <>
    {loadError && <Space style={{ marginBottom: 16 }}>
      <Typography.Text type="danger">主题装载失败：{loadError}</Typography.Text>
      <Button onClick={() => setReload(value => value + 1)}>重试</Button>
    </Space>}
    <Form form={form} disabled={!loaded || saving} layout="vertical" style={{ maxWidth: 480 }}
      onValuesChange={syncPreview}
      onFinish={async (v: {
        name: string; description?: string; primaryColor?: string; darkMode?: boolean;
        borderRadius?: number; spacing?: string; fontFamily?: string;
      }) => {
        // theme-engine 白名单预校验（前端第一层——后端保存链路同判二次校验）
        const theme: AppTheme = {
          primaryColor: v.primaryColor,
          darkMode: v.darkMode,
          tokens: {
            borderRadius: v.borderRadius as 4 | 6 | 8 | undefined,
            spacing: v.spacing as 'compact' | 'default' | 'loose' | undefined,
            fontFamily: v.fontFamily,
          },
        };
        const check = validateAppTheme(theme);
        if (!check.ok) {
          message.error('主题配置非法：' + check.errors.join('；'));
          return;
        }
        setSaving(true);
        try {
          await api.updateApp(app.id, {
            name: v.name,
            description: v.description,
            theme: JSON.stringify(theme),
          });
          message.success('已保存');
        } catch (e) { handleError(e); } finally { setSaving(false); }
      }}>
      <Form.Item name="name" label="应用名称" rules={[{ required: true }]}>
        <Input maxLength={64} />
      </Form.Item>
      <Form.Item name="description" label="描述">
        <Input.TextArea rows={2} maxLength={512} />
      </Form.Item>
      <Form.Item name="primaryColor" label="主题色（主色）">
        <Radio.Group>
          {PRIMARY_SWATCHES.map((c) => (
            <Radio.Button key={c} value={c} style={{ background: c, borderColor: c, color: '#fff', marginRight: 4, marginBottom: 4 }}>
              {c === form.getFieldValue('primaryColor') ? '✓' : ' '}
            </Radio.Button>
          ))}
        </Radio.Group>
      </Form.Item>
      <Form.Item name="darkMode" label="深色模式" valuePropName="checked">
        <Switch checkedChildren="开" unCheckedChildren="关" />
      </Form.Item>
      <Form.Item name="borderRadius" label="圆角">
        <Select options={[{ value: 4 }, { value: 6 }, { value: 8 }]} />
      </Form.Item>
      <Form.Item name="spacing" label="间距">
        <Select options={[
          { value: 'compact', label: '紧凑' },
          { value: 'default', label: '默认' },
          { value: 'loose', label: '宽松' },
        ]} />
      </Form.Item>
      <Form.Item name="fontFamily" label="字体">
        <Select options={[
          { value: 'system', label: '系统默认' },
          { value: 'serif', label: '衬线（宋体系）' },
          { value: 'mono', label: '等宽' },
        ]} />
      </Form.Item>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        预览（与运行时同一 resolve 输出——下次应用装载生效）
      </Typography.Paragraph>
      <ConfigProvider theme={{
        algorithm: previewSpec.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: previewSpec.token,
      }}>
        <div style={containerStyle}>
          <Space direction="vertical">
            <Button type="primary">主按钮示例</Button>
            <Input placeholder="输入框示例" />
            <Input disabled value="禁用状态示例" />
            <Typography.Text type="danger">错误提示示例</Typography.Text>
            <Typography.Text>正文文本示例</Typography.Text>
          </Space>
        </div>
      </ConfigProvider>
      <Space style={{ marginTop: 16 }}>
        <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
        <Button onClick={async () => {
          // 恢复平台默认（spec 019）：theme 传 "null" 字面量显式清空——运行时降级平台默认
          setSaving(true);
          try {
            await api.updateApp(app.id, { theme: 'null' });
            message.success('已恢复平台默认主题');
            form.setFieldsValue({
              primaryColor: '#1677ff', darkMode: false, borderRadius: 6,
              spacing: 'default', fontFamily: 'system',
            });
            setPreview(resolve(null));
          } catch (e) { handleError(e); } finally { setSaving(false); }
        }}>恢复默认</Button>
        {app.status === 'ACTIVE' && (
          <Popconfirm title="归档后全部资源只读，运行时访问保留。确认归档？" onConfirm={async () => {
            try {
              await api.archiveApp(app.id);
              message.success('已归档');
              onBack();   // 返回卡片墙重载状态（归档后默认列表不可见——includeArchived 开关控制）
            } catch (e) { handleError(e); }
          }}>
            <Button danger>归档应用</Button>
          </Popconfirm>
        )}
        {app.status === 'ARCHIVED' && (
          <Button onClick={async () => {
            try { await api.restoreApp(app.id); message.success('已恢复'); onBack(); } catch (e) { handleError(e); }
          }}>恢复编辑</Button>
        )}
        {app.status !== 'DELETING' && (
          <Button danger type="dashed" onClick={() => { void openDelete(); }}>删除应用…</Button>
        )}
      </Space>
    </Form>
    <Modal
      title="删除应用（不可恢复进入 DELETING）"
      open={delOpen}
      onCancel={() => setDelOpen(false)}
      okText="确认删除"
      okButtonProps={{ danger: true, disabled: delConfirm.trim() !== app.name, loading: deleting }}
      onOk={async () => {
        setDeleting(true);
        try {
          await api.deleteApp(app.id, delConfirm.trim());
          message.success('应用已进入 DELETING');
          setDelOpen(false);
          onBack();
        } catch (e) { handleError(e); } finally { setDeleting(false); }
      }}
    >
      <Typography.Paragraph type="danger">
        删除影响面：{delImpact ? Object.entries(delImpact)
          .filter(([k]) => k !== 'appName')
          .map(([k, v]) => `${k}: ${String(v)}`).join('、') : '加载中…'}
      </Typography.Paragraph>
      <Typography.Paragraph>
        {'请输入完整应用名 '}
        <Typography.Text code>{app.name}</Typography.Text>
        {' 确认删除：'}
      </Typography.Paragraph>
      <Input value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} placeholder={app.name} />
    </Modal>
    </>
  );
}
