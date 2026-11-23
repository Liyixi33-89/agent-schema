#!/usr/bin/env bash
# 为验收面补 /accept/admin/ location（幂等；改前备份，nginx -t 通过才 reload）
set -euo pipefail
CONF=/etc/nginx/conf.d/accept-loopback.conf
[ -f "$CONF" ] || { echo "missing $CONF"; exit 1; }

if grep -q 'accept/admin' "$CONF"; then
  echo "already present"
  exit 0
fi

cp "$CONF" "$CONF.bak.$(date +%s)"

python3 - "$CONF" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
block = '''    location ^~ /accept/admin {
        alias /opt/schema/staging/accept/admin;
        add_header Cache-Control no-store always;
        add_header X-Content-Type-Options nosniff always;
        try_files $uri $uri/index.html =404;
    }
'''
idx = s.rstrip().rfind('}')
s = s[:idx] + block + s[idx:]
open(p, 'w').write(s)
print('inserted')
PY

nginx -t
systemctl reload nginx
echo RELOADED