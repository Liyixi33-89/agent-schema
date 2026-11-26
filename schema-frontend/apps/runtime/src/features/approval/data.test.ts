/**
 * 审批中心数据层测试（spec 022 T3 / A5）。
 *
 * 覆盖：三种响应解析、字段名双形态兼容、节点状态折算、时间线过滤、
 * 耗时计算、错误码文案。全部纯函数——组件渲染正确性另由组件测试守。
 */
import { describe, expect, it } from 'vitest';
import {
  actionText, completeErrorText, durationOf, instanceStatusText, parseDone,
  parseInstanceDetail, parseTasks, toNodeStates, toTimeline, typeLabel,
  type InstanceDetail,
} from './data';

describe('parseTasks', () => {
  it('解析标准待办响应', () => {
    const raw = {
      list: [{
        taskId: 't1', instanceId: 'i1', nodeId: 'approval_1',
        nodeName: '主管审批', createdAt: '2026-11-26T14:13:23.018+08:00',
      }],
    };
    const tasks = parseTasks(raw);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: 't1', instanceId: 'i1', nodeName: '主管审批',
    });
  });

  it('空态与缺 list 都返回空数组（不抛异常）', () => {
    expect(parseTasks({ list: [] })).toEqual([]);
    expect(parseTasks({})).toEqual([]);
    expect(parseTasks(null)).toEqual([]);
  });

  it('过滤掉 taskId 为空的脏数据', () => {
    const raw = { list: [{ taskId: '', instanceId: 'i1' }, { taskId: 't2', instanceId: 'i2' }] };
    expect(parseTasks(raw)).toHaveLength(1);
    expect(parseTasks(raw)[0].taskId).toBe('t2');
  });
});

describe('parseDone', () => {
  it('解析 snake_case 字段（后端 JDBC 投影）', () => {
    const raw = {
      total: 1,
      list: [{
        task_id: 't1', instance_id: 'i1', node_id: 'approval_1',
        action: 'COMPLETE', comment: '同意', operated_at: '2026-11-26T15:00:00+08:00',
        model_id: 1, record_id: 99902, flow_def_id: 24, started_by: 1, status: 'FINISHED',
      }],
    };
    const { list, total } = parseDone(raw);
    expect(total).toBe(1);
    expect(list[0]).toMatchObject({
      taskId: 't1', action: 'COMPLETE', comment: '同意',
      modelId: 1, recordId: 99902, status: 'FINISHED',
    });
  });

  it('兼容 camelCase 字段', () => {
    const raw = { list: [{ taskId: 't2', instanceId: 'i2', action: 'REJECT' }] };
    expect(parseDone(raw).list[0].taskId).toBe('t2');
  });

  it('缺 total 时回退为列表长度', () => {
    expect(parseDone({ list: [{ task_id: 'a' }, { task_id: 'b' }] }).total).toBe(2);
  });

  it('空态', () => {
    expect(parseDone({ list: [], total: 0 })).toEqual({ list: [], total: 0 });
  });
});

describe('parseInstanceDetail', () => {
  const raw = {
    instanceId: 'i1', modelId: 1, recordId: 99902, status: 'RUNNING',
    startedBy: 1, startedAt: '2026-11-26T06:13:23.014+00:00',
    tasks: [],
    history: [
      { activityId: 'start_1', activityType: 'startEvent', startedAt: 'x', endedAt: 'y' },
      { activityId: 'approval_1', activityName: '主管审批', activityType: 'userTask',
        startedAt: 'x', endedAt: null },
      { activityId: 'edge_1', activityType: 'sequenceFlow', startedAt: 'x', endedAt: 'y' },
    ],
  };

  it('解析实例基本信息与 history', () => {
    const d = parseInstanceDetail(raw)!;
    expect(d.instanceId).toBe('i1');
    expect(d.status).toBe('RUNNING');
    expect(d.history).toHaveLength(3);
  });

  it('缺 instanceId 返回 null', () => {
    expect(parseInstanceDetail({})).toBeNull();
    expect(parseInstanceDetail(null)).toBeNull();
  });
});

