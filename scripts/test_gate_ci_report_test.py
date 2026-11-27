"""用 CI 实测的报告形态验证门禁识别（2026-11-27 漏判修复的最终确认）。

构造一份与 CI 一致的 JUnit 报告（describe 前缀 + 全 11 条 + 全通过），
断言 check_playwright 能识别全部必跑场景。
"""
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_gate as gate


# CI 实测的用例名形态（含 describe 前缀）——approval/trigger-flow 都嵌在 describe 里
DESCRIBE_PREFIX = {
    'SMK-FLOW-01': '流程编辑器闭环 › ',
    'SMK-FLOW-02': '流程编辑器闭环 › ',
    'SMK-FLOW-03': '流程编辑器闭环 › ',
    'SMK-APR-01': '审批中心 › ',
    'SMK-APR-02': '审批中心 › ',
    'SMK-TRF-01': 'TRIGGER_FLOW 动作消费 › ',
    'SMK-TRF-02': 'TRIGGER_FLOW 动作消费 › ',
    'SMK-TRF-03': 'TRIGGER_FLOW 动作消费 › ',
}


def ci_shaped_report():
    """复刻 CI 的报告：11 条全通过，名字带 describe 前缀。"""
    count = len(gate.REQUIRED_SMOKE)
    root = ET.Element('testsuites', tests=str(count), failures='0', errors='0', skipped='0')
    # 按文件分组（同一文件多条用例共用一个 suite，与 Playwright 输出一致）
    by_file: dict[str, tuple[str, list[str]]] = {}
    for scenario, (filename, project) in gate.REQUIRED_SMOKE.items():
        by_file.setdefault(filename, (project, []))[1].append(scenario)
    for filename, (project, scenarios) in by_file.items():
        suite = ET.SubElement(root, 'testsuite', name=filename, hostname=project,
                              tests=str(len(scenarios)))
        for scenario in scenarios:
            prefix = DESCRIBE_PREFIX.get(scenario, '')
            ET.SubElement(suite, 'testcase', name=f'{prefix}{scenario} 场景描述',
                          classname=filename)
    return root


class CiShapedReportTest(unittest.TestCase):
    def check(self, root):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'report.xml'
            ET.ElementTree(root).write(path, encoding='utf-8')
            return gate.check_playwright(path)

    def test_recognizes_all_scenarios_with_describe_prefix(self):
        """🔴 带 describe 前缀的用例名必须被识别（CI 漏判的直接原因）。"""
        self.assertEqual(self.check(ci_shaped_report()), len(gate.REQUIRED_SMOKE))

    def test_missing_scenario_reports_what_was_seen(self):
        """缺场景时错误信息要带上报告内容（含 hostname/用例名），便于排查。"""
        root = ci_shaped_report()
        # 删掉 APPROVAL 的 APR 用例
        for suite in root.iter('testsuite'):
            if suite.get('name') == 'approval.spec.ts':
                for case in [c for c in suite.findall('testcase')
                             if 'SMK-APR' in (c.get('name') or '')]:
                    suite.remove(case)
                suite.set('tests', str(len(suite.findall('testcase'))))
        root.set('tests', str(len(list(root.iter('testcase')))))

        with self.assertRaises(ValueError) as ctx:
            self.check(root)
        msg = str(ctx.exception)
        self.assertIn('必跑场景缺失', msg)
        self.assertIn('SMK-APR-01', msg)
        # 诊断信息应包含报告实际内容
        self.assertIn('报告实际内容', msg)
        self.assertIn('approval', msg)


if __name__ == '__main__':
    unittest.main()