/**
 * M14 L2 脚本面板（08FE §6 测试台 + §2 保存流程）：
 * - 编辑：TextArea + 实时红线扫描标红（第一道闸编辑期形态——scanSource 同规则）
 * - 保存：提交后端编译（第二道闸 AST 扫描 + esbuild）→ contentHash 回显；失败展示错误行号
 * - 测试台：真实 ScriptHost（Worker 隔离 + terminate 硬中断）+ mock 桥——保真承诺 §6：
 *   执行器/消息桥/扫描器与线上一致，差异仅消息桥另一端数据源
 *
 * 基线登记：Monaco 未接入（项目无该依赖）——编辑期实时标红以 scanSource 结果列表呈现；
 * Monaco（TS 提示+d.ts）为编辑体验增强，随 P2 完整版评估。
 */
import React from 'react';
import { Alert, Button, Descriptions, Input, message, Select, Space, Tag, Typography } from 'antd';
import {
  createMockBridge, createScriptWorker, HOOK_NAMES, scanSource,
  ScriptHost, type HookName, type HookResult, type MessageBridge, type ScanViolation,
} from '@schema/script-host';
import { ApiClient, ApiError } from './api';

const SAMPLE = `export async function beforeSubmit(payload, ctx) {
  const amount = Number(payload?.record?.amount ?? await ctx.form.get('amount'));
  if (amount > 10000) {
    ctx.logger.warn('金额超阈，触发复核标记');
    await ctx.ui.toast('大额提交将进入复核', 'warning');
  }
  return true;
}
`;

