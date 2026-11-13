import * as steps from './steps.mjs';
import { backfill } from './backfill.mjs';
import { collectSentences, writeStats, grammarProfile } from './stats.mjs';
import { runEvents } from './events.mjs';
import { runSummaries } from './summaries.mjs';
import { runChains } from './chains.mjs';
import { readJson } from './store.mjs';

export const ORDER = ['P1', 'P2', 'P3', 'P4', 'P6', 'P5', 'PS', 'PC', 'P7', 'P8', 'PE', 'P9'];

export const STEP_LABELS = {
  P1: '段落索引与压缩',
  P2: '场景切分（语义）',
  P3: '阶段粗分',
  P4: '场景分析',
  P6: '人物弧精修',
  P5: '回填场景坐标',
  PS: '场景摘要',
  PC: '色情动作链',
  P7: '句子层抽取',
  P8: '初次突破档案',
  PE: '关键事件',
  P9: '套话统计',
};

/**
 * 流水线编排。CLI 和本地服务共用这一份，避免两边行为漂移。
 *
 * ctx 需要：{ book, dirs, llm, force, failed, pool, log, progress }
 * 可选：onStep({step,status,message,done,total,error}) 用于进度上报。
 */
export async function runPipeline(ctx, options = {}) {
  const from = options.from || 'P1';
  const to = options.to || 'P9';
  const fromIndex = ORDER.indexOf(from);
  const toIndex = ORDER.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) throw new Error(`步骤只能是：${ORDER.join(' ')}`);

  let scenes = readJson(ctx.dirs.l2Scenes, null)?.scenes || [];
  let coarse = readJson(ctx.dirs.l3Coarse, null);
  let stages = readJson(ctx.dirs.l3Stages, null);
  const started = Date.now();

  for (const step of ORDER.slice(fromIndex, toIndex + 1)) {
    // 每步开始前看一次暂停标记：暂停了就在这一步之前停下，不再往后跑。
    if (ctx.isPaused?.()) {
      ctx.progress?.(`已暂停（停在 ${step} 之前）`);
      break;
    }
    const at = Date.now();
    ctx.onStep?.({ step, status: 'start', message: STEP_LABELS[step] || step });
    try {
      switch (step) {
        case 'P1': await steps.runP1(ctx); break;
        case 'P2': await steps.runP2(ctx); scenes = readJson(ctx.dirs.l2Scenes, null)?.scenes || []; break;
        case 'P3': coarse = await steps.runP3(ctx); break;
        case 'P4': {
          const limit = options.limitScenes ? Number(options.limitScenes) : scenes.length;
          await steps.runP4(ctx, scenes.slice(0, limit), coarse);
          break;
        }
        case 'P6': stages = await steps.runP6(ctx, scenes, coarse); break;
        case 'P5': {
          if (!stages) throw new Error('P5 需要 P6 的结果');
          backfill(ctx, scenes, stages);
          break;
        }
        case 'PS': await runSummaries(ctx, scenes); break;
        case 'PC': await runChains(ctx, scenes); break;
        case 'P7': await steps.runP7(ctx, scenes); break;
        case 'P8': await steps.runP8(ctx, scenes, stages); break;
        case 'PE': await runEvents(ctx, scenes, stages?.初次突破?.sceneId ?? null); break;
        case 'P9': {
          const sentences = collectSentences(ctx.dirs);
          const result = writeStats(ctx.dirs, sentences);
          const profile = grammarProfile(sentences);
          ctx.onStep?.({ step, status: 'done', message: `套话 ${result.cliches.length} 条，句长均值 ${profile?.averageLength ?? '—'}`, ms: Date.now() - at });
          continue;
        }
        default: break;
      }
      ctx.onStep?.({ step, status: 'done', ms: Date.now() - at });
    } catch (error) {
      ctx.onStep?.({ step, status: 'error', error: error.message });
      throw error;
    }
  }

  return { failed: ctx.failed, ms: Date.now() - started };
}
