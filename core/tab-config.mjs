import fs from 'node:fs';
import path from 'node:path';

/**
 * 标签页处理配置：处理方式、模型、系统提示词
 * 提示词可在底部栏修改，保存到 work/.config/prompt-overrides.json，
 * 工具运行时优先使用覆盖版本。
 */

const OVERRIDE_FILE = path.join('work', '.config', 'prompt-overrides.json');
const MODEL_OVERRIDE_FILE = path.join('work', '.config', 'model-overrides.json');

export function loadModelOverrides() {
  try {
    return fs.existsSync(MODEL_OVERRIDE_FILE) ? JSON.parse(fs.readFileSync(MODEL_OVERRIDE_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

export function saveModelOverride(view, model) {
  const doc = loadModelOverrides();
  if (model && String(model).trim()) doc[view] = String(model).trim();
  else delete doc[view];
  fs.mkdirSync(path.dirname(MODEL_OVERRIDE_FILE), { recursive: true });
  fs.writeFileSync(MODEL_OVERRIDE_FILE, JSON.stringify(doc, null, 1), 'utf8');
  return doc[view] || '';
}

/** 工具运行时取模型：环境变量 > 界面覆盖 > 代码默认 */
export function resolveModel(view, fallback, envValue) {
  if (envValue) return envValue;
  const over = loadModelOverrides()[view];
  return over || fallback;
}

export const TAB_CONFIG = {
  clean: { label: '小说清洗', mode: 'hybrid', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '常见格式之一是《书名》（第xx章），但也可能是「第N章 标题」「第N回」「【第N章】」「第１章」「69.」「Chapter N」或没有编号的独立短标题；不要限定单一格式。判断哪些行是章节标题：正文句子、对话、人名、地址不要选；章号取标题里的数字，没写数字按上一章+1。' },
  number: { label: '内容编号', mode: 'regex', model: '', prompt: '' },
  scenesview: { label: '场景切分', mode: 'model', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '你负责把一章小说按情节转折切成若干场景。输出切分句子号，不要改写原文。' },
  characters: { label: '生成角色', mode: 'hybrid', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '从原文中识别真实人物：姓名必须是真名，称谓（母亲/表哥/小姨）放入代称；同一人多种叫法合并。' },
  scenedetail: { label: '场景详述', mode: 'model', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '逐场写情节：一步一个动作变化，禁止概括；每步点名真名；不使用人称代词。部位只在动作确实涉及身体时写（插入/抚摸/亲吻等），点头、走路、开车、扶人这类日常动作不要硬加部位。' },
  correct: { label: '角色纠错', mode: 'model', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '按章核对角色与人物关系：姓名必须真名，代称并入；人物关系一对人一条，写清甲是乙的什么人；甲乙必须用角色表里的姓名；判断不了放存疑。' },
  link: { label: '人称关联', mode: 'hybrid', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '把场景里的人称编号映射到角色真名；代词指代不明就留空。' },
  relink: { label: '关系重构', mode: 'model', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '按章复核人称编号到角色真名的映射；姓名字段不得发明新角色；判不出来写未知。' },
  cardboard: { label: '角色人物卡', mode: 'model', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '按场景抽取角色资料：概述写完整描述，档案逐条列，每条带原文摘句与句子号。' },
  dialog: { label: '人物语言', mode: 'hybrid', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '判断每句对话的说话人：依据引号前的提示语与整句上下文；说话人必须是本场景角色；判不出来写未知。' },
  dirty: { label: '淫言浪语', mode: 'model', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '从 6.2 的台词里挑出色情相关的淫言浪语：挑逗/命令/羞辱/呻吟/粗口（性语境）；日常对白不选；标注类型与对象。' },
  erotic: { label: '角色色情描写', mode: 'model', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '从原文抽取色情描写：一条一个动作或画面，标注类型与参与者（可多个），每参与者必须是本场景角色，给句子号。' },
  appear: { label: '角色外观', mode: 'model', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '从原文抽取外观描写：只抽确实描写某人外貌/身体/衣着/配饰的句子；比喻、习语、动作短语不要抽；每条给类别、角色、原句与句子号。' },
  reconcile: { label: '角色重构', mode: 'hybrid', model: 'qwen3.5:9b-uncensored-q8_0_64K', prompt: '' },
  pipeline: { label: '工作流水线', mode: 'hybrid', model: 'qwen3.5:9b-uncensored-q8_0_64K（按节点可改）', prompt: '流水线本身不调用模型：每个节点执行的是它对应标签页的动作与提示词。节点与标签页的对应关系：第3步=场景切分、第4步=生成角色（真名表→人称→映射）、第5步=场景详述、第6步=角色重构。要改提示词，请进入对应标签页修改。' },
};

export function loadOverrides() {
  try {
    return fs.existsSync(OVERRIDE_FILE) ? JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

export function saveOverride(view, prompt) {
  const dir = path.dirname(OVERRIDE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const doc = loadOverrides();
  if (prompt && String(prompt).trim()) doc[view] = String(prompt);
  else delete doc[view];
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(doc, null, 1), 'utf8');
  return doc[view] || '';
}

export function resolvePrompt(view, fallback = '') {
  const overrides = loadOverrides();
  return overrides[view] || fallback || TAB_CONFIG[view]?.prompt || '';
}

export function tabConfig(view) {
  const base = TAB_CONFIG[view] || { label: view, mode: 'regex', model: '', prompt: '' };
  const overrides = loadOverrides();
  const modelOverrides = loadModelOverrides();
  return {
    view,
    label: base.label,
    mode: base.mode,
    model: modelOverrides[view] || base.model,
    defaultModel: base.model,
    prompt: overrides[view] || base.prompt,
    defaultPrompt: base.prompt,
    overridden: Boolean(overrides[view]),
  };
}
