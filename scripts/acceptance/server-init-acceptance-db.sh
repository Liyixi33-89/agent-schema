#!/bin/bash
# 一次性建库脚本：独立验收库 + 专用账号（幂等）
set -euo pipefail
cd /tmp
echo "CREATE ROLE schema_accept LOGIN PASSWORD 'schema_accept_only_2026';" | sudo -u postgres psql 2>&1 | grep -v EXISTS || true
echo "SELECT 'CREATE ROLE schema_accept LOGIN PASSWORD ''schema_accept_only_2026''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='schema_accept')\\gexec" | sudo -u postgres psql
echo "SELECT 'CREATE DATABASE schema_acceptance OWNER schema_accept' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='schema_acceptance')\\gexec" | sudo -u postgres psql
sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datname='schema_acceptance'"
