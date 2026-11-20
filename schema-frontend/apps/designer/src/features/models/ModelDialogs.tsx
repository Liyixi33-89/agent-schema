/**
 * ER 建模器弹层组（自 ModelTab.tsx 原样抽出，行为不变）：
 * - SaveConfirmModal：两段式确认弹层（左变更清单 + 右影响面 severity 排序 + 三档确认）
 * - ConflictModal：409 三方对比弹层（本地草稿保留，显式裁决）
 * - VersionsDrawer：版本时间线抽屉 + 回滚确认（独立 precheck → TYPE_MODEL_NAME）
 */
import React from 'react';
import {
  Button, Checkbox, Drawer, Input, List, message, Modal, Space, Spin, Tag, Timeline, Typography,
} from 'antd';
import type { ModelDetail, PrecheckResp, VersionRow } from '../../shared/api';
import type { ChangeOp } from '@schema/data-model-designer';
import { adoptServerDraft } from '@schema/data-model-designer';
import { DELETE_ACK_IDX, RISK_LABEL, SEVERITY_COLOR, type ConflictRow, type DraftField, type DraftModel } from './modelTabShared';

// ---------- 两段式确认弹层 ----------

export function SaveConfirmModal({
  open, onCancel, onOk, precheck, changes, hasDelete, effMode, checkedRisks,
  onCheckRisk, modelNameInput, onModelNameInput, canSubmit, saving, modelName,
}: {
  open: boolean;
  onCancel: () => void;
  onOk: () => void;
  precheck: PrecheckResp | null;
  changes: ChangeOp[];
  hasDelete: boolean;
  effMode: 'INFO' | 'CHECKBOX' | 'TYPE_MODEL_NAME';
  checkedRisks: Set<number>;
  onCheckRisk: (idx: number, checked: boolean) => void;
  modelNameInput: string;
  onModelNameInput: (v: string) => void;
  canSubmit: boolean;
  saving: boolean;
  modelName: string;
}): React.ReactElement {
  const severitySorted = React.useMemo(() => {
    if (!precheck) return [];
    const rank = { HIGH: 3, MEDIUM: 2, INFO: 1 } as const;
    return precheck.risks.map((r, i) => ({ ...r, i })).sort((a, b) => rank[b.severity] - rank[a.severity]);
  }, [precheck]);

  return (
    <Modal title={`保存确认 · ${modelName}`} open={open} width={720}
      onCancel={onCancel}
      okText={effMode === 'TYPE_MODEL_NAME' ? '输入模型名后确认' : '确认保存'}
      okButtonProps={{ danger: hasDelete, disabled: !canSubmit, loading: saving }}
      onOk={onOk}>
      {precheck && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <Typography.Text strong>变更清单（{changes.length} 项）</Typography.Text>
            <List size="small" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto' }}
              dataSource={changes}
              renderItem={(c) => (
                <List.Item style={{ padding: '4px 0' }}>
                  <Space>
                    <Tag color={c.op === 'DELETE_FIELD' ? 'red' : c.op === 'ADD_FIELD' ? 'green' : 'blue'}>
                      {c.op === 'ADD_FIELD' ? '新增' : c.op === 'MODIFY_FIELD' ? '修改' : c.op === 'DELETE_FIELD' ? '删除' : '提升列'}
                    </Tag>
                    <span>{c.fieldKey}</span>
                    {c.op === 'MODIFY_FIELD' && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {Object.keys(c.patch).join(', ')}
                      </Typography.Text>
                    )}
                  </Space>
                </List.Item>
              )} />
          </div>
          <div>
            <Typography.Text strong>影响面（{severitySorted.length} 项，按严重度排序）</Typography.Text>
            <List size="small" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto' }}
              locale={{ emptyText: '无风险项' }}
              dataSource={severitySorted}
              renderItem={(r) => (
                <List.Item style={{ padding: '4px 0' }}
                  actions={effMode === 'CHECKBOX' && r.severity === 'HIGH' ? ([
                    <Checkbox key="ack" checked={checkedRisks.has(r.i)} onChange={(e) => {
                      onCheckRisk(r.i, e.target.checked);
                    }}>我已了解</Checkbox>,
                  ]) : []}>
                  <Space>
                    <Tag color={SEVERITY_COLOR[r.severity]}>{r.severity}</Tag>
                    <span>{RISK_LABEL[r.type] ?? r.type}</span>
                    {r.refName && <Typography.Text type="secondary">{r.refName}</Typography.Text>}
                    {r.type === 'DATA_VOLUME' && <Typography.Text type="secondary">{r.count} 行</Typography.Text>}
                    {r.type === 'API_CONSUMER' && <Typography.Text type="secondary">{r.keyName} · 近30天 {r.calls30d} 次</Typography.Text>}
                  </Space>
                </List.Item>
              )} />
          </div>
        </div>
      )}
      {effMode === 'TYPE_MODEL_NAME' && (
        <div style={{ marginTop: 16 }}>
          <Typography.Paragraph type="danger">
            高风险操作：请输入完整模型名 <Typography.Text code>{modelName}</Typography.Text> 确认保存。
          </Typography.Paragraph>
          <Input value={modelNameInput} onChange={(e) => onModelNameInput(e.target.value)}
            placeholder={modelName} />
        </div>
      )}
      {effMode === 'CHECKBOX' && (
        <>
          <Typography.Paragraph type="warning" style={{ marginTop: 12 }}>
            含删除操作：须逐条确认全部 HIGH 风险后方可保存（删除字段为软删，可通过版本回滚恢复）。
          </Typography.Paragraph>
          {hasDelete && !severitySorted.some((r) => r.severity === 'HIGH') && (
            <Space style={{ marginTop: 4 }}>
              <Checkbox checked={checkedRisks.has(DELETE_ACK_IDX)} onChange={(e) => {
                onCheckRisk(DELETE_ACK_IDX, e.target.checked);
              }}>
                我确认删除上述字段（当前无 HIGH 级影响面，删除仍不可撤销——仅可回滚）
              </Checkbox>
            </Space>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------- 409 三方对比弹层 ----------

export function ConflictModal({
  open, onClose, server, rows, modelName, onDiscard,
}: {
  open: boolean;
  onClose: () => void;
  server: ModelDetail | null;
  rows: ConflictRow[];
  modelName: string;
  /** 显式放弃：以服务端态重建草稿（父级处理 details 回写）。 */
  onDiscard: (server: ModelDetail) => void;
}): React.ReactElement {
  return (
    <Modal title={`版本冲突 · ${modelName}（他人已保存 v${server?.currentVersion ?? '?'}）`}
      open={open} width={760} footer={null} onCancel={onClose}>
      <Typography.Paragraph type="warning">
        你与服务端基于不同版本做了修改。下方为逐字段对比（我的草稿 / 服务端最新）；
        选择「放弃我的修改」将以服务端最新覆盖本地草稿；关闭弹层可继续保留草稿查看。
      </Typography.Paragraph>
      <List size="small" style={{ maxHeight: 320, overflow: 'auto' }}
        locale={{ emptyText: '无字段级差异' }}
        dataSource={rows}
        renderItem={(row) => (
          <List.Item style={{ padding: '4px 0', background: row.bothChanged ? 'rgba(255,77,79,.06)' : undefined }}>
            <Space>
              <Tag color={row.bothChanged ? 'red' : 'blue'}>{row.bothChanged ? '双方修改' : '单方修改'}</Tag>
              <span>{row.fieldKey}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {'我的：'}{row.mine ? `${row.mine.op}` : '未改'}
                {' / '}
                {'服务端：'}{row.theirs ? `${row.theirs.op}` : '未改'}
              </Typography.Text>
            </Space>
          </List.Item>
        )} />
      <Space style={{ marginTop: 16 }}>
        <Button danger onClick={() => {
          // 显式放弃：以服务端态重建草稿（DELETED 字段带 _deleted——同 refreshDetail 形态，防复活误判）
          if (!server) return;
          onDiscard(server);
        }}>{'放弃我的修改（采用服务端）'}</Button>
        <Button onClick={onClose}>{'保留草稿，稍后处理'}</Button>
      </Space>
    </Modal>
  );
}

/** 放弃修改时按服务端态重建草稿字段（DELETED 带 _deleted 标记——防复活误判）。 */
export function adoptServerFields(server: ModelDetail): DraftField[] {
  return adoptServerDraft(server.fields).map((f) => ({
    ...f, ...(f.fieldStatus === 'DELETED' ? { _deleted: true } : {}),
  })) as DraftField[];
}

export function serverDraftOf(server: ModelDetail): DraftModel {
  return { detail: server, fields: adoptServerFields(server), baseFields: server.fields };
}

// ---------- 版本时间线抽屉 + 回滚 ----------

export function VersionsDrawer({
  open, onClose, versions, currentVersion, modelName,
  rollbackTarget, rollbackPre, rollbackPreFailed, rollbackConfirm, saving,
  onRollbackTarget, onRollbackConfirm, onRollbackSubmit, onRollbackRetry, onRollbackCancel,
}: {
  open: boolean;
  onClose: () => void;
  versions: VersionRow[] | null;
  currentVersion: number | null;
  modelName: string;
  rollbackTarget: number | null;
  rollbackPre: PrecheckResp | null;
  rollbackPreFailed: boolean;
  rollbackConfirm: string;
  saving: boolean;
  onRollbackTarget: (v: number) => void;
  onRollbackConfirm: (v: string) => void;
  onRollbackSubmit: () => void;
  onRollbackRetry: () => void;
  onRollbackCancel: () => void;
}): React.ReactElement {
  return (
    <Drawer title={`版本时间线 · ${modelName}`} width={440} open={open}
      destroyOnClose
      onClose={() => { onClose(); onRollbackCancel(); }}>
      {versions === null ? (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
      ) : (
        <>
          <Timeline
            items={versions.map((v) => ({
              color: v.rollbackFrom != null ? 'orange' : 'green',
              children: (
                <div>
                  <Space>
                    <Typography.Text strong>v{v.version}</Typography.Text>
                    {v.rollbackFrom != null && <Tag color="orange">回滚自 v{v.rollbackFrom}</Tag>}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {v.createdAt ?? ''} · 操作者 {v.operator}
                    </Typography.Text>
                  </Space>
                  <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 4 }}>
                    {(v.diffSummary ?? []).map((d, i) => `${d.op === 'ADD_FIELD' ? '+' : d.op === 'DELETE_FIELD' ? '-' : d.op === 'RESURRECT_FIELD' ? '↺' : '~'}${d.fieldKey}`).join('  ') || '（初始版本）'}
                  </div>
                  {currentVersion != null && v.version !== currentVersion && (
                    <Button size="small" danger style={{ marginTop: 6 }}
                      onClick={() => onRollbackTarget(v.version)}>
                      回滚到此版本
                    </Button>
                  )}
                </div>
              ),
            }))}
          />
          <Modal title={`回滚确认 · 目标 v${rollbackTarget ?? ''}`} open={rollbackTarget != null}
            onCancel={onRollbackCancel}
            okText="确认回滚" okButtonProps={{ danger: true, disabled: rollbackConfirm.trim() !== (modelName || '\0') || !rollbackPre, loading: saving }}
            onOk={onRollbackSubmit}>
            {/* 预检影响面先呈现（无风险也显式说明），用户知情后再输入模型名 */}
            {rollbackPre ? (
              <div style={{ marginBottom: 12 }}>
                <Typography.Text strong>回滚影响面（{rollbackPre.risks.length} 项）</Typography.Text>
                <List size="small" style={{ marginTop: 4, maxHeight: 160, overflow: 'auto' }}
                  locale={{ emptyText: '无风险项（字段定义还原，数据零操作）' }}
                  dataSource={rollbackPre.risks}
                  renderItem={(r) => (
                    <List.Item style={{ padding: '2px 0' }}>
                      <Space>
                        <Tag color={SEVERITY_COLOR[r.severity]}>{r.severity}</Tag>
                        <span>{RISK_LABEL[r.type] ?? r.type}</span>
                        {r.refName && <Typography.Text type="secondary">{r.refName}</Typography.Text>}
                      </Space>
                    </List.Item>
                  )} />
              </div>
            ) : rollbackPreFailed ? (
              <div style={{ marginBottom: 12 }}>
                <Typography.Text type="danger">回滚影响面获取失败——本地草稿未受影响，可重试。</Typography.Text>
                <Button size="small" style={{ marginTop: 8 }} loading={saving}
                  onClick={onRollbackRetry}>
                  重试获取影响面
                </Button>
              </div>
            ) : (
              <Typography.Text type="secondary">正在获取回滚影响面…</Typography.Text>
            )}
            <Typography.Paragraph type="danger">
              回滚将以新版本形式还原 v{rollbackTarget} 的字段定义（数据零操作）；
              此后版本的字段变更将被覆盖。请输入完整模型名 <Typography.Text code>{modelName}</Typography.Text> 确认。
            </Typography.Paragraph>
            <Input value={rollbackConfirm} onChange={(e) => onRollbackConfirm(e.target.value)}
              placeholder={modelName} />
          </Modal>
        </>
      )}
    </Drawer>
  );
}
