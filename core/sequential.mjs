import { readJson, writeJson, exists } from './store.mjs';
import { parseJsonObject, LlmError } from './llm.mjs';
import { SYSTEM } from './prompts.mjs';
import { p4Scene } from './prompts.mjs';
import { validateP4 } from './sequentialValidate.mjs';
import { repairSceneAnalysis } from './repair.mjs';
import { flatten } from './split.mjs';

/**
 * 逐场顺序分析。
 *
 * 和原来的 P4 并发批处理不同，这里严格按场景顺序走：
 *   1. 取前 3 场的情节简述作为「前文提要」
 *   2. 分析当前场
 *   3. 成功 → 立刻写 analysis + 更新书籍工程（scenes.json 的简述/状态）→ 下一场
 *   4. 失败 → 重试 3 次 → 仍失败则交给 onFailure 决定「停」还是「标记失败继续」
 *
 * 好处是任何一刻中断，工程里的进度都是完整的；坏处是慢，只能一场一场来。
 */

const MAX_ATTEMPTS = 3;
const CONTEXT_SCENES = 3;

function sceneText(book, scene) {
  const rows = flatten(book);
  const from = rows.findIndex((row) => row.id === scene.从);
  const to = rows.findIndex((row) => row.id === scene.到);
  if (from < 0 || to < from) return '';
  return rows.slice(from, to + 1).map((row) => row.text).join('\n');
}

/** 前文提要：前面最多 3 场的情节简述。 */
export function buildContext(scenes, index, briefs) {
  const from = Math.max(0, index - CONTEXT_SCENES);
  const lines = [];
  for (let i = from; i < index; i += 1) {
    const scene = scenes[i];
    const brief = briefs[scene.sceneId] || scene.简述 || scene.摘要 || '';
    if (brief) lines.push(`${scene.sceneId}（第 ${scene.章 ?? '?'} 章）：${brief}`);
  }
  return lines.join('\n');
}

export async function sequentialAnalyze(ctx, scenes, options = {}) {
  const { dirs } = ctx;
  const briefs = readJson(dirs.l2Summaries, null)?.scenes ?? {};
  const force = Boolean(options.force);
  const onlyFailed = Boolean(options.repair);
  const results = { done: 0, failed: [], stopped: false };

  for (let index = 0; index < scenes.length; index += 1) {
    // 用户按下暂停：当前这场跑完就停，进度都已落盘。
    if (options.shouldStop?.()) {
      results.paused = true;
      results.stopped = true;
      break;
    }
    const scene = scenes[index];
    const file = dirs.l2File(scene.sceneId);
    const already = exists(file);

    if (onlyFailed) {
      if (scene.状态 !== 'failed') continue;
    } else if (already && !force) {
      continue;
    }

    const text = sceneText(ctx.book, scene);
    if (!text) {
      scene.状态 = 'failed';
      scene.失败原因 = '原文范围无效';
      results.failed.push(scene.sceneId);
      continue;
    }

    const context = buildContext(scenes, index, briefs);
    const meta = { step: 'P4', sceneId: scene.sceneId, text, label: scene.sceneId, erotic: scene.是否含情色 !== false };
    let value = null;
    let feedback = '';
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await ctx.llm.chat({
          system: SYSTEM,
          prompt: `${p4Scene({
            sceneId: scene.sceneId,
            from: scene.从,
            to: scene.到,
            stage: options.stageOf?.(scene) || '未分阶段',
            text,
            context,
          })}${feedback}`,
          step: 'P4',
          meta,
          maxTokens: 6144,
        });
        value = repairSceneAnalysis(parseJsonObject(response.text), meta);
        const result = validateP4(value, meta);
        if (result.ok) break;
        value = null;
        feedback = `\n\n上次输出未通过校验：\n- ${result.errors.slice(0, 6).join('\n- ')}`;
      } catch (error) {
        lastError = error.message;
        value = null;
        feedback = `\n\n上次输出无法解析：${error.message}。请只输出 JSON。`;
      }
    }

    if (value) {
      writeJson(file, value);
      scene.状态 = 'done';
      delete scene.失败原因;
      // 书籍工程同步更新：情节简述 + 状态
      if (!scene.简述) scene.简述 = value.轨迹 ? `${value.轨迹.起点} → ${value.轨迹.终点}` : (value.节拍?.[0]?.动作 || '');
      writeJson(dirs.l2Scenes, { scenes });
      results.done += 1;
      ctx.progress?.(`P4 ${results.done} 完成　${scene.sceneId}　失败 ${results.failed.length}`);
      continue;
    }

    // 三次都失败
    lastError = lastError || '连续三次校验未通过';
    scene.状态 = 'failed';
    scene.失败原因 = lastError;
    writeJson(dirs.l2Scenes, { scenes });
    results.failed.push(scene.sceneId);

    const decision = await options.onFailure?.({ scene, error: lastError, results }) || 'continue';
    if (decision === 'stop') { results.stopped = true; break; }
  }

  writeJson(dirs.l2Scenes, { scenes });
  return results;
}
