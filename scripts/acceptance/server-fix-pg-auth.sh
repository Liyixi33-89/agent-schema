set -euo pipefail
echo "== databases =="
sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'schema%'"
echo "== hba =="
grep -Ev "^[[:space:]]*#" /var/lib/pgsql/data/pg_hba.conf | grep -E "host|local" || true
echo "== fix hba =="
sed -i "s/127.0.0.1\/32            ident/127.0.0.1\/32            md5/" /var/lib/pgsql/data/pg_hba.conf
grep -E "127.0.0.1" /var/lib/pgsql/data/pg_hba.conf || true
sudo -u postgres psql -c "ALTER ROLE schema_accept WITH PASSWORD 'schema_accept_only_2026';"
sudo -u postgres pg_ctl reload -D /var/lib/pgsql/data
echo "== verify login =="
PGPASSWORD=schema_accept_only_2026 psql -h 127.0.0.1 -U schema_accept -d schema_acceptance -tAc "SELECT 'LOGIN_OK'"
