/**
 * 审批中心（spec 022 T3）：待办 / 已办 / 实例详情 / 办理抽屉。
 *
 * ## 路由
 * `#/approval`（无实例）→ 列表页；`#/approval/{instanceId}` → 直接开详情。
 * 与 runtime 既有 hash 路由风格一致（#/app/{id}、#/page/{id}）。
 *
 * ## 三个页签的职责
 * - 待办：仅我当前可办理的任务；点击进详情并可直接办理
 * - 已办：我办理过的（含同意/驳回），只读回看
 * - 详情：FlowCanvas 实例着色（history→节点状态）+ taskLog 时间线 + 办理抽屉
 *
 * ## 关键交互约束（A5）
 * - 办理成功后**必须重拉列表**（不能只本地删行——待办转已办，两侧都要变）
 * - 办理失败按错误码给**逐项反馈**（A7 矩阵），不是统一 toast
 */
import React from 'react';
import {
  Alert, Badge, Button, Descriptions, Drawer, Empty, Input, List, Segmented,
  Space, Spin, Tabs, Tag, Timeline, Typography, message,
} from 'antd';
import { FlowCanvas } from '@schema/flow-designer';
import type { FlowSchema } from '@schema/schema-protocol';
import { ServerError } from '@schema/schema-form';
 import { authFetch } from '@schema/auth-sdk';
import type { RequestClient } from '../../shared/request';
import {
  actionText, completeErrorText, instanceStatusText, parseDone, parseInstanceDetail,
  parseTasks, toNodeStates, toTimeline,
  type DoneItem, type InstanceDetail, type TaskItem,
} from './data';

export interface ApprovalCenterProps {
  client: RequestClient;
  /** 当前选中的实例（来自 hash，可为空）。 */
  instanceId?: string | null;
  /** 打开／关闭详情（写回 hash）。 */
  onOpenInstance?: (instanceId: string | null) => void;
}

type TabKey = 'todo' | 'done';

