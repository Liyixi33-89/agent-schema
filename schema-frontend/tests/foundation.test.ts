import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('protocol foundation', () => {
  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(new URL('../packages/schema-protocol/package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).toHaveLength(0);
  });
});
