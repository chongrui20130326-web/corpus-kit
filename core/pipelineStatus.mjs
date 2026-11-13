import fs from 'node:fs';
import path from 'node:path';
import { layout } from './store.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';

/**
 * 工作流水线：每一步的命令、依赖、产物判定。
 *
 * 状态由「产物文件」推出来，不依赖内存，所以刷新页面、重启服务都不会丢。
 * 运行中的状态额外记在 work/<书>/pipeline-state.json。
 */

const countFiles = (dir, ext = '.json') => {
  try { return fs.readdirSync(dir).filter((name) => name.endsWith(ext)).length; } catch { return 0; }
};
const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const exists = (file) => fs.existsSync(file);

/**
 * 完成度阈值。
 * 有的步骤只处理"候选场次"（比如外貌只在有外貌词的场次跑），
 * 用全场次当分母永远到不了 100%，所以按比例判定是否算完成。
 */
const COMPLETE_RATIO = {
  P4: 0.98,
  PS: 0.98,
  PC: 0.85,
  P7: 0.95,
  cards: 0.98,
  'erotic-facts': 0.98,
  sentences: 0.98,
  appearance: 0.6,
  outfit: 0.6,
  dialogue: 0.6,
  'outfit-context': 0.9,
};

export const STEPS = [
  { id: 'P1', label: 'P1 段落索引', group: '基础流水线', deps: [], cmd: ['cli.mjs', 'run', '--from', 'P1', '--to', 'P1'] },
  { id: 'P2', label: 'P2 场景切分', group: '基础流水线', deps: ['P1'], cmd: ['cli.mjs', 'run', '--from', 'P2', '--to', 'P2'] },

  { id: 'P4', label: 'P4 场景分析', group: '基础流水线', deps: ['P2'], cmd: ['cli.mjs', 'run', '--from', 'P4', '--to', 'P4'] },


  { id: 'PS', label: 'PS 场景摘要', group: '基础流水线', deps: ['P4'], cmd: ['cli.mjs', 'run', '--from', 'PS', '--to', 'PS'] },
  { id: 'PC', label: 'PC 动作链', group: '基础流水线', deps: ['PS'], cmd: ['cli.mjs', 'run', '--from', 'PC', '--to', 'PC'] },
  { id: 'P7', label: 'P7 句子层', group: '基础流水线', deps: ['P4'], cmd: ['cli.mjs', 'run', '--from', 'P7', '--to', 'P7'] },

  { id: 'PE', label: 'PE 关键事件', group: '基础流水线', deps: [], cmd: ['cli.mjs', 'run', '--from', 'PE', '--to', 'PE'] },
  { id: 'P9', label: 'P9 套话统计', group: '基础流水线', deps: ['P7'], cmd: ['cli.mjs', 'run', '--from', 'P9', '--to', 'P9'] },

  { id: 'tag-erotic', label: '情色分级', group: '分类', deps: ['PS'], cmd: ['tools/tag-erotic.mjs'] },
  { id: 'roster', label: '人物名册', group: '分类', deps: ['P4'], cmd: ['tools/resolve-roster.mjs'] },
  { id: 'aliases', label: '称呼对照', group: '分类', deps: ['roster'], cmd: ['tools/mine-aliases.mjs'] },

  { id: 'cards', label: '人物事实 + 归并成卡', group: '角色', deps: ['aliases'], cmd: ['cli.mjs', 'cards'] },

  { id: 'relations', label: '人物关系图', group: '角色', deps: ['cards'], cmd: ['tools/build-relations.mjs'] },
  { id: 'relations-apply', label: '关系校正', group: '角色', deps: ['relations'], cmd: ['tools/apply-relations.mjs'] },
  { id: 'erotic-facts', label: '色情细节抽取', group: '情色', deps: ['tag-erotic', 'cards'], cmd: ['tools/extract-erotic.mjs'] },
  { id: 'erotic-audit', label: '引文校验', group: '情色', deps: ['erotic-facts'], cmd: ['tools/audit-erotic.mjs', '--apply'] },
  { id: 'erotic-merge', label: '色情细节汇总', group: '情色', deps: ['erotic-audit'], cmd: ['tools/merge-erotic.mjs'] },
  { id: 'sentences', label: '性爱描写逐句归属', group: '情色', deps: ['erotic-merge'], cmd: ['tools/attribute-sentences.mjs'] },
  { id: 'sentences-merge', label: '性爱描写汇总', group: '情色', deps: ['sentences'], cmd: ['tools/merge-erotic.mjs'] },

  { id: 'timeline', label: '人生轨迹', group: '深化', deps: ['cards'], cmd: ['tools/build-timeline.mjs'] },
  { id: 'appearance', label: '外貌抽取', group: '深化', deps: ['cards'], cmd: ['tools/build-appearance-llm.mjs'] },
  { id: 'appearance-merge', label: '外貌汇总', group: '深化', deps: ['appearance'], cmd: ['tools/merge-appearance.mjs'] },
  { id: 'outfit', label: '衣着抽取', group: '深化', deps: ['cards'], cmd: ['tools/build-outfit-llm.mjs'] },
  { id: 'outfit-merge', label: '衣着汇总', group: '深化', deps: ['outfit'], cmd: ['tools/merge-outfit.mjs'] },
  { id: 'outfit-context', label: '衣着情境', group: '深化', deps: ['outfit-merge'], cmd: ['tools/enrich-outfit.mjs'] },
  { id: 'dialogue', label: '全书台词归属', group: '深化', deps: ['cards', 'P4'], cmd: ['tools/build-dialogue.mjs'] },
  { id: 'dialogue-merge', label: '台词库汇总', group: '深化', deps: ['dialogue'], cmd: ['tools/merge-dialogue.mjs'] },
  { id: 'speech', label: '语言档案', group: '深化', deps: ['dialogue-merge', 'relations-apply'], cmd: ['tools/build-speech-full.mjs'] },
  { id: 'personality', label: '性格档案', group: '深化', deps: ['relations-apply'], cmd: ['tools/build-personality.mjs'] },
  { id: 'gender', label: '性别标注', group: '深化', deps: ['cards'], cmd: ['tools/mark-gender.mjs'] },
  { id: 'cleanup', label: '收尾清理', group: '收尾', deps: ['cards'], cmd: ['tools/cleanup-cards.mjs'] },
];

