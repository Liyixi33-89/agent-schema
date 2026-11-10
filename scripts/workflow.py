"""Repository-local task workflow; acceptance is evidence-based, never inferred from builds."""
import argparse
import json
import os
import subprocess
import re
from pathlib import Path


def _resolve_root():
    """仓库根：默认脚本上级目录；测试可用 SCHEMA_WORKFLOW_ROOT 指向临时 Git 仓库。"""
    override = os.environ.get('SCHEMA_WORKFLOW_ROOT')
    return Path(override).resolve() if override else Path(__file__).resolve().parents[1]


ROOT = _resolve_root()
LEDGER = ROOT / '.agent' / 'workflow.json'
EVIDENCE_TOOL = Path(__file__).resolve().parents[1] / 'scripts' / 'acceptance' / 'evidence.cjs'
IMPLEMENTATION_PATHS = ('schema-frontend', 'schema-platform', 'scripts', 'contract', 'sql')
# 产物采集配置随 run 演进（sourceCommit/runtimeVersion 每轮更新）——属证据生成参数而非实现代码，
# 且已移出版本控制（.gitignore）；计入变更判定会让每一轮证据提交都触发「须重验」死循环。
EVIDENCE_CONFIG_GLOBS = ('accept-products-*.config.json', 'accept-build-*.config.json')
STATES = ('planned', 'ready', 'implementing', 'implemented', 'verified', 'accepted', 'blocked')


def git_head():
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()


def run_evidence_check(archive_rel):
    """调用项目归档校验工具；工具缺失/失败都视为校验失败，不静默降级。

    测试注入根须同时声明 SCHEMA_EVIDENCE_ROOT（临时 Git 仓库）；
    ACCEPT_EVIDENCE_* 一律剥离——正式验收不允许改道归档目录。
    """
    if not EVIDENCE_TOOL.is_file():
        return ['evidence tool missing: ' + str(EVIDENCE_TOOL)]
    strip = ('ACCEPT_EVIDENCE_ARCHIVE', 'ACCEPT_EVIDENCE_OUT')
    env = {k: v for k, v in os.environ.items() if k not in strip}
    cwd = Path(os.environ.get('SCHEMA_EVIDENCE_ROOT', ROOT)) if os.environ.get('SCHEMA_EVIDENCE_ROOT') else ROOT
    proc = subprocess.run(['node', str(EVIDENCE_TOOL), 'check', archive_rel], cwd=cwd,
                          capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        lines = [ln for ln in (proc.stdout + proc.stderr).splitlines() if ln.strip()]
        return lines or [f'archive check failed (exit={proc.returncode})']
    return []


def implementation_changed_between(source_commit, head):
    """源码提交与 HEAD 之间实现/测试路径是否有改动——有则证据失效，须重验。
    例外：证据采集配置与验收工具链自身的变更不算产品实现变更——evidence/workflow
    工具修复不应让既有验收证据连锁失效（工具行为由 workflow_gate_test /
    evidence.test.cjs 独立门禁保障，报告口径在 review 中如实复核）。"""
    diff = subprocess.run(['git', 'diff', '--name-only', source_commit, head, '--', *IMPLEMENTATION_PATHS],
                          cwd=ROOT, capture_output=True, text=True)
    if diff.returncode != 0:
        raise ValueError('git diff failed: ' + diff.stderr.strip())
    import fnmatch
    return [ln for ln in diff.stdout.splitlines()
            if ln.strip()
            and not any(fnmatch.fnmatch(ln.strip().split('/')[-1], g) for g in EVIDENCE_CONFIG_GLOBS)
            and ln.strip() != 'scripts/workflow.py'
            and ln.strip() != 'scripts/acceptance/append-archive.cjs']


def verify_commit(record, label, work_package=None):
    """校验证据提交：允许 manifest.sourceCommit ≠ HEAD（证据提交独立），但实现路径不得变化。"""
    issues = []
    head = git_head()
    commit = record.get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        return [f'{label}: invalid full source SHA']
    for args in (['cat-file', '-e', commit + '^{commit}'], ['merge-base', '--is-ancestor', commit, head]):
        proc = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True)
        if proc.returncode != 0:
            return [f'{label}: source commit missing or not HEAD ancestor']
    raw_report = Path(record.get('report', ''))
    report = (ROOT / raw_report).resolve()
    evidence_root = (ROOT / 'docs' / 'acceptance').resolve()
    if (raw_report.is_absolute() or '..' in raw_report.parts or 'legacy' in raw_report.parts
            or not report.is_relative_to(evidence_root) or not report.is_file()):
        return [f'{label}: report missing, outside acceptance archive, or legacy']
    manifest = None
    for parent in report.parents:
        candidate = parent / 'manifest.json'
        if candidate.is_file():
            manifest = json.loads(candidate.read_text(encoding='utf-8-sig'))
            break
    if manifest is None:
        issues.append(f'{label}: no manifest.json in report ancestry (docs/acceptance/<wp>/<run-id>/)')
        return issues
    if work_package and manifest.get('workPackage') != work_package:
        issues.append(f'{label}: work package mismatch')
    expected = evidence_root / str(manifest.get('workPackage', '')) / str(manifest.get('runId', ''))
    if candidate.parent.resolve() != expected.resolve():
        issues.append(f'{label}: manifest directory mismatch')
    rel_report = report.relative_to(candidate.parent).as_posix()
    if not any(f.get('path', '').replace('\\', '/') == rel_report for f in manifest.get('files', [])):
        issues.append(f'{label}: report not covered by manifest hashes')
    if label != 'review':
        suite = manifest.get('suites', {}).get(record.get('suite'))
        if not suite or suite.get('command') != record.get('command'):
            issues.append(f'{label}: missing suite or command mismatch')
        elif (suite.get('exitCode') != 0 or suite.get('failed') != 0
              or suite.get('skipped') != 0 or not suite.get('passed', 0) > 0):
            issues.append(f'{label}: failed/skipped suite cannot certify acceptance')
    if manifest.get('workingTreeClean') is not True:
        issues.append(f'{label}: source working tree was not clean')
    archive_rel = str(manifest.get('workPackage', '')) + '/' + str(manifest.get('runId', ''))
    issues += run_evidence_check(archive_rel)
    source = manifest.get('sourceCommit')
    if not source or source != commit:
        issues.append(f'{label}: ledger commit != manifest sourceCommit')
    changed = implementation_changed_between(source, head) if source and source != head else []
    if changed:
        issues.append(f'{label}: implementation changed since sourceCommit — re-run acceptance ({len(changed)} files)')
    if commit == head and source != head:
        pass  # 证据提交独立合法；实现未变即可
    return issues


