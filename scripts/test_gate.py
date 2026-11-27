"""浏览器报告与同提交 CI 门禁；只读检查，不部署、不修改账号或业务数据。"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

REQUIRED_SMOKE = {
    # 三条原始场景：三个应用各自的「打开即能用」底线
    'SMK-DES-01': ('designer.smoke.spec.ts', 'designer'),
    'SMK-RUN-01': ('runtime.smoke.spec.ts', 'runtime'),
    'SMK-ADM-01': ('admin-console.smoke.spec.ts', 'admin-console'),
    # 流程编辑器（spec 022 T1/T2）：建流程 → 保存 → 发布 主链路
    'SMK-FLOW-01': ('flow-editor.spec.ts', 'flow-editor'),
    # 发布前置自检（审批人为空时禁用发布）——防「带病发布」
    'SMK-FLOW-02': ('flow-editor.spec.ts', 'flow-editor'),
    # 删除节点连带删边——防悬空边导致流程引擎启动失败
    'SMK-FLOW-03': ('flow-editor.spec.ts', 'flow-editor'),
    # 审批中心（spec 022 T3）：发起 → 待办 → 详情 → 办理 → 已办 全闭环
    'SMK-APR-01': ('approval.spec.ts', 'approval'),
    # 驳回必须填意见（前端拦截）
    'SMK-APR-02': ('approval.spec.ts', 'approval'),
    # TRIGGER_FLOW 动作消费（spec 022 T4）：提交后自动发起流程
    'SMK-TRF-01': ('trigger-flow.spec.ts', 'approval'),
    # A7 零行为回归：未配置 TRIGGER_FLOW 的表单提交后不得发起任何流程
    'SMK-TRF-02': ('trigger-flow.spec.ts', 'approval'),
    # A7 错误矩阵：重复发起被 INSTANCE_ALREADY_RUNNING 拦截
    'SMK-TRF-03': ('trigger-flow.spec.ts', 'approval'),
}


def _same_spec_file(classname, expected):
    """报告里的 classname 是否就是清单声明的测试文件。

    Playwright 的 junit reporter 在不同调用方式下 classname 形态不同：
      - `approval.spec.ts`（只给文件名）
      - `e2e/approval.spec.ts`（带目录）
      - `e2e\\approval.spec.ts`（Windows 分隔符）
      - `approval.spec.ts › 审批中心 › SMK-APR-01 …`（带 describe 层级）

    严格相等会让门禁因「路径写法不同」误报缺失——2026-11-27 CI 就因此
    报「必跑场景缺失」而实际 11 条全通过。这里按「末段文件名相同」判定。
    """
    if classname is None:
        return False
    # 取第一段（去掉 describe 层级），再取路径末段
    head = str(classname).split('›')[0].strip()
    tail = re.split(r'[/\\]', head)[-1].strip()
    return tail == expected


def check_playwright(path, not_before=None):
    report = Path(path)
    if not report.is_file():
        raise ValueError('Playwright 报告缺失')
    if not_before is not None and report.stat().st_mtime < not_before:
        raise ValueError('Playwright 报告早于本轮执行，不得复用旧报告')
    root = ET.parse(report).getroot()
    if root.tag != 'testsuites':
        raise ValueError('Playwright JUnit 根节点必须为 testsuites')
    suites = list(root.iter('testsuite'))
    cases = list(root.iter('testcase'))
    if not cases:
        raise ValueError('Playwright 零用例')
    for field in ('tests', 'failures', 'errors', 'skipped'):
        value = root.get(field)
        if value is None or not re.fullmatch(r'\d+', value):
            raise ValueError(f'报告缺少合法计数: {field}')
    if int(root.get('tests')) != len(cases):
        raise ValueError('报告测试计数与实际 testcase 数量不一致')
    if any(int(root.get(field)) for field in ('failures', 'errors', 'skipped')):
        raise ValueError('Playwright 存在失败、错误或跳过')
    found = {}
    for suite in suites:
        if int(suite.get('tests', '-1')) != len(suite.findall('testcase')):
            raise ValueError('测试文件计数不一致')
        if any(int(suite.get(field, '0')) for field in ('failures', 'errors', 'skipped')):
            raise ValueError('测试文件汇总包含失败、错误或跳过')
        for case in suite.findall('testcase'):
            if any(case.find(tag) is not None for tag in ('failure', 'error', 'skipped')):
                raise ValueError(f'场景未通过: {case.get("name")}')
            # 场景 ID 可能出现在用例名任意位置：
            #   未嵌套 describe → 'SMK-DES-01 登录后…'
            #   有 describe     → '审批中心 › SMK-APR-01 发起…'  ← 2026-11-27 CI 漏判的原因
            # 用非锚定匹配，取第一个出现的场景 ID。
            match = re.search(r'(SMK-[A-Z]+-\d+)', case.get('name', ''))
            if not match or match.group(1) not in REQUIRED_SMOKE:
                continue
            scenario = match.group(1)
            if scenario in found:
                raise ValueError(f'重复必跑场景: {scenario}')
            file_name, project = REQUIRED_SMOKE[scenario]
            if not _same_spec_file(case.get('classname'), file_name):
                raise ValueError(
                    f'必跑场景项目或文件不匹配: {scenario}'
                    f'（清单: {file_name}，报告: {case.get("classname")!r}）')
            if suite.get('hostname') != project:
                raise ValueError(
                    f'必跑场景项目不匹配: {scenario}'
                    f'（清单: {project}，报告: {suite.get("hostname")!r}）')
            found[scenario] = True
    missing = REQUIRED_SMOKE.keys() - found.keys()
    if missing:
        # 诊断：列出报告里实际识别到的场景与每个 suite 的 hostname/name，
        # 让「缺了什么 + 报告长什么样」同时可见。
        seen = []
        for suite in suites:
            names = [c.get('name', '')[:40] for c in suite.findall('testcase')]
            seen.append(f'  suite name={suite.get("name")!r} '
                        f'hostname={suite.get("hostname")!r} cases={names}')
        detail = '\n'.join(seen) if seen else '  （报告无任何 testsuite）'
        raise ValueError(
            '必跑场景缺失: ' + ', '.join(sorted(missing))
            + '\n报告实际内容:\n' + detail
            + '\n已识别到的场景: ' + (', '.join(sorted(found)) or '（无）'))
    return len(cases)


def workflow_state(runs, sha):
    # PR 的测试 SHA 可能是合并预览提交；发布只消费 push/手工实跑的同 SHA 结果。
    eligible = [run for run in runs if run.get('head_sha') == sha
                and run.get('event') in ('push', 'workflow_dispatch')]
    if not eligible:
        return 'pending', None
    latest = max(eligible, key=lambda run: (run['id'], run.get('run_attempt', 1)))
    if latest.get('status') != 'completed':
        return 'pending', latest
    return ('passed' if latest.get('conclusion') == 'success' else 'failed'), latest


def wait_for_ci(repo, sha, timeout=1200, interval=15):
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repo) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('仓库名或提交 SHA 无效')
    deadline = time.monotonic() + timeout
    while True:
        pending = []
        accepted = []
        for workflow in ('verify.yml', 'smoke.yml'):
            endpoint = f'repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&per_page=100'
            result = subprocess.run(['gh', 'api', endpoint], check=True, text=True,
                                    capture_output=True, timeout=30)
            state, run = workflow_state(json.loads(result.stdout)['workflow_runs'], sha)
            if state == 'failed':
                raise ValueError(f'{workflow} 同提交检查失败: {run.get("html_url")} ({run.get("conclusion")})')
            if state == 'pending':
                pending.append(workflow)
            else:
                accepted.append({'workflow': workflow, 'runId': run['id'],
                                 'attempt': run.get('run_attempt', 1), 'url': run.get('html_url')})
        if not pending:
            print(json.dumps({'sha': sha, 'checks': accepted}, ensure_ascii=False))
            return
        if time.monotonic() >= deadline:
            raise ValueError('等待同提交检查超时: ' + ', '.join(pending))
        print('等待检查: ' + ', '.join(pending), flush=True)
        time.sleep(min(interval, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    report = commands.add_parser('playwright')
    report.add_argument('report')
    report.add_argument('--not-before', type=float)
    ci = commands.add_parser('ci')
    ci.add_argument('--repo', required=True)
    ci.add_argument('--sha', required=True)
    ci.add_argument('--timeout', type=int, default=1200)
    args = parser.parse_args()
    try:
        if args.command == 'playwright':
            count = check_playwright(args.report, args.not_before)
            print(f'Playwright 门禁 PASS: {count} 项；全部必跑场景实际通过')
        else:
            wait_for_ci(args.repo, args.sha, args.timeout)
    except (ValueError, ET.ParseError, OSError, subprocess.SubprocessError, KeyError) as error:
        print(f'测试门禁 FAIL: {error}')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
