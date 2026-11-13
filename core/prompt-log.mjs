import fs from 'node:fs';
import path from 'node:path';

/**
 * 提示词留痕：每次调用模型前，把实际发送的完整提示词写入
 *   <work>/l2/prompts/<view>.last.txt
 * 界面可随时查看，保证不存在用户看不到的提示词。
 */

export function logPrompt(work, view, text) {
  try {
    const dir = path.join(work, 'l2', 'prompts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, view + '.last.txt');
    const meta = '生成时间：' + new Date().toISOString() + '\n长度：' + String(text || '').length + ' 字\n\n';
    fs.writeFileSync(file, meta + String(text || ''), 'utf8');
    return file;
  } catch {
    return '';
  }
}