/** 每步的完成度：done/total；total 为 0 表示"存在即完成"。 */
function progressOf(stepId, dirs, scenes, book) {
  const sceneCount = scenes.length;
  const chapters = book?.chapters?.length || 0;
  switch (stepId) {
    case 'P1': return { done: countFiles(dirs.l1), total: chapters };
    case 'P2': return { done: sceneCount ? 1 : 0, total: 1 };
    case 'P3': return { done: exists(dirs.l3Coarse) ? 1 : 0, total: 1 };
    case 'P4': return { done: countFiles(dirs.l2Analysis), total: sceneCount };
    case 'P6': return { done: exists(dirs.l3Stages) ? 1 : 0, total: 1 };
    case 'P5': return { done: exists(dirs.l3SceneIndex) ? 1 : 0, total: 1 };
    case 'PS': {
      const doc = readJson(dirs.l2Summaries, { scenes: {} });
      return { done: Object.keys(doc.scenes || {}).length, total: sceneCount };
    }
    case 'PC': {
      const doc = readJson(dirs.l2Chains, { scenes: {} });
      return { done: Object.keys(doc.scenes || {}).length, total: sceneCount };
    }
    case 'P7': return { done: countFiles(dirs.l4), total: sceneCount };
    case 'P8': return { done: exists(dirs.l3Breakthrough) ? 1 : 0, total: 1 };
    case 'PE': return { done: exists(dirs.l3Events) ? 1 : 0, total: 1 };
    case 'P9': return { done: countFiles(dirs.stats), total: 1 };

    case 'tag-erotic': return { done: scenes.filter((s) => s.情色分级).length, total: sceneCount };
    case 'roster': return { done: exists(path.join(dirs.l2, 'roster.json')) ? 1 : 0, total: 1 };
    case 'aliases': return { done: exists(path.join(dirs.l2, 'aliases.json')) ? 1 : 0, total: 1 };

    case 'cards': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      const facts = countFiles(path.join(dirs.l2, 'facts'));
      return { done: Object.keys(cards.cards || {}).length ? facts : 0, total: sceneCount };
    }

    case 'erotic-facts': {
      const target = scenes.filter((s) => ['core', 'edge'].includes(s.情色分级)).length;
      return { done: countFiles(path.join(dirs.l2, 'facts-erotic')), total: target };
    }
    case 'erotic-audit': return { done: exists(path.join(dirs.root, 'reports', 'erotic-audit.json')) ? 1 : 0, total: 1 };
    case 'erotic-merge':
    case 'sentences-merge': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      const withBody = Object.values(cards.cards || {}).filter((card) => (card.身体档案 || []).length).length;
      const withTalk = Object.values(cards.cards || {}).filter((card) => (card.性爱描写原文 || []).length).length;
      return { done: stepId === 'erotic-merge' ? withBody : withTalk, total: 1 };
    }
    case 'sentences': {
      const target = scenes.filter((s) => ['core', 'edge'].includes(s.情色分级)).length;
      return { done: countFiles(path.join(dirs.l2, 'facts-sentences')), total: target };
    }

    case 'timeline': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      return { done: Object.values(cards.cards || {}).filter((card) => (card.人生轨迹 || []).length).length, total: 1 };
    }
    case 'appearance': return { done: countFiles(path.join(dirs.l2, 'facts-appearance')), total: sceneCount };
    case 'appearance-merge': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      return { done: Object.values(cards.cards || {}).filter((card) => (card.外貌档案 || []).length).length, total: 1 };
    }
    case 'outfit': return { done: countFiles(path.join(dirs.l2, 'facts-outfit')), total: sceneCount };
    case 'outfit-merge': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      return { done: Object.values(cards.cards || {}).filter((card) => (card.衣着档案 || []).length).length, total: 1 };
    }
    case 'outfit-context': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      const all = Object.values(cards.cards || {}).flatMap((card) => card.衣着档案 || []);
      return { done: all.filter((item) => item.情境).length, total: all.length || 1 };
    }
    case 'relations': {
      return { done: exists(path.join(dirs.l2, 'relations.json')) ? 1 : 0, total: 1 };
    }
    case 'relations-apply': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      const seeded = readJson(path.join(dirs.l2, 'relations.json'), { edges: [] });
      const applied = Object.values(cards.cards || {}).filter((card) => (card.关系网 || []).some((item) => item.次数)).length;
      return { done: applied, total: (seeded.edges || []).length ? 1 : 0 };
    }
    case 'dialogue': {
      const target = scenes.length;
      return { done: countFiles(path.join(dirs.l2, 'facts-dialogue')), total: target };
    }
    case 'dialogue-merge': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      return { done: Object.values(cards.cards || {}).filter((card) => (card.台词库 || []).length).length, total: 1 };
    }
    case 'speech': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      return { done: Object.values(cards.cards || {}).filter((card) => (card.语言档案 || []).length).length, total: 1 };
    }
    case 'personality': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      return { done: Object.values(cards.cards || {}).filter((card) => (card.性格档案 || []).length).length, total: 1 };
    }
    case 'gender': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      const list = Object.values(cards.cards || {});
      return { done: list.filter((card) => card.性别).length, total: list.length || 1 };
    }
    case 'cleanup': {
      const cards = readJson(path.join(dirs.l2, 'cards.json'), { cards: {} });
      return { done: cards.清理说明 ? 1 : 0, total: 1 };
    }
    default: return { done: 0, total: 1 };
  }
}

