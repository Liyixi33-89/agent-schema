"""浏览器报告与同提交 CI 门禁；只读检查，不部署、不修改账号或业务数据。"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

REQUIRED_SMOKE = {
    'SMK-DES-01': ('designer.smoke.spec.ts', 'designer'),
    'SMK-RUN-01': ('runtime.smoke.spec.ts', 'runtime'),
    'SMK-ADM-01': ('admin-console.smoke.spec.ts', 'admin-console'),
}


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
            match = re.match(r'^(SMK-[A-Z]+-\d+)(?:\s|$)', case.get('name', ''))
            if not match or match[1] not in REQUIRED_SMOKE:
                continue
            scenario = match[1]
            if scenario in found:
                raise ValueError(f'重复必跑场景: {scenario}')
            file_name, project = REQUIRED_SMOKE[scenario]
            if case.get('classname') != file_name or suite.get('hostname') != project:
                raise ValueError(f'必跑场景项目或文件不匹配: {scenario}')
            found[scenario] = True
    missing = REQUIRED_SMOKE.keys() - found.keys()
    if missing:
        raise ValueError('必跑场景缺失: ' + ', '.join(sorted(missing)))
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
