import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 暂停开关。
 *
 * 用一个标记文件而不是内存变量：分析进程可能被重启，
 * 文件在，暂停状态就还在；重启后不会自己又跑起来。
 *
 * 位置：<书籍工程>/.paused
 */
export function pauseFile(dirs) {
  return path.join(dirs.root, '.paused');
}

export function isPaused(dirs) {
  try { return fs.existsSync(pauseFile(dirs)); } catch { return false; }
}

export function setPaused(dirs, paused) {
  const file = pauseFile(dirs);
  if (paused) {
    fs.writeFileSync(file, new Date().toISOString(), 'utf8');
  } else if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
  }
  return paused;
}

/** 给并发池装一个「暂停就停止派发新任务」的钩子。必须等任务真正跑完再撤钩子。 */
export async function withPauseCheck(dirs, run) {
  globalThis.__pauseCheck = () => isPaused(dirs);
  try {
    return await run();
  } finally {
    globalThis.__pauseCheck = null;
  }
}

/**
 * 让本地模型立刻从显存里退出。
 *
 * Ollama 收到 keep_alive:0 的请求后会把模型卸载，显存马上还回来；
 * 下次有请求时它会自己重新加载，不用额外做什么。
 */
export async function unloadModel(config = {}) {
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = config.model || 'qwen3.5:9b-uncensored';
  try {
    // 用 generate + 空 prompt + keep_alive:0 才真正卸载；
    // chat 接口传空 messages 在这版 Ollama 上不会释放显存。
    await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
      signal: AbortSignal.timeout(20000),
    });
    return { ok: true, model };
  } catch (error) {
    return { ok: false, model, error: error.message };
  }
}

/** 查 Ollama 当前驻留了哪些模型。 */
async function residentModels(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    return (data.models || []).map((item) => item.name);
  } catch {
    return [];
  }
}

/**
 * 强制释放显存：先正常卸载，再结束 llama-server 进程。
 *
 * 这版 Ollama 有两个毛病：/api/ps 会说"没有驻留"但显存还占着；
 * keep_alive:0 也可能被排到未结束的推理后面。所以最终以 runner 进程为准。
 */
export async function forceUnloadModel(config = {}) {
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = config.model || 'qwen3.5:9b-uncensored';

  await unloadModel({ baseUrl, model });
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const runners = () => {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        '(Get-Process llama-server -ErrorAction SilentlyContinue | Measure-Object).Count'],
      { timeout: 15000 }).toString().trim();
      return Number(out) || 0;
    } catch {
      return 0;
    }
  };

  if (runners() === 0) return { ok: true, model, mode: 'unload' };

  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force'], { timeout: 15000 });
  } catch { /* 忽略 */ }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (runners() === 0) return { ok: true, model, mode: 'killed-runner' };
  }
  return { ok: false, model, mode: 'still-loaded' };
}
