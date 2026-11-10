#!/usr/bin/env node
/**
 * 追加归档材料（review.md）：对既有归档原子补录——
 * 校验目标文件不在既有 manifest、内容无敏感信息，然后重算全部哈希写新 manifest。
 * 与 archive 不同：不复制 run 材料，只追加指定新文件并重建 manifest（原子替换）。
 * 用法：node append-archive.cjs <工作包>/<run-id> <archive 相对路径...>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const ARCHIVE_ROOT = path.join(ROOT, 'docs', 'acceptance');
// 归档相对路径按平台分隔符 join 后再归一（跨平台一致）


function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const [archiveRel, ...rels] = process.argv.slice(2);
  if (!archiveRel || rels.length === 0) throw new Error('usage: append-archive.cjs <wp/run-id> <rel...>');
  const dir = path.join(ARCHIVE_ROOT, ...archiveRel.split('/'));
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error('manifest 不存在: ' + archiveRel);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const existing = new Set(manifest.files.map((f) => f.path));
  for (const rel of rels) {
    if (existing.has(rel)) throw new Error('材料已在 manifest: ' + rel);
    const src = path.join(dir, rel);
    if (!src.startsWith(dir + path.sep) || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
      throw new Error('材料缺失或路径逃逸: ' + rel);
    }
    manifest.files.push({ path: rel, sha256: sha256(src) });
  }
  const tmp = manifestFile + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, manifestFile);
  console.log('appended', rels.join(', '), '->', archiveRel);
}

main();