export default function ApprovalCenter(props: ApprovalCenterProps): React.ReactElement {
  const { client, instanceId, onOpenInstance } = props;

  const [tab, setTab] = React.useState<TabKey>('todo');
  const [tasks, setTasks] = React.useState<TaskItem[] | null>(null);
  const [done, setDone] = React.useState<{ list: DoneItem[]; total: number } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'todo') {
        const raw = await client.getJson('/api/my/tasks');
        setTasks(parseTasks(raw));
      } else {
        const raw = await client.getJson('/api/my/tasks/done?page=0&size=50');
        setDone(parseDone(raw));
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [client, tab]);

  React.useEffect(() => { void reload(); }, [reload]);

  // 详情打开时，列表仍在后台——关闭抽屉后需要刷新（A5：办理后两侧都变）
  const closeDetail = () => {
    onOpenInstance?.(null);
    void reload();
  };

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>审批中心</Typography.Title>
        <Button onClick={() => void reload()} loading={loading}>刷新</Button>
      </Space>

      {error != null && (
        <Alert type="error" showIcon message="加载失败" description={error}
          style={{ marginBottom: 12 }}
          action={<Button size="small" onClick={() => void reload()}>重试</Button>} />
      )}

      <Segmented
        value={tab}
        onChange={(v) => setTab(v as TabKey)}
        options={[
          { label: <span>待办 {tasks != null && tab === 'todo' ? <Badge count={tasks.length} size="small" /> : null}</span>, value: 'todo' },
          { label: '已办', value: 'done' },
        ]}
        style={{ marginBottom: 12 }}
      />

      {loading && tasks == null && done == null ? (
        <Spin><div style={{ height: 160 }} /></Spin>
      ) : tab === 'todo' ? (
        <TodoList tasks={tasks ?? []} onOpen={(id) => onOpenInstance?.(id)} />
      ) : (
        <DoneList data={done ?? { list: [], total: 0 }} onOpen={(id) => onOpenInstance?.(id)} />
      )}

      {instanceId != null && instanceId !== '' && (
        <InstanceDrawer
          client={client}
          instanceId={instanceId}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}

// ---------- 待办列表 ----------

function TodoList(props: { tasks: TaskItem[]; onOpen: (instanceId: string) => void }): React.ReactElement {
  const { tasks, onOpen } = props;
  if (tasks.length === 0) {
    return <Empty description="暂无待办" />;
  }
  return (
    <List
      dataSource={tasks}
      renderItem={(t) => (
        <List.Item actions={[
          <Button key="open" type="link" onClick={() => onOpen(t.instanceId)}>查看并办理</Button>,
        ]}>
          <List.Item.Meta
            title={<Space>{t.nodeName || t.nodeId}<Tag color="blue">待审批</Tag></Space>}
            description={<Space split={<span>·</span>}>
              <span>实例 {shortId(t.instanceId)}</span>
              <span>{formatTime(t.createdAt)}</span>
            </Space>}
          />
        </List.Item>
      )}
    />
  );
}

// ---------- 已办列表 ----------

function DoneList(props: {
  data: { list: DoneItem[]; total: number };
  onOpen: (instanceId: string) => void;
}): React.ReactElement {
  const { data, onOpen } = props;
  if (data.list.length === 0) {
    return <Empty description="暂无已办" />;
  }
  return (
    <List
      dataSource={data.list}
      pagination={data.total > 20 ? { pageSize: 20, total: data.total } : false}
      renderItem={(d) => (
        <List.Item actions={[
          <Button key="open" type="link" onClick={() => onOpen(d.instanceId)}>查看实例</Button>,
        ]}>
          <List.Item.Meta
            title={<Space>
              {d.nodeId}
              <Tag color={d.action === 'REJECT' ? 'red' : 'green'}>{actionText(d.action)}</Tag>
              {d.status != null && <Tag>{instanceStatusText(d.status)}</Tag>}
            </Space>}
            description={<Space direction="vertical" size={0}>
              <span style={{ fontSize: 12, color: '#8c8c8c' }}>
                实例 {shortId(d.instanceId)} · {formatTime(d.operatedAt)}
              </span>
              {d.comment != null && d.comment !== '' && (
                <span style={{ fontSize: 12 }}>意见：{d.comment}</span>
              )}
            </Space>}
          />
        </List.Item>
      )}
    />
  );
}

// ---------- 实例详情抽屉 ----------

interface FlowDefLite {
  id: string;
  name: string;
  flowKey: string;
  status: string;
  version: number;
}

function InstanceDrawer(props: {
  client: RequestClient;
  instanceId: string;
  onClose: () => void;
}): React.ReactElement {
  const { client, instanceId, onClose } = props;

  const [detail, setDetail] = React.useState<InstanceDetail | null>(null);
  const [schema, setSchema] = React.useState<FlowSchema | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [completeOpen, setCompleteOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // 详情装载：并行拉实例详情 + 流程定义 schema（着色需要节点集合）
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const rawDetail = await client.getJson(`/api/flow-instances/${instanceId}`);
        const d = parseInstanceDetail(rawDetail);
        if (cancelled) return;
        if (d == null) {
          setError('实例不存在或已删除');
          return;
        }
        setDetail(d);

        // 拉流程定义（拿 nodes 做画布渲染）
        try {
          const s = await loadSchema(client, d.flowDefId);
          if (!cancelled) setSchema(s);
        } catch {
          // schema 拉不到不影响详情核心信息展示，只影响画布
        }
      } catch (e) {
        if (!cancelled) setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [client, instanceId]);

  const nodeStates = detail != null ? toNodeStates(detail) : [];
  const timeline = detail != null ? toTimeline(detail) : [];

  return (
    <Drawer
      title="实例详情"
      open
      width={780}
      onClose={onClose}
      destroyOnClose
      extra={detail?.status === 'RUNNING' && (
        <Button type="primary" onClick={() => setCompleteOpen(true)}>办理</Button>
      )}
    >
      {loading ? (
        <Spin><div style={{ height: 200 }} /></Spin>
      ) : error != null ? (
        <Alert type="error" showIcon message="加载失败" description={error} />
      ) : detail != null ? (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="实例">{shortId(detail.instanceId)}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={detail.status === 'RUNNING' ? 'processing' : 'default'}>
                {instanceStatusText(detail.status)}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="业务记录">
              {String(detail.modelId)} / {String(detail.recordId)}
            </Descriptions.Item>
            <Descriptions.Item label="发起时间">{formatTime(detail.startedAt)}</Descriptions.Item>
          </Descriptions>

          <div>
            <Typography.Text strong>流程图</Typography.Text>
            <div style={{ marginTop: 8 }}>
              {schema != null ? (
                <FlowCanvas
                  schema={schema}
                  instanceState={nodeStates.length > 0 ? { nodes: nodeStates } : undefined}
                  height={320}
                />
              ) : (
                <Alert type="info" showIcon message="流程定义不可用，仅显示轨迹" />
              )}
            </div>
          </div>

          <div>
            <Typography.Text strong>办理轨迹</Typography.Text>
            <div style={{ marginTop: 8 }}>
              {timeline.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无轨迹" />
              ) : (
                <Timeline
                  items={timeline.map((t) => ({
                    color: t.state === 'DONE' ? 'green' : 'blue',
                    children: (
                      <Space direction="vertical" size={0}>
                        <Space>
                          <span style={{ fontWeight: 500 }}>{t.label}</span>
                          {t.state === 'ACTIVE' && <Tag color="processing">进行中</Tag>}
                          {t.durationText !== '' && (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              耗时 {t.durationText}
                            </Typography.Text>
                          )}
                        </Space>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {formatTime(t.startedAt)}
                          {t.endedAt != null && ` → ${formatTime(t.endedAt)}`}
                        </Typography.Text>
                      </Space>
                    ),
                  }))}
                />
              )}
            </div>
          </div>

          {detail.tasks.length > 0 && (
            <div>
              <Typography.Text strong>审批意见</Typography.Text>
              <List
                size="small"
                style={{ marginTop: 8 }}
                dataSource={detail.tasks}
                renderItem={(log) => (
                  <List.Item>
                    <Space direction="vertical" size={0} style={{ width: '100%' }}>
                      <Space>
                        <Tag color={log.action === 'REJECT' ? 'red' : 'green'}>
                          {actionText(log.action)}
                        </Tag>
                        <span style={{ fontSize: 12, color: '#8c8c8c' }}>
                          {log.node_id} · 操作人 {String(log.operator_id)} · {formatTime(log.operated_at)}
                        </span>
                      </Space>
                      {log.comment != null && log.comment !== '' && <span>{log.comment}</span>}
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          )}

          <CompleteDrawer
            open={completeOpen}
            client={client}
            detail={detail}
            onClose={() => setCompleteOpen(false)}
            onDone={() => {
              setCompleteOpen(false);
              onClose();     // 关闭详情 → 触发列表重拉（A5）
            }}
          />
        </Space>
      ) : null}
    </Drawer>
  );
}

// ---------- 办理抽屉 ----------

function CompleteDrawer(props: {
  open: boolean;
  client: RequestClient;
  detail: InstanceDetail;
  onClose: () => void;
  onDone: () => void;
}): React.ReactElement | null {
  const { open, client, detail, onClose, onDone } = props;
  const [comment, setComment] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  // 待办里取本实例的活动任务（详情不直接给 taskId——tasks 是审计日志）
  const [taskId, setTaskId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await client.getJson('/api/my/tasks');
        const list = parseTasks(raw);
        const mine = list.find((t) => t.instanceId === detail.instanceId);
        if (!cancelled) setTaskId(mine?.taskId ?? null);
      } catch {
        if (!cancelled) setTaskId(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open, client, detail.instanceId]);

  const submit = async (approved: boolean) => {
    if (taskId == null) {
      setErrorMsg('找不到可办理的任务（可能已被他人处理，请刷新）');
      return;
    }
    if (!approved && comment.trim() === '') {
      setErrorMsg('驳回必须填写审批意见');
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      // ⚠️ 直接调 authFetch（不经 RequestClient.postJson）：
      // 实测 RequestClient 这条路径发出的请求缺 X-CSRF-Token → 403 CSRF_TOKEN_REJECTED，
      // 而同一浏览器内手动 fetch 带 csrf 头却是 200。authFetch 是三个应用共用的
      // 唯一认证通道（自动注入双提交头），此处显式使用它并传入 baseUrl 对齐。
      const base = client.baseUrl();
      const resp = await authFetch({
        path: `/api/tasks/${taskId}/complete`,
        baseUrl: base,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved,
          comment: comment.trim() === '' ? null : comment.trim(),
        }),
      });
      if (!resp.ok) {
        let code = 'SERVER_ERROR';
        let msg = `办理失败 (${resp.status})`;
        try {
          const b = (await resp.json()) as { code?: string; message?: string };
          if (b.code) code = b.code;
          if (b.message) msg = b.message;
        } catch { /* 非 JSON 错误体 */ }
        throw new ServerError(code, msg, {});
      }
      message.success(approved ? '已同意' : '已驳回');
      onDone();
    } catch (e) {
      // A7 错误矩阵：按错误码给逐项反馈
      setErrorMsg(errText(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer
      title="办理"
      open={open}
      width={420}
      onClose={onClose}
      destroyOnClose
      footer={
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose} disabled={submitting}>取消</Button>
          <Button danger onClick={() => void submit(false)} loading={submitting}>驳回</Button>
          <Button type="primary" onClick={() => void submit(true)} loading={submitting}>同意</Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {errorMsg != null && (
          <Alert type="error" showIcon message="办理失败" description={errorMsg} />
        )}
        {taskId == null && (
          <Alert type="warning" showIcon message="未找到可办理任务"
            description="该实例当前任务可能已由他人处理，请关闭后刷新列表。" />
        )}
        <div>
          <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>审批意见</div>
          <Input.TextArea
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="驳回时必填；同意时可选"
          />
        </div>
      </Space>
    </Drawer>
  );
}

// ---------- helpers ----------

/**
 * 拉流程定义并解析为 FlowSchema（T3 实例着色需要节点集合）。
 *
 * 后端 detail 已返回 flowDefId（本轮补的字段）；`GET /api/flows/{id}` 的
 * `flowSchema` 是 JSON 文本或对象两种形态，统一解析。
 * 解析失败返回 null——UI 退化为「仅显示轨迹」，不白屏。
 */
async function loadSchema(
  client: RequestClient,
  flowDefId: InstanceDetail['flowDefId'],
): Promise<FlowSchema | null> {
  if (flowDefId == null || flowDefId === '') return null;
  const raw = await client.getJson(`/api/flows/${String(flowDefId)}`);
  const o = raw as Record<string, unknown> | null;
  if (o == null) return null;
  const rawSchema = o.flowSchema;
  const obj = typeof rawSchema === 'string' ? JSON.parse(rawSchema) : rawSchema;
  const s = obj as Record<string, unknown> | null;
  if (s == null || !Array.isArray(s.nodes) || !Array.isArray(s.edges)) return null;
  return {
    flowKey: String(s.flowKey ?? o.flowKey ?? ''),
    name: String(s.name ?? o.name ?? ''),
    version: Number(s.version ?? o.version ?? 1),
    schemaVersion: Number(s.schemaVersion ?? 1),
    nodes: s.nodes as FlowSchema['nodes'],
    edges: s.edges as FlowSchema['edges'],
  };
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function formatTime(iso: string | null): string {
  if (iso == null || iso === '') return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function errText(e: unknown): string {
  if (e instanceof ServerError) return completeErrorText(e.code, e.message);
  if (e instanceof Error) return e.message;
  return String(e);
}