describe('toNodeStates（节点着色）', () => {
  const base: InstanceDetail = {
    instanceId: 'i1', modelId: 1, recordId: 1, flowDefId: 24, status: 'RUNNING',
    startedBy: 1, startedAt: '', tasks: [],
    history: [
      { activityId: 'start_1', activityName: null, activityType: 'startEvent',
        assignee: null, startedAt: 'a', endedAt: 'b' },
      { activityId: 'approval_1', activityName: '审批', activityType: 'userTask',
        assignee: null, startedAt: 'a', endedAt: null },
      { activityId: 'edge_1', activityName: null, activityType: 'sequenceFlow',
        assignee: null, startedAt: 'a', endedAt: 'b' },
    ],
  };

  it('已结束节点 DONE，当前节点 ACTIVE', () => {
    const states = toNodeStates(base);
    expect(states).toContainEqual({ nodeId: 'start_1', state: 'DONE' });
    expect(states).toContainEqual({ nodeId: 'approval_1', state: 'ACTIVE' });
  });

  it('过滤 sequenceFlow（边不是节点）', () => {
    const states = toNodeStates(base);
    expect(states.some((s) => s.nodeId === 'edge_1')).toBe(false);
  });

  it('实例已结束时未完成节点标 SKIPPED（未走的分支）', () => {
    const finished: InstanceDetail = { ...base, status: 'FINISHED' };
    const states = toNodeStates(finished);
    expect(states).toContainEqual({ nodeId: 'approval_1', state: 'SKIPPED' });
  });
});

describe('toTimeline', () => {
  const detail: InstanceDetail = {
    instanceId: 'i1', modelId: 1, recordId: 1, flowDefId: 24, status: 'RUNNING',
    startedBy: 1, startedAt: '', tasks: [],
    history: [
      { activityId: 'start_1', activityName: null, activityType: 'startEvent',
        assignee: null, startedAt: '2026-11-26T10:00:00Z', endedAt: '2026-11-26T10:00:05Z' },
      { activityId: 'edge_1', activityName: null, activityType: 'sequenceFlow',
        assignee: null, startedAt: 'a', endedAt: 'b' },
      { activityId: 'approval_1', activityName: '主管审批', activityType: 'userTask',
        assignee: 1, startedAt: '2026-11-26T10:00:05Z', endedAt: null },
    ],
  };

  it('只保留节点轨迹（过滤连线）', () => {
    const tl = toTimeline(detail);
    expect(tl).toHaveLength(2);
    expect(tl.map((t) => t.activityId)).toEqual(['start_1', 'approval_1']);
  });

  it('无 activityName 时用类型中文名兜底', () => {
    const tl = toTimeline(detail);
    expect(tl[0].label).toBe('开始');
    expect(tl[1].label).toBe('主管审批');
  });

  it('状态与耗时正确', () => {
    const tl = toTimeline(detail);
    expect(tl[0].state).toBe('DONE');
    expect(tl[0].durationText).toBe('5 秒');
    expect(tl[1].state).toBe('ACTIVE');
    expect(tl[1].durationText).toBe('');
  });
});

describe('durationOf', () => {
  it('各量级', () => {
    const t = (s: number) => `2026-11-26T10:00:${String(s).padStart(2, '0')}Z`;
    expect(durationOf(t(0), t(30))).toBe('30 秒');
    expect(durationOf('2026-11-26T10:00:00Z', '2026-11-26T10:05:00Z')).toBe('5 分钟');
    expect(durationOf('2026-11-26T10:00:00Z', '2026-11-26T12:00:00Z')).toBe('2 小时');
    expect(durationOf('2026-11-26T00:00:00Z', '2026-11-28T00:00:00Z')).toBe('2 天');
  });

  it('缺端点或负时长返回空串', () => {
    expect(durationOf(null, 'x')).toBe('');
    expect(durationOf('2026-11-26T10:00:00Z', null)).toBe('');
    expect(durationOf('2026-11-26T12:00:00Z', '2026-11-26T10:00:00Z')).toBe('');
  });
});

describe('文案映射', () => {
  it('实例状态', () => {
    expect(instanceStatusText('RUNNING')).toBe('进行中');
    expect(instanceStatusText('FINISHED')).toBe('已办结');
    expect(instanceStatusText('SUSPENDED')).toBe('已挂起');
    expect(instanceStatusText('UNKNOWN_X')).toBe('UNKNOWN_X');
  });

  it('动作', () => {
    expect(actionText('COMPLETE')).toBe('同意');
    expect(actionText('REJECT')).toBe('驳回');
    expect(actionText('AUTO')).toBe('系统挂起');
  });

  it('节点类型', () => {
    expect(typeLabel('startEvent')).toBe('开始');
    expect(typeLabel('userTask')).toBe('审批');
    expect(typeLabel('weird')).toBe('weird');
  });

  it('办理错误码（A7 矩阵）', () => {
    expect(completeErrorText('TASK_NOT_ASSIGNED', 'x')).toContain('未指派');
    expect(completeErrorText('TASK_ALREADY_COMPLETED', 'x')).toContain('已被处理');
    expect(completeErrorText('COMMENT_REQUIRED', 'x')).toContain('审批意见');
    // 未知码保留后端原文
    expect(completeErrorText('WEIRD_CODE', '后端原文')).toBe('后端原文');
  });
});