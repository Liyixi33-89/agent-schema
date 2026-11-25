"""发布编排回归：只用临时产物和SSH/SCP桩，不执行发布或访问服务器。"""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import deploy


class DeployTest(unittest.TestCase):
    head = 'a' * 40

    def bundle(self, root):
        jar = root / 'schema-platform.jar'
        jar.write_bytes(b'synthetic-jar')
        web = root / 'web'
        web.mkdir()
        (web / 'index.html').write_text('synthetic-page')
        deploy.make_version_file(self.head, root, jar, web)
        deploy.make_manifest(root)
        return jar, web

    def test_manifest_and_version_cover_exact_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jar, _ = self.bundle(root)
            version = (root / 'VERSION.txt').read_text()
            self.assertIn('commit=' + self.head, version)
            self.assertIn('jarSha256=' + hashlib.sha256(jar.read_bytes()).hexdigest(), version)
            files = {}
            for line in (root / 'MANIFEST.sha256').read_text().splitlines():
                digest, filename = line.split('  ', 1)
                files[filename] = digest
                self.assertEqual(digest, hashlib.sha256((root / filename).read_bytes()).hexdigest())
            # jar 不纳入 MANIFEST：分离传输下前端-only 部署会复用旧 jar，
            # 若 MANIFEST 含 jar 必然误判「产物损坏」。jar 完整性由 VERSION.txt
            # 的 jarSha256 单独校验（见 schema-release-accept.sh 第 ④ 步）。
            self.assertEqual(set(files), {'web/index.html', 'VERSION.txt'})

    def test_upload_failure_never_ingests_or_switches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jar, web = self.bundle(root)
            with patch('deploy.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'failure')):
                with patch('deploy.ssh') as ssh:
                    with self.assertRaises(SystemExit):
                        deploy.deploy_accept(self.head, root, jar, web)
                    ssh.assert_not_called()

    def test_ingest_failure_never_switches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jar, web = self.bundle(root)
            with patch('deploy.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '', '')):
                with patch('deploy.ssh', side_effect=SystemExit('ingest rejected')) as ssh:
                    with self.assertRaises(SystemExit):
                        deploy.deploy_accept(self.head, root, jar, web)
                    self.assertEqual(ssh.call_count, 1)
                    command = ssh.call_args.args[0]
                    self.assertIn(' ingest ', command)
                    # 允许「条件式」预清理：仅当目标版本不是当前运行版本时才删。
                    # 无条件 rm -rf 会在前端-only 部署（同版本复用 jar）时
                    # 删掉正在运行的版本目录（current 软链悬空，重启即挂）。
                    if 'rm -rf' in command:
                        self.assertIn('readlink -f', command,
                                      'rm -rf 必须带「非当前版本」条件，不能无条件删除')

    def test_full_flow_verifies_all_entries_and_exact_commit(self):
        for commit in (self.head, 'b' * 40, self.head[:12], self.head[:12] + 'b' * 28):
            with self.subTest(commit=commit), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                jar, web = self.bundle(root)
                responses = ['ingested', 'switched', '200', '200', '200', json.dumps({'status': 'UP', 'commit': commit})]
                with patch('deploy.subprocess.run', return_value=subprocess.CompletedProcess([], 0, '', '')):
                    with patch('deploy.ssh', side_effect=[subprocess.CompletedProcess([], 0, value, '') for value in responses]) as ssh:
                        if commit == self.head:
                            deploy.deploy_accept(self.head, root, jar, web)
                        else:
                            with self.assertRaises(SystemExit):
                                deploy.deploy_accept(self.head, root, jar, web)
                        self.assertEqual(ssh.call_count, 6)
                        self.assertIn(' switch ', ssh.call_args_list[1].args[0])
                        for entry, call in zip(deploy.ACCEPT_ENTRIES.values(), ssh.call_args_list[2:5]):
                            self.assertIn(entry, call.args[0])

    def test_prod_web_bundle_preserves_merged_layout(self):
        """生产 web/ 是合并结构：根 index.html+assets/ 加 designer/、admin/ 子目录。

        回归 2026-11-25 修正的缺陷：生产打包曾按验收面的 web/{designer,runtime,admin}
        三子目录去拷，会漏掉根目录 index.html 与统一 assets/，nginx 直接 404。
        """
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jar = root / 'schema-platform.jar'
            jar.write_bytes(b'synthetic-jar')
            web = root / 'web'
            web.mkdir()
            (web / 'index.html').write_text('<html>runtime</html>')
            (web / 'assets').mkdir()
            (web / 'assets' / 'app.js').write_text('console.log(1)')
            for sub in ('designer', 'admin'):
                (web / sub).mkdir()
                (web / sub / 'index.html').write_text(f'<html>{sub}</html>')
            deploy.make_version_file(self.head, root, jar, web)
            deploy.make_manifest(root)

            captured = {}

            def fake_run(cmd, *a, **kw):
                # 拦截 scp：记录上传的本地 tar 路径
                captured.setdefault('scp', []).append(cmd[-2])
                return subprocess.CompletedProcess(cmd, 0, '', '')

            with patch('deploy.subprocess.run', side_effect=fake_run):
                # ssh 桩按调用顺序返回：ingest 输出 / switch / 三入口 200 / 探针
                responses = [
                    subprocess.CompletedProcess([], 0, 'ingested', ''),
                    subprocess.CompletedProcess([], 0, 'switched', ''),
                    subprocess.CompletedProcess([], 0, '200', ''),
                    subprocess.CompletedProcess([], 0, '200', ''),
                    subprocess.CompletedProcess([], 0, '200', ''),
                    subprocess.CompletedProcess(
                        [], 0, json.dumps({'status': 'UP', 'commit': self.head}), ''),
                ]
                with patch('deploy.ssh', side_effect=responses):
                    deploy.deploy_prod(self.head, root, jar, web)

            # 解包上传的 web tar，确认顶层结构是 web/（含根 index.html 与 assets/）
            import tarfile
            web_tar = next(Path(p) for p in captured['scp'] if str(p).endswith('.tar.gz'))
            with tarfile.open(web_tar) as tf:
                names = tf.getnames()
            self.assertIn('web/index.html', names)
            self.assertIn('web/assets/app.js', names)
            self.assertIn('web/designer/index.html', names)
            self.assertIn('web/admin/index.html', names)

    def test_ssh_errors_and_timeout_fail(self):
        with patch('deploy.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'failure')):
            with self.assertRaises(SystemExit):
                deploy.ssh('synthetic-command')
        with patch('deploy.subprocess.run', side_effect=subprocess.TimeoutExpired('ssh', 1)):
            with self.assertRaises(SystemExit):
                deploy.ssh('synthetic-command', timeout=1)

    def test_key_argument_consistency(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / 'key with spaces'
            key.write_text('synthetic-only')
            with patch.dict('os.environ', {'SCHEMA_DEPLOY_KEY_PATH': str(key)}):
                ssh, scp = deploy._ssh_base(), deploy._scp_base()
            self.assertIn('-T', ssh)
            self.assertNotIn('-T', scp)
            self.assertEqual(ssh[ssh.index('-i') + 1], str(key))
            self.assertEqual(scp[scp.index('-i') + 1], str(key))


if __name__ == '__main__':
    unittest.main()