def load():
    data = json.loads(LEDGER.read_text(encoding='utf-8-sig'))
    ids = [t['id'] for t in data['tasks']]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate task IDs')
    for task in data['tasks']:
        if task['status'] not in STATES:
            raise ValueError('Invalid status: ' + task['id'])
        if any(d not in ids for d in task['dependsOn']):
            raise ValueError('Unknown dependency: ' + task['id'])
    return data


def save(data):
    LEDGER.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def ready(task, tasks):
    return all(tasks[d]['status'] == 'accepted' for d in task['dependsOn'])


def verify_scenarios(record, criterion):
    """V2 将需求映射到归档真实断言；产物来源是记录，不替代运行环境证明。"""
    report = (ROOT / record.get('report', '')).resolve()
    archive = next((p for p in report.parents if (p / 'manifest.json').is_file()), None)
    if archive is None:
        return ['Missing scenario archive']
    manifest = json.loads((archive / 'manifest.json').read_text(encoding='utf-8-sig'))
    suite = record.get('suite', '')
    result_path = suite + '-result.json'
    files = {f['path'].replace('\\', '/'): f for f in manifest.get('files', [])}
    if result_path not in files:
        return ['Missing archived scenario results: ' + result_path]
    results = json.loads((archive / result_path).read_text(encoding='utf-8-sig'))
    if not isinstance(results, list):
        return ['Invalid scenario results']
    names = [r.get('id') or r.get('name') for r in results]
    if len(names) != len(set(names)) or any(not n for n in names):
        return ['Duplicate or missing scenario IDs']
    by_id = dict(zip(names, results))
    expected = criterion.get('scenarios') or []
    issues = []
    if not expected or any(i not in by_id or by_id[i].get('pass') is not True for i in expected):
        issues.append('Required scenarios missing or failed: ' + criterion['id'])
    provenance_path = record.get('provenance')
    if provenance_path not in files:
        return issues + ['Missing hash-covered product provenance']
    provenance = json.loads((archive / provenance_path).read_text(encoding='utf-8-sig'))
    if provenance.get('sourceCommit') != manifest.get('sourceCommit'):
        issues.append('Product provenance source SHA mismatch')
    stability_path = record.get('stability')
    if stability_path not in files:
        issues.append('Missing hash-covered before/after product check')
    else:
        stability = json.loads((archive / stability_path).read_text(encoding='utf-8-sig'))
        if stability.get('unchanged') is not True or stability.get('sourceCommit') != manifest.get('sourceCommit'):
            issues.append('Product changed during acceptance or stability source mismatch')
    deployment_path = record.get('deployment')
    if deployment_path not in files:
        issues.append('Missing hash-covered deployment probe')
    else:
        deployment = json.loads((archive / deployment_path).read_text(encoding='utf-8-sig'))
        if (deployment.get('unchanged') is not True
                or deployment.get('sourceCommit') != manifest.get('sourceCommit')
                or not deployment.get('targets')):
            issues.append('Deployment version changed or probe missing')
        for target in deployment.get('targets', []):
            if (target.get('before') != target.get('after')
                    or target.get('before') != target.get('expected')
                    or target.get('method') not in ('http-response-sha256', 'backend-build-identity')
                    or not re.fullmatch(r'[0-9a-f]{40}' if target.get('method') == 'backend-build-identity'
                                        else r'[0-9a-f]{64}', str(target.get('expected', '')))
                    or (target.get('method') == 'backend-build-identity'
                        and (target.get('expected') != manifest.get('sourceCommit')
                             or not target.get('instanceBefore')
                             or target.get('instanceBefore') != target.get('instanceAfter')))):
                issues.append('Deployment response differs from tested artifact')
    products = provenance.get('products')
    if stability_path in files:
        stability_products = stability.get('products')
        if (not isinstance(stability_products, list) or not stability_products
                or not isinstance(products, list)
                or {(p.get('name'), p.get('sha256')) for p in stability_products}
                   != {(p.get('name'), p.get('sha256')) for p in products}):
            issues.append('Stability record does not cover tested product hashes')
    if not isinstance(products, list) or not products:
        return issues + ['Missing tested products']
    for product in products:
        if (not product.get('name') or not product.get('runtimeVersion')
                or not re.fullmatch(r'[0-9a-f]{64}', str(product.get('sha256', '')))
                or product.get('sourceCommit') != manifest.get('sourceCommit')):
            issues.append('Invalid tested product provenance')
    return issues


