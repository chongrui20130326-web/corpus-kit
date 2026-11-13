import fs from 'node:fs';
import path from 'node:path';

/**
 * 会话日志：软件和模型之间的每一句都记下来。
 *
 * 目的只有一个——**不藏任何东西**。发给模型的 system、完整的 prompt、
 * 模型原样返回的文本、耗时、报错，全都落在 jsonl 里，
 * 同时留在内存里供界面实时显示。
 *
 * 文件位置：<书籍工程目录>/logs/session-<jobId>.jsonl
 */
export function createSession(dir, jobId) {
  const file = path.join(dir, `session-${jobId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', 'utf8');

  const messages = [];
  let seq = 0;

  const push = (record) => {
    seq += 1;
    const entry = { seq, at: new Date().toISOString(), ...record };
    messages.push(entry);
    try { fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8'); } catch { /* 磁盘问题不影响分析 */ }
    return entry;
  };

  return {
    file,
    push,
    get messages() { return messages; },
    count: () => seq,
    since: (after) => messages.filter((item) => item.seq > after),
  };
}

/** 包一层 llm，把每次请求/响应/错误都记进会话。 */
export function wrapLlm(llm, session) {
  return {
    model: llm.model,
    async chat(options = {}) {
      const { system = '', prompt = '', step = '', meta = {}, maxTokens } = options;
      const target = meta?.label || meta?.sceneId || meta?.chapter || '';
      const started = Date.now();
      const entry = session.push({
        role: 'request',
        step,
        target,
        model: llm.model || '',
        系统提示: system,
        提示词: prompt,
        maxTokens: maxTokens ?? null,
        提示词字数: prompt.length,
      });

      try {
        const response = await llm.chat(options);
        session.push({
          role: 'response',
          step,
          target,
          model: llm.model || '',
          requestSeq: entry.seq,
          耗时秒: Math.round((Date.now() - started) / 1000),
          回复: response.text || '',
          回复字数: String(response.text || '').length,
        });
        return response;
      } catch (error) {
        session.push({
          role: 'error',
          step,
          target,
          model: llm.model || '',
          requestSeq: entry.seq,
          耗时秒: Math.round((Date.now() - started) / 1000),
          错误: error.message,
        });
        throw error;
      }
    },
  };
}