export function pipelineStatus(bookDir) {
  const dirs = layout(bookDir);
  const book = readJson(dirs.book, null);
  const scenes = readJson(dirs.l2Scenes, { scenes: [] })?.scenes || [];
  const stateFile = path.join(dirs.root, 'pipeline-state.json');
  const state = readJson(stateFile, {}) || {};

  const steps = STEPS.map((step, index) => {
    const { done, total } = progressOf(step.id, dirs, scenes, book);
    const record = state[step.id] || {};
    const ratio = total > 0 ? done / total : 0;
    const need = COMPLETE_RATIO[step.id] ?? 1;
    const complete = total > 0 && ratio >= need;

    let status = 'idle';
    if (record.status === 'running') status = 'running';
    else if (record.status === 'failed') status = 'failed';
    else if (record.status === 'done') status = 'done';
    else if (complete) status = 'done';
    else if (done > 0) status = 'partial';

    return {
      ...step,
      order: index + 1,
      cmd: undefined,
      status,
      complete,
      done,
      total,
      percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : status === 'done' ? 100 : 0,
      startedAt: record.startedAt || null,
      finishedAt: record.finishedAt || null,
      error: record.error || null,
      added: record.added ?? null,
    };
  });

  return { book: path.basename(bookDir), steps, state };
}

export function writeStepState(bookDir, stepId, patch) {
  const dirs = layout(bookDir);
  const stateFile = path.join(dirs.root, 'pipeline-state.json');
  const state = readJson(stateFile, {}) || {};
  state[stepId] = { ...(state[stepId] || {}), ...patch };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  writeJsonAtomic(stateFile, state, 2);
}
