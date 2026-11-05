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


def git_commit_all(repo, msg, paths=('.',)):
    """提交指定路径（默认全部）。测试需要局部提交时显式传 paths，
    避免把未跟踪的 .agent/workflow.json 误带入提交——后续 reset --hard
    到更早提交会把该文件当作「该提交才引入」而被整体删除。"""
    sh('git', 'add', *paths, cwd=repo)
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
        self.archive_dir = self.repo / 'docs' / 'acceptance' / 'WPX' / self.run_id
        manifest = json.loads((self.archive_dir / 'manifest.json').read_text(encoding='utf-8'))
        self.command = manifest['suites']['s1']['command']
        # 台账文件须先于 head_with_evidence 捕获落盘并提交——否则「仅证据提交」等用例
        # 的 reset --hard 会把它当「晚于基线才引入」而整体删除，污染后续依赖它的用例。
        self.write_ledger()
        self.head_with_evidence = sh('git', 'rev-parse', 'HEAD', cwd=self.repo).stdout.strip()

    def write_ledger(self, **task_override):
        task = {'id': 'WPX', 'title': 'WPX', 'status': 'accepted', 'priority': 0, 'dependsOn': [],
                'spec': 'x', 'acceptance': [{'id': 'crit', 'evidence': self.evidence()}],
                'review': self.review()}
        task.update(task_override)
        ledger = {'schemaVersion': 1, 'tasks': [task]}
        (self.repo / '.agent' / 'workflow.json').write_text(json.dumps(ledger, indent=2), encoding='utf-8')
        # 立即单独提交：避免后续测试用 `git add -A` 把它意外纳入其他提交，
        # 导致 reset --hard 到更早提交时把它当「该提交才引入」而整体删除。
        sh('git', 'add', '.agent/workflow.json', cwd=self.repo)
        sh('git', '-c', 'user.name=test', '-c', 'user.email=t@t', 'commit', '-m', 'ledger',
          '--allow-empty', cwd=self.repo, check=False)

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

    # ---------- 正式检查边界：环境变量不得改道正式入口 ----------

    def test_official_check_ignores_accept_evidence_env_override(self):
        # 正式校验必须命中仓库内真实归档；伪造的 ACCEPT_EVIDENCE_ARCHIVE 指向空目录不得被采用
        bogus = self.fx.tmp / 'bogus-archive'
        bogus.mkdir(exist_ok=True)
        os.environ['ACCEPT_EVIDENCE_ARCHIVE'] = str(bogus)
        os.environ['ACCEPT_EVIDENCE_OUT'] = str(bogus)
        try:
            issues = self.workflow.verify_commit(self.fx.evidence(), 'crit', 'WPX')
            self.assertEqual(issues, [], issues)
        finally:
            os.environ.pop('ACCEPT_EVIDENCE_ARCHIVE', None)
            os.environ.pop('ACCEPT_EVIDENCE_OUT', None)

    # ---------- 正式管线：归档完整性 + 台账引用检查 ----------

    def test_references_rejects_new_directory_missing_manifest(self):
        # 台账文件不受 git 版本控制（write_ledger 只写盘）；早先用例的 git reset --hard
        # 会把它当未跟踪产物一并清掉——每个依赖它的用例必须自行重建，不能假设仍存在。
        self.fx.write_ledger()
        ghost = self.fx.repo / 'docs' / 'acceptance' / 'WPX' / 'ghost-run'
        ghost.mkdir(parents=True)
        (ghost / 'notes.txt').write_text('no manifest here', encoding='utf-8')
        try:
            issues = self.workflow.check_references()
            self.assertTrue(any('Missing manifest' in i and 'ghost-run' in i for i in issues), issues)
        finally:
            shutil.rmtree(ghost, ignore_errors=True)

    def test_references_skips_legacy_directory(self):
        legacy = self.fx.repo / 'docs' / 'acceptance' / 'WPX' / 'legacy'
        legacy.mkdir(parents=True, exist_ok=True)
        (legacy / 'old.txt').write_text('no manifest, by design', encoding='utf-8')
        try:
            issues = self.workflow.check_references()
            self.assertFalse(any('legacy' in i for i in issues), issues)
        finally:
            shutil.rmtree(legacy, ignore_errors=True)

    def test_references_passes_for_legitimate_ledger(self):
        issues = self.workflow.check_references()
        self.assertEqual(issues, [], issues)

    def test_references_rejects_invalid_report_path(self):
        self.fx.write_ledger(acceptance=[{'id': 'crit', 'evidence': self.fx.evidence(report='../escape.md')}])
        try:
            issues = self.workflow.check_references()
            self.assertTrue(any('invalid report reference' in i for i in issues), issues)
        finally:
            self.fx.write_ledger()

    # ---------- 材料隔离：skipped 口径不得单独放行验收 ----------

    def test_fully_skipped_suite_cannot_certify(self):
        skip_run = node_cli('run', 'WPZ', 'sskip', '--', sys.executable, '-c', '0',
                            cwd=self.fx.repo, env=self.fx.env)
        self.assertEqual(skip_run.returncode, 0, skip_run.stderr)
        run_id = skip_run.stdout.strip().split('run=')[1].split()[0]
        run_dir = self.fx.tmp / 'out' / run_id
        (run_dir / 'sskip-result.json').write_text(
            json.dumps([{'name': 'n/a', 'pass': True, 'skipped': True}]), encoding='utf-8')
        # 父进程统计口径：全 skipped 时 passed 应为 0——重新触发一次统计写入由 CLI 自身完成，
        # 这里直接校验 manifest 落盘后的计数语义，避免重复实现统计逻辑。
        rerun = node_cli('run', 'WPZ', 'sskip2', '--reuse-run-id', run_id, '--', sys.executable, '-c',
                         "import json,os;rd=os.environ['ACCEPT_RUN_DIR'];s=os.environ['ACCEPT_SUITE'];"
                         "open(rd+'/'+s+'-result.json','w').write(json.dumps([{'name':'n/a','pass':True,'skipped':True}]))",
                         cwd=self.fx.repo, env=self.fx.env)
        self.assertEqual(rerun.returncode, 0, rerun.stderr)
        (run_dir / 'report.md').write_text('# skip', encoding='utf-8')
        arc = node_cli('archive', 'WPZ', run_id, '--files', 'sskip2-result.json', 'report.md',
                       cwd=self.fx.repo, env=self.fx.env)
        self.assertEqual(arc.returncode, 0, arc.stderr)
        manifest = json.loads((self.fx.repo / 'docs' / 'acceptance' / 'WPZ' / run_id / 'manifest.json')
                               .read_text(encoding='utf-8'))
        suite_stat = manifest['suites']['sskip2']
        self.assertEqual(suite_stat['passed'], 0, suite_stat)
        self.assertEqual(suite_stat['skipped'], 1, suite_stat)
        ev = self.fx.evidence(suite='sskip2', command=suite_stat['command'],
                              report=f'docs/acceptance/WPZ/{run_id}/report.md')
        issues = self.workflow.verify_commit(ev, 'crit', 'WPZ')
        self.assertTrue(any('failed/skipped suite' in i for i in issues), issues)


if __name__ == '__main__':
    unittest.main(verbosity=2)
