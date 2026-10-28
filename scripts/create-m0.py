from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]

def write(path, content):
    target = ROOT / path
    if target.exists():
        raise RuntimeError(f'Refusing to overwrite {target}')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')

def js(path, data):
    write(path, json.dumps(data, ensure_ascii=False, indent=2) + '\n')

modules = ['platform-common', 'metadata-module', 'data-module', 'page-module', 'flow-module', 'iam-module', 'integration-module', 'metering-module', 'bootstrap']
write('schema-platform/pom.xml', '''<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.5.0</version><relativePath/></parent>
  <groupId>com.schema</groupId><artifactId>schema-platform</artifactId><version>0.1.0-SNAPSHOT</version><packaging>pom</packaging>
  <properties><java.version>21</java.version><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
  <modules>''' + ''.join(f'<module>{m}</module>' for m in modules) + '''</modules>
</project>
''')
for module in modules:
    deps = ''
    if module == 'bootstrap':
        deps = '<dependencies>' + ''.join(f'<dependency><groupId>com.schema</groupId><artifactId>{m}</artifactId><version>${{project.version}}</version></dependency>' for m in modules if m != 'bootstrap') + '''<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-jdbc</artifactId></dependency><dependency><groupId>org.flywaydb</groupId><artifactId>flyway-core</artifactId></dependency><dependency><groupId>org.flywaydb</groupId><artifactId>flyway-database-postgresql</artifactId></dependency><dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId><scope>runtime</scope></dependency><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency></dependencies><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>'''
    write(f'schema-platform/{module}/pom.xml', '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><parent><groupId>com.schema</groupId><artifactId>schema-platform</artifactId><version>0.1.0-SNAPSHOT</version></parent><artifactId>' + module + '</artifactId>' + deps + '</project>\n')
    if module not in ['bootstrap', 'platform-common']:
        domain = module.removesuffix('-module')
        for layer in ['command.api', 'query.api', 'application', 'domain', 'infrastructure']:
            write(f'schema-platform/{module}/src/main/java/com/schema/{domain}/{layer.replace(".", "/")}/package-info.java', f'/** {domain} {layer} layer. */\npackage com.schema.{domain}.{layer};\n')
write('schema-platform/bootstrap/src/main/java/com/schema/bootstrap/SchemaApplication.java', '''package com.schema.bootstrap;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication(scanBasePackages = "com.schema")
public class SchemaApplication {
    public static void main(String[] args) {
        SpringApplication.run(SchemaApplication.class, args);
    }
}
''')
write('schema-platform/bootstrap/src/main/resources/application.yml', '''server:
  port: ${SERVER_PORT:8080}
spring:
  application:
    name: schema-platform
  datasource:
    url: ${DB_URL:jdbc:postgresql://localhost:5432/schema_dev}
    username: ${DB_USER:schema_dev}
    password: ${DB_PASSWORD:schema_local_only}
  flyway:
    enabled: true
''')
write('schema-platform/bootstrap/src/main/resources/db/migration/V1__platform_baseline.sql', '-- Engineering baseline only; no business tables.\nSELECT 1;\n')
write('compose.yaml', '''services:
  postgres:
    image: postgres:17.5
    environment:
      POSTGRES_DB: schema_dev
      POSTGRES_USER: schema_dev
      POSTGRES_PASSWORD: schema_local_only
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - schema_postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U schema_dev -d schema_dev"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  schema_postgres:
''')
write('schema-frontend/pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n')
js('schema-frontend/package.json', {'name':'schema-frontend','private':True,'packageManager':'pnpm@10.33.0','scripts':{'build':'turbo run build','typecheck':'turbo run typecheck','test':'vitest run'},'devDependencies':{'turbo':'2.5.4','typescript':'5.8.3','vitest':'3.2.4'}})
js('schema-frontend/turbo.json', {'tasks':{'build':{'dependsOn':['^build'],'outputs':['dist/**']},'typecheck':{'dependsOn':['^typecheck']}}})
js('schema-frontend/tsconfig.base.json', {'compilerOptions':{'target':'ES2022','lib':['ES2022','DOM','DOM.Iterable'],'module':'ESNext','moduleResolution':'Bundler','strict':True,'jsx':'react-jsx','esModuleInterop':True,'skipLibCheck':True,'noEmit':True}})
for name in ['schema-protocol','schema-renderer','schema-form','flow-designer','data-model-designer','page-designer','component-materials','request-sdk','auth-sdk','usage-tracker','shared-ui','script-host','theme-engine','chart-kit']:
    js(f'schema-frontend/packages/{name}/package.json', {'name':f'@schema/{name}','version':'0.1.0','private':True,'type':'module','exports':{'.':'./src/index.ts'},'scripts':{'build':'tsc --noEmit','typecheck':'tsc --noEmit'}})
    js(f'schema-frontend/packages/{name}/tsconfig.json', {'extends':'../../tsconfig.base.json','include':['src']})
    write(f'schema-frontend/packages/{name}/src/index.ts','export {};\n')
for i, app in enumerate(['designer','runtime','admin-console']):
    js(f'schema-frontend/apps/{app}/package.json', {'name':f'@schema/{app}','version':'0.1.0','private':True,'type':'module','scripts':{'dev':f'vite --port {5173+i}','build':'tsc --noEmit && vite build','typecheck':'tsc --noEmit'},'dependencies':{'react':'18.3.1','react-dom':'18.3.1','antd':'5.25.4'},'devDependencies':{'vite':'6.3.5','@types/react':'18.3.23','@types/react-dom':'18.3.7'}})
    js(f'schema-frontend/apps/{app}/tsconfig.json', {'extends':'../../tsconfig.base.json','include':['src']})
    write(f'schema-frontend/apps/{app}/index.html', f'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Schema {app}</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n')
    write(f'schema-frontend/apps/{app}/src/main.tsx', f'''import React from 'react';
import {{ createRoot }} from 'react-dom/client';
import {{ ConfigProvider, Layout, Typography }} from 'antd';

function App() {{
  return <ConfigProvider><Layout><Layout.Content><Typography.Title>Schema · {app}</Typography.Title><Typography.Paragraph>工程地基已就绪，业务功能按后续里程碑交付。</Typography.Paragraph></Layout.Content></Layout></ConfigProvider>;
}}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
''')
write('schema-frontend/tests/foundation.test.ts', '''import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('protocol foundation', () => {
  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(new URL('../packages/schema-protocol/package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).toHaveLength(0);
  });
});
''')
