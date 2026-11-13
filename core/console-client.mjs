// 所有服务通过控制台调用模型（统一日志、排队重试）
// 注意：这里用 node:http 而不是 fetch —— Node 内置 fetch(undici) 默认 300 秒
// 会中断长生成，本地模型生成大 JSON 经常超过 5 分钟。
import http from 'node:http';

const CONSOLE_URL = process.env.CONSOLE_URL || 'http://127.0.0.1:4173';
const parsed = new URL(CONSOLE_URL);

function requestJson(method, pathName, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({
      host: parsed.hostname,
      port: Number(parsed.port || 80),
      path: pathName,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 0,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch { /* 保留原文 */ }
        resolve({ status: res.statusCode, json, raw: body });
      });
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.end(data);
  });
}

export async function chatViaConsole({ prompt, system = '', source = 'unknown', maxTokens = 0, json = true, temperature = 0.1, timeoutMs = 3600000, model = '', reasoningEffort = '', cachePrompt = false, runId = '', maxOutputTokens = 0 }) {
  let lastError = '';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let res;
    try {
      res = await requestJson('POST', '/api/console/chat', { prompt, system, source, maxTokens, json, temperature, timeoutMs, cachePrompt, runId, ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(model ? { model } : {}) });
    } catch (error) {
      lastError = '连接控制台失败：' + error.message;
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const data = res.json || {};
    const msg = String(data.error || '');
    const busy = res.status === 429 || res.status === 503 || /正在处理请求|已拒绝|model_busy|backend_unavailable|paused/i.test(msg);
    if (busy) {
      lastError = msg || ('HTTP ' + res.status);
      await new Promise((r) => setTimeout(r, 10000));
      continue;
    }
    if (!res.status || res.status >= 400 || data.ok === false) return { ok: false, error: msg || ('HTTP ' + res.status) };
    if (!data.content) return { ok: false, error: '模型返回空内容' };
    if (looksLikeLoop(data.content)) return { ok: false, error: '模型输出重复（疑似死循环）', content: data.content };
    return { ok: true, content: data.content, usage: data.usage };
  }
  return { ok: false, error: '模型持续忙：' + lastError };
}

/** 检测模型输出是否陷入重复（同一段话反复出现） */
export function looksLikeLoop(text) {
  const s = String(text || '');
  if (s.length < 400) return false;
  // 取末尾 2000 字，切成 40 字窗口，统计重复
  const tail = s.slice(-2000);
  const seen = new Map();
  for (let i = 0; i + 40 <= tail.length; i += 20) {
    const key = tail.slice(i, i + 40);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const n of seen.values()) if (n >= 6) return true;
  // 单字/短句长串重复
  if (/(.{8,20})\1{8,}/.test(tail)) return true;
  return false;
}

export function parseJsonLoose(raw) {
  const text = String(raw || '');
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(body); } catch { /* 继续 */ }
  try { return JSON.parse(text.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}
