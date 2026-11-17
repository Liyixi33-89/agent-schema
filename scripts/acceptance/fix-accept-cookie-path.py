"""修复验收 Cookie 路径；--temporary-http 仅供明确批准的临时 HTTP 验收。"""
from pathlib import Path
import shutil
import subprocess
from datetime import datetime
import sys

config = Path('/etc/nginx/conf.d/schema.conf')
text = config.read_text()
start = text.index('    location ^~ /accept/api/ {')
end = text.index('\n    }', start)
block = text[start:end]
directive = '        proxy_cookie_path / /accept/;'
temporary_http = '--temporary-http' in sys.argv[1:]
flags = '        proxy_cookie_flags ~^schema_(at|rt|csrf)$ nosecure;'
additions = []
if directive not in block:
    if 'proxy_cookie_path' in block:
        raise SystemExit('已有 Cookie 路径规则，请人工核对')
    additions.append(directive)
if temporary_http and flags not in block:
    if 'proxy_cookie_flags' in block:
        raise SystemExit('已有 Cookie 属性规则，请人工核对')
    additions.extend(['        # TEMPORARY HTTP acceptance only; remove nosecure when enabling TLS.', flags])
if additions:
    backup = config.with_name(config.name + '.bak-cookie-' + datetime.now().strftime('%Y%m%d%H%M%S'))
    shutil.copy2(config, backup)
    config.write_text(text[:end] + '\n' + '\n'.join(additions) + text[end:])
    try:
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    except Exception:
        shutil.copy2(backup, config)
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
        raise
    print('Updated; backup:', backup)
else:
    print('Already configured')
