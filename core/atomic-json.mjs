import fs from 'node:fs';
import path from 'node:path';

const heldLocks = new Set();
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export function withJsonLock(file, fn) {
  const target = path.resolve(file);
  if (heldLocks.has(target)) return fn();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = `${target}.lock`;
  const deadline = Date.now() + 30000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`写入被占用：${file}`);
      Atomics.wait(sleepBuffer, 0, 0, 200);
    }
  }
  heldLocks.add(target);
  try { return fn(); }
  finally {
    heldLocks.delete(target);
    try { fs.closeSync(fd); }
    finally { fs.rmSync(lock, { force: true }); }
  }
}

export function writeJsonAtomic(file, data, indent = 1) {
  return withJsonLock(file, () => {
    const target = path.resolve(file);
    const tmp = `${target}.tmp`;
    const text = JSON.stringify(data, null, indent);
    fs.writeFileSync(tmp, text, 'utf8');
    // Windows 上 rename 可能因文件被占用（杀毒/索引）失败，重试后再退化为直接覆盖
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.renameSync(tmp, target);
        return file;
      } catch (error) {
        if (attempt === 4) {
          try {
            fs.copyFileSync(tmp, target);
            fs.rmSync(tmp, { force: true });
            return file;
          } catch (fallbackError) {
            fs.rmSync(tmp, { force: true });
            throw fallbackError;
          }
        }
        Atomics.wait(sleepBuffer, 0, 0, 200);
      }
    }
    return file;
  });
}
