# Schema 工程开发

## 工具链

JDK 21、Maven 3.9、Node 24、pnpm 10.33.0、Docker Desktop（WSL2）。不启用 Java 预览特性。

## 本地数据库

```powershell
docker compose up -d postgres
docker compose ps
```

PostgreSQL 仅绑定 `127.0.0.1:5432`；数据库/用户名为 `schema_dev`。配置中的 `schema_local_only` 仅为本机开发示例密码，不得用于生产。覆盖连接参数使用 `DB_URL`、`DB_USER`、`DB_PASSWORD` 环境变量。

数据存于命名卷；不要执行 `docker compose down -v`，该命令会删除开发数据。

## 后端

```powershell
cd schema-platform
mvn compile
mvn test
mvn -pl bootstrap -am install -DskipTests
mvn -pl bootstrap spring-boot:run
```

服务端口默认 8080，可通过 `SERVER_PORT` 覆盖。启动时 Flyway 自动执行基线，重复启动不得修改已执行脚本。

## 前端

```powershell
cd schema-frontend
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm --filter @schema/designer dev
```

三个应用端口：designer 5173、runtime 5174、admin-console 5175。通用 UI 使用 React/TypeScript 和 AntD。包目前只有空导出，不表示协议或业务功能已实现。

## 验收边界

工程骨架不是完整 M0 验收。ArchUnit/dependency-cruiser 反向规则验证、安全响应头与上报通道、CI 独立执行及 Flyway 恢复验证仍须逐项完成。详细任务见 `.agent/specs/000-engineering-foundation.md`。