def github_approval_issues(task, fetch_json=None):
    """从 GitHub API 获取当前 PR 审批；不可用则失败关闭，不信任手写批准。"""
    review = task.get('review') or {}
    github = review.get('github') or {}
    repository = github.get('repository', '')
    number = github.get('pullRequest')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not isinstance(number, int) or number <= 0:
        return ['Missing valid GitHub repository/pull request']
    if fetch_json is None:
        from urllib.request import Request, urlopen
        def fetch_json(route):
            headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'schema-workflow-gate',
                       'X-GitHub-Api-Version': '2022-11-28'}
            token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
            if token:
                headers['Authorization'] = 'Bearer ' + token
            with urlopen(Request('https://api.github.com/repos/' + repository + route, headers=headers), timeout=15) as response:
                return json.load(response)
    try:
        pr = fetch_json('/pulls/' + str(number))
        sha = pr['head']['sha']
        if sha != review.get('commit') or pr.get('draft') is True:
            return ['GitHub approval does not cover reviewed source SHA or PR is draft']
        reviews = fetch_json('/pulls/' + str(number) + '/reviews?per_page=100')
        latest = {}
        for item in reviews:
            login = item.get('user', {}).get('login')
            if item.get('state') in ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'):
                latest[login] = item
        author = pr.get('user', {}).get('login')
        approver = review.get('reviewer')
        approval = latest.get(approver, {})
        permission = fetch_json('/collaborators/' + str(approver) + '/permission').get('permission')
        if permission not in ('admin', 'maintain', 'write'):
            return ['GitHub reviewer lacks repository approval permission']
        if (approver == author or approval.get('state') != 'APPROVED'
                or approval.get('commit_id') != sha):
            return ['Missing independent GitHub approval for current PR HEAD']
        if any(r.get('state') == 'CHANGES_REQUESTED' for r in latest.values()):
            return ['GitHub change requests remain unresolved']
        required = github.get('requiredChecks')
        if not isinstance(required, list) or not required:
            return ['Missing required GitHub checks']
        checks = fetch_json('/commits/' + sha + '/check-runs?per_page=100').get('check_runs', [])
        for name in required:
            matches = sorted((c for c in checks if c.get('name') == name),
                             key=lambda c: c.get('id', 0), reverse=True)
            if not matches or matches[0].get('status') != 'completed' or matches[0].get('conclusion') != 'success':
                return ['Required GitHub check is not successful: ' + name]
        if len(reviews) >= 100 or len(checks) >= 100:
            return ['GitHub pagination limit reached; complete review/check data required']
    except Exception as error:
        return ['GitHub approval verification unavailable: ' + type(error).__name__]
    return []


