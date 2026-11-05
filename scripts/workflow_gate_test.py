"""workflow.py 台账门禁真实测试：临时 Git 仓库 + 真实 evidence CLI 归档。

覆盖 P0/P2 台账层拒绝路径：
- 合法证据全链通过（真实 CLI run → archive → workflow verify_commit 无 issue）
- 独立评审未批准拒绝；review 缺失拒绝
- 源码提交无效/非祖先拒绝
- sourceCommit 后实现改动 → 证据失效拒绝
- 仅提交证据文件（非实现路径）→ 不误失效
- legacy 材料/路径逃逸报告拒绝
- 失败套件（exitCode≠0 / failed>0）不能支撑验收
- 借用其他工作包证据拒绝

运行：python -m pytest scripts/workflow_gate_test.py -q  或  python scripts/workflow_gate_test.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_CLI = REPO_ROOT / 'scripts' / 'acceptance' / 'evidence.cjs'
sys.path.insert(0, str(REPO_ROOT / 'scripts'))


def sh(*args, cwd, check=True, env=None):
    proc = subprocess.run(list(args), cwd=str(cwd), capture_output=True, text=True,
                           env={**os.environ, **(env or {})})
    if check and proc.returncode != 0:
        raise RuntimeError(f'{args} failed: {proc.stderr}')
    return proc


def node_cli(*args, cwd, env=None, check=False):
    return sh('node', str(EVIDENCE_CLI), *[str(a) for a in args], cwd=cwd, check=check, env=env)


def git_commit_all(repo, msg):
    sh('git', 'add', '-A', cwd=repo)
    sh('git', '-c', 'user.name=test', '-c', 'user.email=t@t', 'commit', '-m', msg, cwd=repo)
    return sh('git', 'rev-parse', 'HEAD', cwd=repo).stdout.strip()


class GateFixture:
    """临时 Git 仓库 + 一轮真实证据运行与归档。"""

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='wf-gate-'))
        self.repo = self.tmp / 'repo'
        (self.repo / 'scripts').mkdir(parents=True)
        (self.repo / '.agent').mkdir()
        sh('git', 'init', '-q', cwd=self.repo)
        # evidence 工具与实现路径占位（scripts 计入 IMPLEMENTATION_PATHS）
        shutil.copy(REPO_ROOT / 'scripts' / 'workflow.py', self.repo / 'scripts' / 'workflow.py')
        (self.repo / 'scripts' / 'acceptance').mkdir()
        shutil.copy(EVIDENCE_CLI, self.repo / 'scripts' / 'acceptance' / 'evidence.cjs')
        # 实现/测试路径占位——后续改动此文件用于「源码漂移」用例
        (self.repo / 'schema-frontend').mkdir()
        (self.repo / 'schema-frontend' / 'a.txt').write_text('v1', encoding='utf-8')
        self.source_commit = git_commit_all(self.repo, 'source')
        # 真实跑一轮成功套件并归档（归档根必须在仓库内——台账只认 docs/acceptance/）
        self.env = {'ACCEPT_EVIDENCE_OUT': str(self.tmp / 'out'),
                    'ACCEPT_EVIDENCE_ARCHIVE': str(self.repo / 'docs' / 'acceptance'),
                    'SCHEMA_EVIDENCE_ROOT': str(self.repo)}
        good = node_cli('run', 'WPX', 's1', '--', sys.executable, '-c',
                        "import json,os;rd=os.environ['ACCEPT_RUN_DIR'];s=os.environ['ACCEPT_SUITE'];"
                        "open(rd+'/'+s+'-result.json','w').write(json.dumps([{'name':'a','pass':True}]));"
                        "run=json.load(open(rd+'/run.json'));"
                        "run['suites'][s]={**run['suites'].get(s,{}),'passed':1,'failed':0,'skipped':0};"
                        "open(rd+'/run.json','w').write(json.dumps(run,indent=2))",
                        cwd=self.repo, env=self.env)
        assert good.returncode == 0, good.stderr
        self.run_id = good.stdout.strip().split('run=')[1].split()[0]
        run_dir = self.tmp / 'out' / self.run_id
        # report.md 必须归档（台账引用它且 manifest.files 覆盖它）
        report = run_dir / 'report.md'
        report.write_text('# WPX 验收报告\n结论：PASS', encoding='utf-8')
        arc = node_cli('archive', 'WPX', self.run_id, '--files', 's1-result.json', 'report.md',
                       cwd=self.repo, env=self.env)
        assert arc.returncode == 0, arc.stderr
        # 归档即提交——后续用例的 git reset --hard 不得波及证据目录
        git_commit_all(self.repo, 'archive evidence')
        self.head_with_evidence = sh('git', 'rev-parse', 'HEAD', cwd=self.repo).stdout.strip()
        self.archive_dir = self.repo / 'docs' / 'acceptance' / 'WPX' / self.run_id
        manifest = json.loads((self.archive_dir / 'manifest.json').read_text(encoding='utf-8'))
        self.command = manifest['suites']['s1']['command']

    def evidence(self, **over):
        base = {'commit': self.source_commit, 'command': self.command,
                'report': f'docs/acceptance/WPX/{self.run_id}/report.md',
                'suite': 's1', 'passed': True}
        base.update(over)
        return base

    def review(self, **over):
        base = {'commit': self.source_commit, 'approved': True, 'reviewer': 'rev',
                'report': f'docs/acceptance/WPX/{self.run_id}/report.md'}
        base.update(over)
        return base

    def verify(self, record, label='crit', work_package='WPX'):
        import workflow
        return workflow.verify_commit(record, label, work_package)

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class WorkflowGateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = GateFixture()
        # 测试根须同时让 workflow.py 与 evidence CLI 认同一个临时仓库
        os.environ['SCHEMA_WORKFLOW_ROOT'] = str(cls.fx.repo)
        os.environ['SCHEMA_EVIDENCE_ROOT'] = str(cls.fx.repo)
        for mod in [m for m in list(sys.modules) if m == 'workflow']:
            del sys.modules[mod]
        import workflow
        cls.workflow = workflow

    @classmethod
    def tearDownClass(cls):
        os.environ.pop('SCHEMA_WORKFLOW_ROOT', None)
        os.environ.pop('SCHEMA_EVIDENCE_ROOT', None)
        cls.fx.cleanup()

    def setUp(self):
        # 每个用例重载 workflow 模块，ROOT 绑定当前环境变量
        for mod in [m for m in list(sys.modules) if m == 'workflow']:
            del sys.modules[mod]
        import workflow
        self.workflow = workflow

    # ---------- 全链通过 ----------

    def test_legitimate_evidence_passes(self):
        issues = self.workflow.verify_commit(self.fx.evidence(), 'crit', 'WPX')
        self.assertEqual(issues, [], issues)

    # ---------- P0 拒绝路径 ----------

    def test_review_not_approved_rejected(self):
        issues = self.workflow.verify_commit(self.fx.review(approved=False), 'review', 'WPX')
        # review 记录本身结构合法（不含 suite 校验），批准与否由 audit() 把关——此处结构应通过
        self.assertEqual(issues, [], issues)
        # audit 层：未批准必须出现在 issues
        task = {'id': 'WPX', 'acceptance': [], 'review': self.fx.review(approved=False)}
        audit_issues = [i for i in self.call_audit(task) if 'not explicitly approved' in i]
        self.assertTrue(audit_issues)

    def test_invalid_sha_rejected(self):
        issues = self.workflow.verify_commit(self.fx.evidence(commit='deadbeef'), 'crit', 'WPX')
        self.assertTrue(any('invalid full source SHA' in i for i in issues), issues)

    def test_unknown_commit_rejected(self):
        fake = 'f' * 40
        issues = self.workflow.verify_commit(self.fx.evidence(commit=fake), 'crit', 'WPX')
        self.assertTrue(any('missing or not HEAD ancestor' in i for i in issues), issues)

    def test_failed_suite_cannot_certify(self):
        # 独立跑一轮失败套件并归档（新 run），不能支撑验收
        bad = node_cli('run', 'WPY', 'sfail', '--', sys.executable, '-c', 'raise SystemExit(9)',
                       cwd=self.fx.repo, env=self.fx.env)
        self.assertEqual(bad.returncode, 9)
        bad_run_id = bad.stdout.strip().split('run=')[1].split()[0]
        bad_run_dir = self.fx.tmp / 'out' / bad_run_id
        # 失败套件也要有结果文件（如实记录失败断言）——真实验收脚本始终写结果
        (bad_run_dir / 'sfail-result.json').write_text(
            json.dumps([{'name': 'always-fail', 'pass': False}]), encoding='utf-8')
        (bad_run_dir / 'report.md').write_text('# fail', encoding='utf-8')
        arc = node_cli('archive', 'WPY', bad_run_id, '--files', 'sfail-result.json', 'report.md',
                       cwd=self.fx.repo, env=self.fx.env)
        self.assertEqual(arc.returncode, 0, arc.stderr)
        manifest = json.loads((self.fx.repo / 'docs' / 'acceptance' / 'WPY' / bad_run_id / 'manifest.json')
                               .read_text(encoding='utf-8'))
        bad_cmd = manifest['suites']['sfail']['command']
        ev = self.fx.evidence(suite='sfail', command=bad_cmd, passed=True,
                              report=f'docs/acceptance/WPY/{bad_run_id}/report.md')
        issues = self.workflow.verify_commit(ev, 'crit', 'WPY')
        self.assertTrue(any('failed/skipped suite' in i for i in issues), issues)

    def test_work_package_mismatch_rejected(self):
        issues = self.workflow.verify_commit(self.fx.evidence(), 'crit', 'OTHER')
        self.assertTrue(any('work package mismatch' in i for i in issues), issues)

    def test_command_mismatch_rejected(self):
        issues = self.workflow.verify_commit(self.fx.evidence(command='evil --different'), 'crit', 'WPX')
        self.assertTrue(any('command mismatch' in i for i in issues), issues)

    def test_legacy_report_rejected(self):
        issues = self.workflow.verify_commit(
            self.fx.evidence(report='docs/acceptance/WPX/legacy/old.md'), 'crit', 'WPX')
        self.assertTrue(any('legacy' in i for i in issues), issues)

    def test_escape_report_rejected(self):
        issues = self.workflow.verify_commit(
            self.fx.evidence(report='../../outside.md'), 'crit', 'WPX')
        self.assertTrue(any('outside acceptance archive' in i for i in issues), issues)

    def test_report_not_in_manifest_rejected(self):
        # 报告存在但不在 manifest.files 哈希清单内（绕过归档塞入）
        self.assertTrue(self.fx.archive_dir.is_dir(), '证据归档目录必须存在')
        smuggled = self.fx.archive_dir / 'smuggled.md'
        smuggled.write_text('x', encoding='utf-8')
        try:
            issues = self.workflow.verify_commit(
                self.fx.evidence(report=f'docs/acceptance/WPX/{self.fx.run_id}/smuggled.md'), 'crit', 'WPX')
            self.assertTrue(any('not covered by manifest hashes' in i for i in issues), issues)
        finally:
            smuggled.unlink(missing_ok=True)

    # ---------- 源码漂移 ----------

    def test_implementation_change_invalidates_evidence(self):
        (self.fx.repo / 'schema-frontend' / 'a.txt').write_text('v2', encoding='utf-8')
        git_commit_all(self.fx.repo, 'implementation change')
        issues = self.workflow.verify_commit(self.fx.evidence(), 'crit', 'WPX')
        self.assertTrue(any('implementation changed since sourceCommit' in i for i in issues), issues)
        # 还原：回到证据提交点保持后续用例干净
        sh('git', 'reset', '--hard', self.fx.head_with_evidence, cwd=self.fx.repo)

    def test_evidence_only_commit_does_not_invalidate(self):
        # 只提交证据目录文件（docs/ 不在 IMPLEMENTATION_PATHS）→ 不误失效
        (self.fx.repo / 'docs' / 'extra-note.md').write_text('note', encoding='utf-8')
        git_commit_all(self.fx.repo, 'evidence-only change')
        issues = self.workflow.verify_commit(self.fx.evidence(), 'crit', 'WPX')
        self.assertEqual(issues, [], issues)
        sh('git', 'reset', '--hard', self.fx.head_with_evidence, cwd=self.fx.repo)

    # ---------- audit 层 ----------

    def call_audit(self, task):
        return self.workflow.audit(task)

    def test_audit_requires_reviewer_and_evidence(self):
        task = {'id': 'WPX', 'acceptance': [{'id': 'c1', 'evidence': None}], 'review': None}
        issues = self.call_audit(task)
        self.assertTrue(any('missing evidence' in i for i in issues))
        self.assertTrue(any('Missing independent review' in i for i in issues))

    def test_audit_rejects_unpassed_evidence(self):
        task = {'id': 'WPX', 'acceptance': [{'id': 'c1', 'evidence': self.fx.evidence(passed=False)}],
                'review': self.fx.review()}
        issues = self.call_audit(task)
        self.assertTrue(any('missing successful command record' in i for i in issues),
                        issues)

if __name__ == '__main__':
    unittest.main(verbosity=2)
