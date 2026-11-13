import { mockResponse } from './mock.mjs';

export class LlmError extends Error {}

/**
 * OpenAI 兼容客户端。只依赖 fetch，不引 SDK，方便换任何云端或本地网关。
 *
 * 关键行为：
 *   - 默认要求 JSON 对象（response_format），但不假设服务端一定支持，失败自动降级重试一次；
 *   - 失败重试由上层带「上次不合格原因」发起，这里只做网络层重试；
 *   - 并发由 createPool 统一控制，避免几百本书同时打爆配额。
 */
/**
 * 按模型规模限制单次输出上限。
 * 27B 在这台机器上约 3 token/秒，3072 上限意味着单次最长 17 分钟；
 * 收窄到 1200 后单次最多 6–7 分钟，且足够产出一批 JSON。
 */
function outputCapFor(model, requested) {
  const limit = /27b|iq4_xs|iq3_xxs/i.test(String(model)) ? 1200 : 6144;
  return Math.min(requested, limit);
}


/** 网关是全局单请求：碰到 429 model_busy 要等前一个跑完，不能直接失败。 */
const BUSY_WAIT_MS = 20000;
const BUSY_TRIES = 60;
const TIMEOUT_WAIT_MS = 120000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLlm(config = {}) {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = config.apiKey || '';
  const model = config.model || 'gpt-4o-mini';
  const timeoutMs = config.timeoutMs ?? 120_000;
  const jsonMode = config.jsonMode !== false;
  const extraBody = config.extraBody && typeof config.extraBody === 'object' ? config.extraBody : {};

  async function request(body, signal) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LlmError(`HTTP ${response.status} ${response.statusText} ${detail.slice(0, 300)}`);
    }
    return response.json();
  }

  return {
    model,
    async chat({ system, prompt, temperature = 0.2, maxTokens = 4096 }) {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });

      const cap = outputCapFor(model, maxTokens);
      const base = {
        model, messages, temperature, max_tokens: cap,
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        ...extraBody,
      };

      // 网关是全局单请求：429 model_busy 要等前一个跑完；
      // 客户端超时后服务端可能仍在生成，必须等够时间再重试。
      const send = async (payload) => {
        for (let attempt = 1; attempt <= BUSY_TRIES; attempt += 1) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await request(payload, controller.signal);
          } catch (error) {
            clearTimeout(timer);
            const message = String(error?.message || error);
            const busy = message.includes('model_busy') || message.includes('429');
            if (busy) { await sleep(BUSY_WAIT_MS); continue; }
            const aborted = error?.name === 'AbortError' || message.includes('aborted');
            if (aborted && attempt <= 2) { await sleep(TIMEOUT_WAIT_MS); continue; }
            throw error;
          } finally {
            clearTimeout(timer);
          }
        }
        throw new LlmError('网关长时间被占用（model_busy），放弃本次调用');
      };

      let data;
      try {
        data = await send(jsonMode ? { ...base, response_format: { type: 'json_object' } } : base);
      } catch (error) {
        if (!jsonMode) throw error;
        // 有些网关不支持 response_format，降级重试一次。
        data = await send(base);
      }

      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        const finish = data?.choices?.[0]?.finish_reason ?? '?';
        throw new LlmError(`模型返回空内容（finish=${finish}）。若为 length 说明输出预算不足。`);
      }
      return { text: content, usage: data?.usage ?? null };
    },
  };
}

/**
 * Ollama 原生接口客户端。
 *
 * 用原生 /api/chat 而不是 OpenAI 兼容层，因为只有原生接口能 reliably 关掉思考模式：
 * 带思考的模型会把 token 全花在 reasoning 上，content 返回空字符串，表现为「模型没输出」。
 */