def coverage_issues(task):
    """V2 结构门禁；不能证明清单完整或审批身份真实，仍需独立审查。"""
    issues = []
    matrix = task.get('requirements')
    if not isinstance(matrix, list) or not matrix:
        return ['Missing requirements matrix']
    ids = [r.get('id') for r in matrix if isinstance(r, dict)]
    if len(ids) != len(matrix) or any(not i for i in ids) or len(ids) != len(set(ids)):
        return ['Invalid or duplicate requirement IDs']
    criteria = {c['id']: c for c in task['acceptance']}
    for r in matrix:
        label = str(r['id'])
        if not r.get('source') or not r.get('condition'):
            issues.append(label + ': missing baseline source or observable condition')
        if r.get('status') == 'deferred':
            approval = r.get('deferral') or {}
            if not all(approval.get(k) for k in ('approvedBy', 'reference', 'owner', 'workPackage')):
                issues.append(label + ': missing explicit deferral approval or owner')
            continue
        if r.get('status') != 'passed':
            issues.append(label + ': requirement not verified')
        if not r.get('implementation') or not r.get('tests'):
            issues.append(label + ': missing implementation or tests')
        checks = r.get('checks') or []
        if not checks or any(c not in criteria for c in checks):
            issues.append(label + ': missing acceptance mapping')
        level = r.get('verification')
        if level not in ('unit', 'integration', 'browser'):
            issues.append(label + ': invalid verification level')
        if r.get('userInteraction') is True and level != 'browser':
            issues.append(label + ': user interaction requires real browser verification')
        if level == 'browser' and r.get('interaction') != 'native':
            issues.append(label + ': simulated handlers cannot certify browser interaction')
        if r.get('risk') not in ('low', 'high'):
            issues.append(label + ': missing risk classification')
        if r.get('risk') == 'high' and not r.get('negativeTests'):
            issues.append(label + ': high-risk requirement needs negative tests')
    review = task.get('review') or {}
    author = task.get('implementedBy')
    if not author or not review.get('reviewer') or author == review.get('reviewer'):
        issues.append('Independent reviewer must differ from implementer')
    if review.get('kind') not in ('human', 'independent-session'):
        issues.append('Self-review cannot certify independent approval')
    if not review.get('approvalReference'):
        issues.append('Missing independently verifiable approval reference')
    if review.get('scope') != ['requirements', 'code', 'tests', 'evidence']:
        issues.append('Review must cover requirements, code, tests and evidence')
    findings = review.get('findings')
    if not isinstance(findings, list):
        issues.append('Missing review findings record')
    elif any(f.get('blocking') is True and f.get('status') != 'resolved' for f in findings):
        issues.append('Unresolved blocking review findings')
    return issues


def audit(task):
    head = git_head()
    issues = coverage_issues(task) if task.get('gateVersion', 1) >= 2 else []
    for criterion in task['acceptance']:
        evidence = criterion.get('evidence')
        if not evidence:
            issues.append(criterion['id'] + ': missing evidence')
            continue
        evidence_issues = verify_commit(evidence, criterion['id'], task['id'])
        issues += evidence_issues
        if task.get('gateVersion', 1) >= 2 and not evidence_issues:
            issues += verify_scenarios(evidence, criterion)
        if evidence.get('passed') is not True or not evidence.get('command'):
            issues.append(criterion['id'] + ': missing successful command record')
    if not task['acceptance']:
        issues.append('No acceptance criteria')
    review = task.get('review') or {}
    issues += verify_commit(review, 'review', task['id']) if review else ['Missing independent review']
    if review.get('approved') is not True:
        issues.append('Independent review is not explicitly approved')
    if not (review.get('reviewer')):
        issues.append('Missing independent reviewer')
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--', *IMPLEMENTATION_PATHS], cwd=ROOT, text=True)
    if dirty.strip():
        issues.append('Implementation working tree is dirty; evidence cannot certify uncommitted changes')
    return issues


