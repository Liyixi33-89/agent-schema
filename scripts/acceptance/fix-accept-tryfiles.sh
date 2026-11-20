#!/usr/bin/env bash
# 修正 schema.conf（真正 listen 80 的配置）的验收面段：
# 1) 三个 location 改用 root + rewrite（alias + try_files 的 URI 回退会循环回落）
# 2) 补 /accept/admin location（此前缺失，/accept/admin/ 被 location / 兜底成 runtime）
set -euo pipefail
CONF=/etc/nginx/conf.d/schema.conf
cp "$CONF" "$CONF.bak.acceptfix.$(date +%s)"

python3 - "$CONF" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()

CSP = ("add_header Content-Security-Policy \"default-src 'self'; script-src 'self'; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
       "font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; "
       "frame-ancestors 'self'; worker-src 'self' blob:\" always;")

def block(app):
    return (
        'location ^~ /accept/' + app + ' {\n'
        '        rewrite ^/accept/' + app + r'(/.*)$ $1 break;\n'
        '        root /opt/schema/staging/accept/current/web/' + app + ';\n'
        '        index index.html;\n'
        '        add_header Cache-Control no-store always;\n'
        '        add_header X-Content-Type-Options nosniff always;\n'
        '        add_header Referrer-Policy strict-origin-when-cross-origin always;\n'
        '        add_header X-Frame-Options SAMEORIGIN always;\n'
        '        ' + CSP + '\n'
        '        try_files $uri $uri/ /index.html;\n'
        '    }'
    )

# 替换 designer / runtime 两个已有块
for app in ('designer', 'runtime'):
    pat = re.compile(r'location \^~ /accept/' + app + r' \{.*?\n    \}', re.S)
    s, n = pat.subn(block(app), s)
    print(f'{app}: replaced={n}')

# 补 admin 块（插在 runtime 块之后）
if '/accept/admin' not in s:
    anchor = re.search(r'(location \^~ /accept/runtime \{.*?\n    \})', s, re.S)
    if anchor:
        s = s[:anchor.end()] + '\n    ' + block('admin') + s[anchor.end():]
        print('admin: inserted')
    else:
        print('admin: ANCHOR NOT FOUND')
else:
    print('admin: already present')

open(p, 'w').write(s)
PY

nginx -t
systemctl reload nginx
echo RELOADED