#!/bin/bash
# M12 收口排查②：模型总数与列表分页
export PGPASSWORD=schema_local_only
PSQL="psql -h localhost -U schema_dev -d schema_accept -tAc"
echo "--- total models (app 1, ACTIVE) ---"
$PSQL "SELECT count(*) FROM meta_model WHERE app_id=1 AND status='ACTIVE'"
echo "--- total models all ---"
$PSQL "SELECT count(*) FROM meta_model"
echo "--- relation-hosting models ---"
$PSQL "SELECT DISTINCT model_id FROM meta_field WHERE field_type='relation' AND field_status='ACTIVE' ORDER BY model_id"
echo "--- do relation hosts exist in app1? ---"
$PSQL "SELECT m.id, m.model_key FROM meta_model m WHERE m.id IN (SELECT DISTINCT model_id FROM meta_field WHERE field_type='relation' AND field_status='ACTIVE') ORDER BY m.id LIMIT 25"