def check_references():
    """检查归档目录与台账引用；历史材料仅核对存在，不升级历史结论。"""
    issues = []
    base = ROOT / 'docs' / 'acceptance'
    for package in base.iterdir():
        if not package.is_dir():
            continue
        for run in package.iterdir():
            if run.is_dir() and run.name != 'legacy' and not (run / 'manifest.json').is_file():
                issues.append(f'Missing manifest: {run.relative_to(ROOT)}')
    for task in load()['tasks']:
        records = [c.get('evidence') or c for c in task['acceptance']]
        records.append(task.get('review') or {})
        for record in records:
            if not record.get('report'):
                continue
            report = (ROOT / record['report']).resolve()
            if not report.is_relative_to(base.resolve()) or not report.is_file():
                issues.append(f"{task['id']}: invalid report reference")
            elif 'legacy' not in report.relative_to(base).parts:
                issues += verify_commit(record, 'review' if 'reviewer' in record else 'reference', task['id'])
    return issues


def main():
    parser = argparse.ArgumentParser(description='MVP evidence-based workflow')
    parser.add_argument('action', choices=('status', 'next', 'start', 'implemented', 'check', 'accept', 'reopen', 'references'))
    parser.add_argument('task', nargs='?')
    args = parser.parse_args()
    if args.action == 'references':
        issues = check_references()
        if issues:
            print('\n'.join(issues))
            raise SystemExit(1)
        print('Archive directories and ledger references passed; legacy status unchanged')
        return
    data = load()
    tasks = {t['id']: t for t in data['tasks']}
    if args.action == 'status':
        for t in data['tasks']:
            missing = sum(not c.get('evidence') for c in t['acceptance'])
            print(f"{t['id']:10} {t['status']:14} missing={missing} {t['title']}")
        return
    if args.action == 'next':
        active = [t for t in data['tasks'] if t['status'] == 'implementing']
        candidates = active or sorted((t for t in data['tasks'] if t['status'] in ('planned', 'ready') and ready(t, tasks)), key=lambda t: t['priority'])
        print(json.dumps(candidates[0] if candidates else {'message': 'No ready task; resolve dependencies or review implemented tasks'}, ensure_ascii=False, indent=2))
        return
    if args.task not in tasks:
        parser.error('Provide a valid task ID')
    t = tasks[args.task]
    if args.action == 'start':
        if t['status'] not in ('planned', 'ready') or not ready(t, tasks):
            raise ValueError('Task is not ready')
        if any(x['status'] == 'implementing' for x in tasks.values()):
            raise ValueError('Finish or reopen the active task first')
        t['status'] = 'implementing'
    elif args.action == 'implemented':
        if t['status'] != 'implementing':
            raise ValueError('Task must be implementing')
        t['status'] = 'implemented'
    elif args.action in ('check', 'accept'):
        if args.action == 'accept':
            t['gateVersion'] = 2
        issues = audit(t)
        if args.action == 'accept' and not issues:
            issues += github_approval_issues(t)
        if not ready(t, tasks):
            issues.append('Dependencies are not accepted')
        if issues:
            print('\n'.join(issues))
            raise SystemExit(1)
        if args.action == 'check':
            print('Evidence checks passed; this is not independent approval')
            return
        if t['status'] not in ('implemented', 'verified'):
            raise ValueError('Implementation must precede acceptance')
        t['status'] = 'accepted'
    elif args.action == 'reopen':
        t['status'] = 'planned'
        t['review'] = None
        for c in t['acceptance']:
            c['evidence'] = None
        # Invalidate dependent acceptance transitively.
        affected = {t['id']}
        while True:
            more = {x['id'] for x in tasks.values() if any(d in affected for d in x['dependsOn'])}
            if more <= affected:
                break
            affected |= more
        for identifier in affected - {t['id']}:
            if tasks[identifier]['status'] == 'accepted':
                tasks[identifier]['status'] = 'blocked'
                tasks[identifier]['review'] = None
    save(data)
    print(t['id'] + ': ' + t['status'])


if __name__ == '__main__':
    main()