export default function ScriptPanel({ api, pageId }: { api: ApiClient; pageId: string }): React.ReactElement {
  const [source, setSource] = React.useState<string>(SAMPLE);
  const [hook, setHook] = React.useState<HookName>('beforeSubmit');
  const [saving, setSaving] = React.useState(false);
  const [built, setBuilt] = React.useState<{ contentHash: string; reused?: boolean } | null>(null);
  const [buildErrors, setBuildErrors] = React.useState<Array<{ line?: number; message: string; code?: string }> | null>(null);
  const [running, setRunning] = React.useState(false);
  const [runResult, setRunResult] = React.useState<HookResult | null>(null);
  const [logs, setLogs] = React.useState<string[]>([]);

  // 编辑期实时扫描（第一道闸——开发者体验层；与保存期/服务端同规则 redlines.json）
  const violations: ScanViolation[] = React.useMemo(() => {
    const r = scanSource(source);
    return r.violations;
  }, [source]);

  const doBuild = async (): Promise<{ contentHash: string; reused?: boolean } | null> => {
    if (violations.length > 0) {
      message.error(`红线违规 ${violations.length} 处，已阻断编译提交`);
      return null;
    }
    setSaving(true);
    setBuildErrors(null);
    try {
      const r = await api.buildPageCode(pageId, source);
      setBuilt(r);
      message.success(`编译成功${r.reused ? '（复用既有产物）' : ''}`);
      return r;
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'SECURITY_BLOCKED' || e.code === 'COMPILE_FAILED')) {
        const d = e as ApiError & { details?: { errors?: Array<{ line?: number; message: string; code?: string }> } };
        setBuildErrors(d.details?.errors ?? [{ message: e.message }]);
      } else {
        setBuildErrors([{ message: e instanceof Error ? e.message : String(e) }]);
      }
      return null;
    } finally {
      setSaving(false);
    }
  };

  /** 测试台运行：真实 Worker + 受控消息桥（mock 数据源）——与线上执行器同一实例。 */
  const doRun = async (): Promise<void> => {
    if (violations.length > 0) {
      message.error('红线违规未清，禁止运行');
      return;
    }
    // 未编译则先编译（产物 URL 是 Worker import 目标——保真链路必须走真实产物）；
    // 显式传参读取结果，不读 state（React 批处理闭包旧值坑——M12 已沉淀）
    let hash = built?.contentHash;
    if (!hash) {
      const r = await doBuild();
      if (!r) { setRunResult({ ok: false, error: '编译未完成', durationMs: 0 }); return; }
      hash = r.contentHash;
    }
    const artifactUrl = artifactUrlOf(hash);

    setRunning(true);
    setRunResult(null);
    setLogs([]);
    const bridge: MessageBridge & { calls: Array<{ op: string; args: unknown[] }> } = createMockBridge({
      'api.call': () => ({ passed: true }),
    }, { amount: '20000' });
    const host = new ScriptHost({
      loadModule: async () => ({}),
      bridge: {
        dispatch: async (op, args) => {
          const r = await bridge.dispatch(op, args);
          if (op === 'log') setLogs((prev) => [...prev, formatLog(args)]);
          return r;
        },
      },
      createWorker: () => {
        const handle = createScriptWorker();
        const wrapped = wrapWorker(handle.worker);
        return {
          postMessage: (m: unknown) => wrapped.postMessage(m),
          terminate: () => handle.dispose(), // 终止同时释放 Blob URL
          addEventListener: wrapped.addEventListener,
          removeEventListener: wrapped.removeEventListener,
        };
      },      artifactUrl: () => artifactUrl,
      staticUser: { id: 'mock-user', roles: ['developer'] },
      staticPage: { params: {}, query: {}, mode: 'design' },
      warnMs: 500,
      hardMs: 10_000,
    });
    try {
      const bindings = new Map<HookName, { scriptId: string; hook: HookName; contentHash: string; sourceHash: string }>([
        [hook, { scriptId: 'testbench', hook, contentHash: hash ?? '', sourceHash: '' }],
      ]);
      const result = await host.run(hook, { record: { amount: '20000' } }, bindings);
      setRunResult(result);
    } finally {
      host.dispose();
      setRunning(false);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Text type="secondary">
        三道闸：①编辑期实时扫描（下方）②保存期后端编译（红线同规则）③运行期 Worker 隔离（测试台与线上同一执行器）。
      </Typography.Text>

      <Input.TextArea
        rows={12}
        value={source}
        onChange={(e) => { setSource(e.target.value); setBuilt(null); }}
        spellCheck={false}
        style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}
      />

      {violations.length > 0 ? (
        <Alert type="error" showIcon message={`红线违规 ${violations.length} 处（阻断编译与运行）`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {violations.map((v, i) => (
                <li key={i}>
                  <Tag color="red">{v.rule}</Tag>
                  行{v.line}:{v.column} — {v.message}
                </li>
              ))}
            </ul>
          } />
      ) : (
        <Alert type="success" showIcon message="实时扫描通过（0 违规）" />
      )}

      <Space>
        <Select value={hook} onChange={setHook} style={{ width: 160 }}
          options={HOOK_NAMES.map((h) => ({ value: h, label: h }))} />
        <Button type="primary" loading={saving} onClick={() => void doBuild()}>保存并编译</Button>
        <Button loading={running} disabled={violations.length > 0} onClick={() => void doRun()}>
          测试台运行（真实 Worker）
        </Button>
      </Space>

      {buildErrors ? (
        <Alert type="error" showIcon message="编译失败（contentHash 不更新——线上继续跑上一版）"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {buildErrors.map((e, i) => (
                <li key={i}>{e.line ? `行${e.line}: ` : ''}{e.message}{e.code ? ` [${e.code}]` : ''}</li>
              ))}
            </ul>
          } />
      ) : null}

      {built ? (
        <Descriptions size="small" bordered column={2}>
          <Descriptions.Item label="contentHash" span={2}>
            <Typography.Text copyable code style={{ fontSize: 12 }}>{built.contentHash}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="状态">
            {built.reused ? <Tag color="blue">同源码幂等复用</Tag> : <Tag color="green">新产物</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="产物不可变">URL 带 hash，长缓存 immutable</Descriptions.Item>
        </Descriptions>
      ) : null}

      {runResult ? (
        <Descriptions size="small" bordered column={1} title="测试台结果（真实 ScriptHost + mock 桥）">
          <Descriptions.Item label="判定">
            {runResult.ok
              ? <Tag color="green">ok</Tag>
              : <Tag color="red">失败</Tag>}
            {runResult.terminated ? <Tag color="volcano">已硬终止</Tag> : null}
            {runResult.warned ? <Tag color="orange">耗时告警</Tag> : null}
          </Descriptions.Item>
          <Descriptions.Item label="返回值">
            <Typography.Text code style={{ fontSize: 12 }}>
              {runResult.value === undefined ? 'undefined' : JSON.stringify(runResult.value)}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="耗时">{runResult.durationMs}ms</Descriptions.Item>
          {runResult.error ? (
            <Descriptions.Item label="错误"><Typography.Text type="danger" style={{ fontSize: 12 }}>{runResult.error}</Typography.Text></Descriptions.Item>
          ) : null}
          {logs.length > 0 ? (
            <Descriptions.Item label="logger 输出">
              <pre style={{ margin: 0, fontSize: 12, maxHeight: 160, overflow: 'auto' }}>{logs.join('\n')}</pre>
            </Descriptions.Item>
          ) : null}
        </Descriptions>
      ) : null}
    </Space>
  );
}

/** WorkerLike 适配：DOM Worker → ScriptHost 的 WorkerLike 协议。 */
function wrapWorker(worker: Worker): {
  postMessage(m: unknown): void;
  terminate(): void;
  addEventListener(t: 'message', l: (e: { data: unknown }) => void): void;
  removeEventListener(t: 'message', l: (e: { data: unknown }) => void): void;
} {
  return {
    postMessage: (m) => worker.postMessage(m),
    terminate: () => worker.terminate(),
    addEventListener: (t, l) => worker.addEventListener(t, l as unknown as EventListener),
    removeEventListener: (t, l) => worker.removeEventListener(t, l as unknown as EventListener),
  };
}

/** 产物端点（04BE §A.5 artifactUrl 回显优先；此处兜底拼同源相对路径——服务端按会话租户绑定）。 */
function artifactUrlOf(contentHash: string): string {
  return `/api/build/artifacts/current/${contentHash}.js`;
}

function formatLog(args: unknown[]): string {
  const [level, msg, extra] = args as [string, string, unknown?];
  return `[${level}] ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`;
}
