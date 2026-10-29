import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const config = require('../.dependency-cruiser.cjs');

describe('architecture guard', () => {
  it('rejects a real cross-package protocol import', () => {
    const dir = mkdtempSync(join(tmpdir(), 'schema-architecture-'));
    try {
      mkdirSync(join(dir, 'packages/schema-protocol/src'), { recursive: true });
      mkdirSync(join(dir, 'packages/other/src'), { recursive: true });
      writeFileSync(join(dir, 'packages/schema-protocol/src/index.js'), "import '../../other/src/index.js';");
      writeFileSync(join(dir, 'packages/other/src/index.js'), 'export {};');
      writeFileSync(join(dir, 'rules.json'), JSON.stringify({ forbidden: config.forbidden, options: {} }));
      const cli = join(process.cwd(), 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs');
      let output = '';
      try {
        execFileSync(process.execPath, [cli, '--config', 'rules.json', 'packages'], { cwd: dir, encoding: 'utf8' });
      } catch (error) {
        output = String((error as { stdout: string }).stdout);
      }
      expect(output).toContain('protocol-zero-dependencies');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
