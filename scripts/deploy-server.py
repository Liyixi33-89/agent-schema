"""初始化独立的 Schema 服务器部署；在目标 Linux 服务器以 root 执行。"""
from pathlib import Path
import secrets
import subprocess


def run(*args):
    subprocess.run(args, check=True)


root = Path('/opt/schema')
root.mkdir(exist_ok=True)
if not Path('/var/lib/pgsql/data/PG_VERSION').exists():
    run('postgresql-setup', '--initdb')
hba = Path('/var/lib/pgsql/data/pg_hba.conf')
rule = 'host schema_prod schema_prod 127.0.0.1/32 scram-sha-256\n'
if rule not in hba.read_text():
    hba.write_text(rule + hba.read_text())
run('systemctl', 'enable', '--now', 'postgresql')
run('systemctl', 'reload', 'postgresql')
run('bash', '-c', 'id schema >/dev/null 2>&1 || useradd --system --home-dir /opt/schema --shell /sbin/nologin schema')
env = Path('/etc/schema-platform.env')
if not env.exists():
    password = secrets.token_hex(32)
    sql = f"CREATE USER schema_prod PASSWORD '{password}';\nCREATE DATABASE schema_prod OWNER schema_prod;\n"
    subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, check=True)
    env.write_text(f'DB_URL=jdbc:postgresql://127.0.0.1:5432/schema_prod\nDB_USER=schema_prod\nDB_PASSWORD={password}\nIAM_JWT_SECRET={secrets.token_hex(48)}\nSERVER_PORT=18080\nSERVER_ADDRESS=127.0.0.1\nFILE_LOCAL_DIR=/opt/schema/data/files\n', encoding='utf-8')
    env.chmod(0o600)
(root / 'data/files').mkdir(parents=True, exist_ok=True)
run('chown', '-R', 'schema:schema', str(root))
web = root / 'web'
if web.exists():
    web.chmod(0o755)
    for item in web.rglob('*'):
        item.chmod(0o755 if item.is_dir() else 0o644)
Path('/etc/systemd/system/schema-platform.service').write_text('''[Unit]
Description=Schema Platform
After=network.target postgresql.service
Requires=postgresql.service

[Service]
User=schema
Group=schema
WorkingDirectory=/opt/schema
EnvironmentFile=/etc/schema-platform.env
ExecStart=/usr/lib/jvm/jre-21-konajdk/bin/java -Xms128m -Xmx512m -jar /opt/schema/schema-platform.jar
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/schema/data
UMask=0077

[Install]
WantedBy=multi-user.target
''', encoding='utf-8')
run('systemctl', 'daemon-reload')
run('systemctl', 'enable', '--now', 'schema-platform')
print('SCHEMA_SERVICE_STARTED')
