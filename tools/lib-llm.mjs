import { chatViaConsole, parseJsonLoose } from '../core/console-client.mjs';
import { writeJsonAtomic } from '../core/atomic-json.mjs';
import fs from 'node:fs';

/**
 * 统一的模型调用：带截断重试。
 * 判定截断：finish_reason === 'length' 或 输出被切（JSON 解析失败且 token 数接近上限）
 * 重试 3 次仍截断 → 返回 { ok:false, truncated:true }，由调用方登记到报告。
 */
export async function chatJson(prompt, options = {}) {
  const {
    model = process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K',
    maxTokens = 4096,
    retries = 3,
    temperature = 0.1,
    baseUrl = 'http://127.0.0.1:8090',
  } = options;

  // console-direct：统一走模型控制台，日志可见
  const via = await chatViaConsole({ prompt, source: options.source || 'lib-llm', maxTokens, json: true, temperature, ...(model ? { model } : {}) });
  if (!via.ok) return { ok: false, truncated: false, attempts: [{ error: via.error }], maxTokens };
  const parsedVia = parseJsonLoose(via.content);
  if (!parsedVia) return { ok: false, truncated: false, attempts: [{ error: 'bad-json' }], maxTokens };
  return { ok: true, data: parsedVia, attempts: [], maxTokens };

  const attempts = [];
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetch(baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          max_tokens: maxTokens,
          temperature,
          reasoning_effort: 'none',
          response_format: { type: 'json_object' },
        }),
      });
    } catch (error) {
      attempts.push({ attempt, error: 'network:' + error.message });
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    if (!response.ok) {
      attempts.push({ attempt, error: 'http:' + response.status });
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    const data = await response.json();
    const choice = data.choices?.[0] || {};
    const finish = String(choice.finish_reason || '');
    const raw = String(choice.message?.content || '');
    const usage = data.usage || {};

    if (finish === 'length') {
      attempts.push({ attempt, error: 'truncated', tokens: usage.completion_tokens });
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    let parsed = null;
    try {
      const body = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '');
      parsed = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
    } catch (error) {
      const nearCap = Number(usage.completion_tokens || 0) >= maxTokens * 0.9;
      attempts.push({ attempt, error: nearCap ? 'truncated-json' : 'bad-json' });
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    return { ok: true, data: parsed, attempts, maxTokens };
  }

  return { ok: false, truncated: attempts.some((a) => a.error.startsWith('truncated')), attempts, maxTokens };
}

/** 把失败记录写到报告文件里，供最终汇总查看。 */
export function recordFailure(reportPath, entry) {
  let report = { generatedAt: '', failures: [] };
  try {
    if (fs.existsSync(reportPath)) report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch { /* 忽略 */ }
  report.generatedAt = new Date().toISOString();
  report.failures = report.failures || [];
  report.failures.push({ ...entry, at: new Date().toISOString() });
  writeJsonAtomic(reportPath, report, 1);
}