export function createOllamaLlm(config = {}) {
  const baseUrl = (config.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = config.model || 'qwen3.5:9b-uncensored';
  const timeoutMs = config.timeoutMs ?? 180_000;
  const think = config.think === true;
  // Ollama 默认 num_ctx 只有 4096，长段落的书会被静默截断（截掉的是开头）。
  const numCtx = Number(config.numCtx) > 0 ? Number(config.numCtx) : 8192;

  return {
    model,
    async chat({ system, prompt, temperature = 0.2, maxTokens = 4096 }) {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            think,
            format: 'json',
            options: { temperature, num_predict: maxTokens, num_ctx: numCtx },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new LlmError(`HTTP ${response.status} ${detail.slice(0, 300)}`);
        }
        const data = await response.json();
        const content = data?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new LlmError(`模型返回空内容（done_reason=${data?.done_reason ?? '?'}）。若为 length 说明输出预算不足。`);
        }
        if (data?.done_reason === 'length') {
          // 输出被截断，JSON 必然不完整；直接判错让上层重试，比解析出半个对象好。
          throw new LlmError('输出被 num_predict 截断，请提高 maxTokens。');
        }
        return { text: content, usage: { evalCount: data?.eval_count, promptEvalCount: data?.prompt_eval_count } };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * mock 客户端：不访问网络，按步骤返回结构合法的假数据。
 * 用途是验证流水线、校验器、回填和查询，不用于评估模型质量。
 */
export function createMockLlm() {
  return {
    model: 'mock',
    async chat({ prompt, step, meta }) {
      const value = mockResponse(step, meta, prompt);
      return { text: JSON.stringify(value), usage: { mocked: true } };
    },
  };
}

/** 有并发上限的批量执行，返回与输入等长的结果数组。 */
export async function createPool(limit, tasks) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (cursor < tasks.length) {
      // 暂停时不再派发新任务：在跑的这批跑完就停，已写盘的结果都保留。
      if (globalThis.__pauseCheck?.()) return;
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** 从模型回复里取出 JSON 对象；容忍围栏和前后废话。 */
/** 把模型输出里常见的 JSON 毛病修一遍：未转义引号、尾逗号、裸换行。 */
/** 输出被 max_tokens 截断时，补上缺失的括号让它至少能解析。 */
function autoCloseJson(raw) {
  let inString = false;
  const stack = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (char === '\\') { index += 1; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
    if (char === '}' || char === ']') stack.pop();
  }
  let out = raw;
  if (inString) out += '"';
  // 去掉末尾半截的键值对，避免补括号后仍非法
  out = out.replace(/,\s*"[^"]*"\s*:\s*("[^"]*)?$/, '');
  out = out.replace(/,\s*$/, '');
  for (let index = stack.length - 1; index >= 0; index -= 1) out += stack[index];
  return out;
}

function repairJson(raw) {
  let out = '';
  let inString = false;
  let endedValue = false;   // 刚结束一个字符串值，后面若直接跟 " 说明缺逗号
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (!inString) {
      if (char === '"') {
        if (endedValue) { out += ','; endedValue = false; }
        inString = true;
        out += char;
        continue;
      }
      if (char === '}' || char === ']') endedValue = false;
      if (char === ',') endedValue = false;
      out += char;
      continue;
    }

    if (char === '\\') { out += char + (raw[index + 1] ?? ''); index += 1; continue; }
    if (char === '"') {
      let look = index + 1;
      while (look < raw.length && /\s/.test(raw[look])) look += 1;
      const next = raw[look];
      if (next === ',' || next === '}' || next === ']' || next === ':' || next === undefined) {
        inString = false;
        endedValue = true;
        out += char;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (char === '\n') { out += '\\n'; continue; }
    if (char === '\r') { out += '\\r'; continue; }
    if (char === '\t') { out += '\\t'; continue; }
    out += char;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

export function parseJsonObject(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const first = raw.indexOf('{');
  if (first < 0) throw new LlmError('返回内容里没有 JSON 对象');
  let last = raw.lastIndexOf('}');
  let source = raw;
  if (last <= first) {
    // 被截断了：补括号后再试
    source = autoCloseJson(raw.slice(first));
    last = source.lastIndexOf('}');
  }
  if (last <= first) throw new LlmError('返回内容里没有 JSON 对象');
  const body = source.slice(first, last + 1);
  try {
    return JSON.parse(body.replace(/,\s*([}\]])/g, '$1'));
  } catch (error) {
    // 模型常在字符串里塞未转义的英文引号或换行，修一遍再试
    try {
      return JSON.parse(repairJson(body));
    } catch {
      throw new LlmError('JSON 解析失败：' + error.message);
    }
  }
}

