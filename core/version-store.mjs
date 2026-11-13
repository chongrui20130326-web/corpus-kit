import fs from 'node:fs';
import path from 'node:path';

/**
 * 通用输出文件版本化
 * 工具写表前调用 backupVersion(work, 'dialogue-table.json')
 * 会把旧文件存到 l2/versions/<name>/vN.json，返回新版本号
 */

const VDIR = (work) => path.join(work, 'l2', 'versions');

function metaFile(work, name) {
  return path.join(VDIR(work), name, 'index.json');
}

export function currentVersion(work, name) {
  try {
    return Number(JSON.parse(fs.readFileSync(metaFile(work, name), 'utf8')).version || 1);
  } catch {
    return 1;
  }
}

export function backupVersion(work, name) {
  const target = path.join(work, 'l2', name);
  const dir = path.join(VDIR(work), name);
  fs.mkdirSync(dir, { recursive: true });

  let version = 1;
  try {
    version = currentVersion(work, name);
  } catch { /* 忽略 */ }

  if (fs.existsSync(target)) {
    const archive = path.join(dir, 'v' + version + '.json');
    if (!fs.existsSync(archive)) {
      try { fs.copyFileSync(target, archive); } catch { /* 忽略 */ }
    }
    version += 1;
  }

  fs.writeFileSync(metaFile(work, name), JSON.stringify({ version, at: new Date().toISOString() }, null, 1), 'utf8');

  // 新内容写完后，也存一份当前版本
  process.on('exit', () => {
    try {
      if (fs.existsSync(target)) fs.copyFileSync(target, path.join(dir, 'v' + version + '.json'));
    } catch { /* 忽略 */ }
  });

  return version;
}

export function listVersions(work, name) {
  const dir = path.join(VDIR(work), name);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((f) => f.match(/^v(\d+)\.json$/))
    .filter(Boolean)
    .map((m) => {
      const v = Number(m[1]);
      let at = '';
      try { at = fs.statSync(path.join(dir, 'v' + v + '.json')).mtime.toISOString(); } catch { /* 忽略 */ }
      return { version: v, at };
    })
    .sort((a, b) => a.version - b.version);
}
