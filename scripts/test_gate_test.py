"""测试门禁的正负例；合成报告和模拟 Actions 响应，不访问服务器。"""
from pathlib import Path
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import test_gate as gate


def report_xml():
    # 场景数由 REQUIRED_SMOKE 动态决定（清单随功能增长，硬编码会立刻失效）
    count = len(gate.REQUIRED_SMOKE)
    root = ET.Element('testsuites', tests=str(count), failures='0', errors='0', skipped='0')
    for scenario, (filename, project) in gate.REQUIRED_SMOKE.items():
        suite = ET.SubElement(root, 'testsuite', name=filename, hostname=project, tests='1')
        ET.SubElement(suite, 'testcase', name=scenario + ' 场景', classname=filename)
    return root


class ReportGateTest(unittest.TestCase):
    def check(self, root, not_before=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.xml'
            ET.ElementTree(root).write(path, encoding='utf-8')
            return gate.check_playwright(path, not_before)

    def test_valid_report(self):
        self.assertEqual(self.check(report_xml()), len(gate.REQUIRED_SMOKE))

    def test_missing_stale_and_broken_report(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.xml'
            with self.assertRaises(ValueError):
                gate.check_playwright(path)
            path.write_text('<broken')
            with self.assertRaises(ET.ParseError):
                gate.check_playwright(path)
        with self.assertRaises(ValueError):
            self.check(report_xml(), float('inf'))

    def test_failed_skipped_error_cases(self):
        for status in ('failure', 'skipped', 'error'):
            with self.subTest(status=status):
                root = report_xml()
                ET.SubElement(root.find('testsuite/testcase'), status)
                with self.assertRaises(ValueError):
                    self.check(root)

    def test_suite_failure_count_cannot_hide_behind_green_root(self):
        root = report_xml()
        root.find('testsuite').set('failures', '1')
        with self.assertRaises(ValueError):
            self.check(root)

    def test_missing_duplicate_wrong_project_and_bad_counts(self):
        for fault in ('missing', 'duplicate', 'project', 'count', 'focused', 'zero'):
            with self.subTest(fault=fault):
                root = report_xml()
                case = root.find('testsuite/testcase')
                if fault == 'missing':
                    case.set('name', 'OTHER 场景')
                elif fault == 'duplicate':
                    root.findall('testsuite/testcase')[1].set('name', case.get('name'))
                elif fault == 'project':
                    root.find('testsuite').set('hostname', 'other')
                elif fault == 'count':
                    root.set('tests', '99')
                elif fault == 'focused':
                    case.set('name', 'SMK-DES-010 场景')
                else:
                    root.clear()
                with self.assertRaises(ValueError):
                    self.check(root)


class CiGateTest(unittest.TestCase):
    sha = 'a' * 40

    def run_info(self, **overrides):
        return dict(id=10, head_sha=self.sha, event='push', status='completed',
                    conclusion='success', run_attempt=1, html_url='test-url', **overrides)

    def test_only_same_sha_actual_runs_count(self):
        run = self.run_info()
        self.assertEqual(gate.workflow_state([run], self.sha)[0], 'passed')
        self.assertEqual(gate.workflow_state([run], 'b' * 40)[0], 'pending')
        run['event'] = 'pull_request'
        self.assertEqual(gate.workflow_state([run], self.sha)[0], 'pending')

    def test_latest_rerun_must_pass(self):
        passed = self.run_info()
        rerun = dict(passed, run_attempt=2, conclusion='failure')
        self.assertEqual(gate.workflow_state([passed, rerun], self.sha)[0], 'failed')
        running = dict(passed, id=11, status='in_progress', conclusion=None)
        self.assertEqual(gate.workflow_state([passed, running], self.sha)[0], 'pending')

    def test_both_workflows_required(self):
        completed = subprocess.CompletedProcess([], 0, json.dumps({'workflow_runs': [self.run_info()]}))
        with patch('test_gate.subprocess.run', return_value=completed) as api:
            gate.wait_for_ci('owner/repo', self.sha, timeout=0)
        self.assertEqual(api.call_count, 2)
        self.assertIn('verify.yml', api.call_args_list[0].args[0][2])
        self.assertIn('smoke.yml', api.call_args_list[1].args[0][2])

    def test_missing_failed_api_and_invalid_sha_fail(self):
        empty = subprocess.CompletedProcess([], 0, '{"workflow_runs":[]}')
        with patch('test_gate.subprocess.run', return_value=empty):
            with self.assertRaises(ValueError):
                gate.wait_for_ci('owner/repo', self.sha, timeout=0)
        failed = subprocess.CompletedProcess([], 0, json.dumps({'workflow_runs': [dict(self.run_info(), conclusion='cancelled')]}))
        with patch('test_gate.subprocess.run', return_value=failed):
            with self.assertRaises(ValueError):
                gate.wait_for_ci('owner/repo', self.sha, timeout=0)
        with patch('test_gate.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'gh')):
            with self.assertRaises(subprocess.CalledProcessError):
                gate.wait_for_ci('owner/repo', self.sha)
        with self.assertRaises(ValueError):
            gate.wait_for_ci('owner/repo', 'master')


def test_spec_file_name_tolerates_path_variants():
    """classname 的路径写法差异不得导致「必跑场景缺失」（2026-11-27 CI 实际问题）。

    Playwright junit reporter 在不同调用方式/平台上给出不同 classname 形态：
    只有文件名、带 e2e/ 前缀、Windows 反斜杠、带 describe 层级。
    严格相等会让门禁误报——CI 上 11 条全通过却报「缺失」。
    """
    same = gate._same_spec_file
    expected = 'approval.spec.ts'
    for variant in (
        'approval.spec.ts',
        'e2e/approval.spec.ts',
        'e2e\\approval.spec.ts',
        'approval.spec.ts › 审批中心',
        'e2e/approval.spec.ts › 审批中心 › SMK-APR-01 发起',
    ):
        assert same(variant, expected), f'{variant!r} 应识别为 {expected}'

    # 不同文件不得误判为同一文件
    assert not same('trigger-flow.spec.ts', expected)
    assert not same('e2e/trigger-flow.spec.ts', expected)
    assert not same(None, expected)
    assert not same('', expected)


if __name__ == '__main__':
    unittest.main()
