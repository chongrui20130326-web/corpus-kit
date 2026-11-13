#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { splitBook } from './core/split.mjs';
import { parseCorpusFile } from './core/corpusImport.mjs';
import { createLlm, createMockLlm, createOllamaLlm, createPool } from './core/llm.mjs';
import { layout, readJson, writeJson, exists, ensureDir, createLogger, stamp } from './core/store.mjs';
import * as steps from './core/steps.mjs';
import { backfill } from './core/backfill.mjs';
import { collectSentences, writeStats, grammarProfile } from './core/stats.mjs';
import { search, formatRecord } from './core/query.mjs';
import { runPipeline, ORDER } from './core/pipeline.mjs';
import { finalizeEvents } from './core/events.mjs';
import { advise } from './core/advisor.mjs';
import { checkCoverage, formatReport } from './core/coverage.mjs';
import { exportProject } from './core/project.mjs';
import { findApiModel } from './core/models.mjs';
import { routeByStep } from './core/llmRouter.mjs';
import { buildCorpus, writeCorpus, checkCorpus } from './core/clean.mjs';
import { createInterface } from 'node:readline';
import { isPaused, setPaused, withPauseCheck } from './core/pause.mjs';
import { startApp } from './app.mjs';

const USAGE = `corpus-kit — 情色小说结构化语料抽取流水线

用法：
  node cli.mjs init   --file <小说.txt> --work <工作目录> [--title 书名] [--force]
  node cli.mjs add    --file <小说.txt> [--work <工作目录>] [--config config.ollama.json] [--mock]
  node cli.mjs run    --work <工作目录> [--mock] [--from P1] [--to P9] [--concurrency 4] [--force]
  node cli.mjs status --work <工作目录>
  node cli.mjs stats  --work <工作目录>
  node cli.mjs query  --work <工作目录> [--stage 妥协期] [--power 半推半就] [--scene-stage 前戏]
                      [--direction 前进] [--near 2] [--character 主角] [--text 关键词] [--limit 10] [--with-text]
  node cli.mjs export --work <工作目录> [--out corpus.json]
  node cli.mjs refine --work <工作目录> [--config config.json]
  node cli.mjs advise --work <工作目录> --outline "这一场要发生什么" [--characters "人物设定"]
  node cli.mjs check --work <工作目录>          # 校验原文是否全部进入分析
  node cli.mjs export --work <工作目录> [--out 路径]   # 导出书籍工程 JSON
  node cli.mjs clean --file <小说文件> [--work <工作目录>] [--scenes semantic]   # 清洗成带编号的语料
  node cli.mjs serve  [--root work] [--port 4173]

步骤顺序：P1 章节索引 → P2 场景切分 → P3 阶段粗分 → P4 场景分析
        → P6 弧线精修 → P5 回填(代码) → P7 句子层 → P8 初次突破 → P9 套话统计(代码)

模型配置（按优先级）：
  --config <json>  或  <work>/config.json  或  ./config.json  或 环境变量
  { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "model": "gpt-4o-mini", "concurrency": 4 }
`;

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function loadConfig(values) {
  const candidates = [
    values.config,
    values.work ? path.join(values.work, 'config.json') : null,
    'config.json',
  ].filter(Boolean);
  for (const file of candidates) {
    const value = readJson(file, null);
    if (value) return { config: value, from: file };
  }
  return { config: {}, from: null };
}

function buildContext(values, { book, dirs, mock, force, concurrency, logFile }) {
  const logger = createLogger(logFile);
  let lastProgress = 0;
  // 只在交互终端里刷进度；重定向到文件时不写，避免日志里全是半行。
  const progress = (message) => {
    if (!process.stdout.isTTY) return;
    const now = Date.now();
    if (now - lastProgress < 120) return;
    lastProgress = now;
    process.stdout.write(`\r${message.padEnd(56)}`);
  };

  const ctx = {
    book,
    dirs,
    mock,
    force,
    failed: [],
    maxUnits: values.units ? Number(values.units) : undefined,
    log: logger,
    isPaused: () => isPaused(dirs),
    progress,
    pool: (items, worker) => withPauseCheck(dirs, () => createPool(concurrency, items.map((item) => () => worker(item)))),
  };

  if (mock) {
    ctx.llm = createMockLlm();
  } else {
    const { config, from } = loadConfig(values);
    const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';

    /** 按模型名造客户端，和 app.mjs 的 clientForModel 保持同一套规则。 */
    const clientFor = (modelName) => {
      const name = String(modelName || '');
      // 本地模型网关（LocalAI）：OpenAI 兼容，必须显式关掉思考，否则 content 为空。
      if (config.provider === 'gateway') {
        return createLlm({
          baseUrl: config.gatewayBaseUrl || config.apiBaseUrl || 'http://127.0.0.1:8090/v1',
          apiKey: config.apiKey || 'local',
          model: name || config.model || 'qwen3.5:9b-uncensored',
          timeoutMs: config.timeoutMs ?? 900_000,
          reasoningEffort: 'none',
          jsonMode: config.jsonMode,
        });
      }
      const api = findApiModel(name);
      if (api || name.startsWith('api:')) {
        if (!apiKey) fail('云端 API 模式缺少 apiKey：写进 config.json 的 apiKey，或设置环境变量 DEEPSEEK_API_KEY。');
        return createLlm({
          baseUrl: api?.baseUrl || config.baseUrl || 'https://api.deepseek.com/v1',
          apiKey,
          model: api?.apiName || name.slice(4),
          timeoutMs: config.timeoutMs ?? 180_000,
          extraBody: { thinking: { type: 'disabled' } },
        });
      }
      if (/^qwen3\.5:/.test(name) || (!name && config.provider === 'ollama')) {
        return createOllamaLlm({
          baseUrl: config.baseUrl || 'http://127.0.0.1:11434',
          model: name || 'qwen3.5:9b-uncensored',
          timeoutMs: config.timeoutMs,
          think: config.think,
        });
      }
      if (!config.baseUrl) fail('缺少模型配置。请提供 config.json 或 --config。');
      return createLlm({ baseUrl: config.baseUrl, apiKey, model: name.replace(/^api:/, ''), jsonMode: config.jsonMode, timeoutMs: config.timeoutMs, extraBody: { thinking: { type: 'disabled' } } });
    };

    ctx.llm = clientFor(config.model);
    ctx.modelInfo = `模型：${config.model}（${from || 'config'}）`;

    // 分步模型：P1 这类调用最多的步可以走本地，质量关键的步走云端。
    const stepModels = config.stepModels && typeof config.stepModels === 'object' ? config.stepModels : {};
    const map = {};
    for (const [step, model] of Object.entries(stepModels)) {
      if (!model) continue;
      map[step] = model === config.model ? ctx.llm : clientFor(model);
    }
    if (Object.keys(map).length) {
      ctx.llm = routeByStep(ctx.llm, map);
      ctx.modelInfo += `｜分步：${Object.entries(map).map(([step, llm]) => `${step}=${llm.model}`).join(' ')}`;
    }

    // 云端上下文大，块可以放大；有分步时按最小的那个模型算。
    const models = [config.model, ...Object.values(stepModels)].filter(Boolean);
    const hasLocal = models.some((name) => /^qwen3\.5:/.test(name));
    ctx.p1Chars = hasLocal ? 3500 : 12000;
  }
  return ctx;
}

async function commandInit(values) {
  const file = values.file;
  if (!file) fail('init 需要 --file <小说.txt>');
  if (!exists(file)) fail(`找不到文件：${file}`);
  const work = values.work || `work/${path.basename(file, path.extname(file))}`;
  const dirs = layout(work);
  if (exists(dirs.book) && !values.force) fail(`工作目录已存在：${work}\n加 --force 覆盖，或换一个 --work。`);

  ensureDir(dirs.root);
  const raw = fs.readFileSync(file, 'utf-8');
  const book = parseCorpusFile(raw, values.file);
  writeJson(dirs.book, book);
  if (Array.isArray(book.scenes) && book.scenes.length) writeJson(dirs.l2Scenes, { scenes: book.scenes });
  for (const dir of [dirs.l1, dirs.l2Analysis, dirs.l3, dirs.l4, dirs.stats, dirs.logs]) ensureDir(dir);

  console.log(`✓ 已初始化 ${work}`);
  console.log(`  书名：${book.title}`);
  console.log(`  章节：${book.chapterCount}　段落：${book.paragraphCount}`);
  console.log(`  下一步：node cli.mjs run --work ${work}${values.mock ? ' --mock' : ''}`);
}

async function commandRun(values) {
  const work = values.work || 'work/default';
  const dirs = layout(work);
  const book = readJson(dirs.book, null);
  if (!book) fail(`找不到 ${dirs.book}，先跑 init。`);

  const mock = Boolean(values.mock);
  const concurrency = Number(values.concurrency || 4);
  const ctx = buildContext(values, {
    book, dirs, mock, force: Boolean(values.force), concurrency,
    logFile: path.join(dirs.logs, `run-${stamp()}.jsonl`),
  });
  if (!mock) console.log(ctx.modelInfo);
  if (mock) console.log('⚠ mock 模式：不访问网络，产出仅用于验证流水线结构。');

  const from = values.from || 'P1';
  const to = values.to || 'P9';
  if (!ORDER.includes(from) || !ORDER.includes(to)) fail(`--from/--to 只能是：${ORDER.join(' ')}`);

  const started = Date.now();
  ctx.onStep = (event) => {
    if (event.status === 'start') process.stdout.write(`\n[${event.step}] ${event.message} … `);
    else if (event.status === 'done') console.log(`完成 ${((event.ms || 0) / 1000).toFixed(1)}s`);
    else if (event.status === 'error') console.log(`失败：${event.error}`);
  };

  try {
    await runPipeline(ctx, { from, to, limitScenes: values.limit ? Number(values.limit) : undefined });
  } catch (error) {
    fail(`${error.message}\n日志：${path.join(dirs.logs)}`);
  }

  if (ctx.failed.length) {
    console.log(`\n⚠ 有 ${ctx.failed.length} 项未通过校验，已跳过：`);
    for (const item of ctx.failed.slice(0, 20)) console.log(`   - ${item}`);
  }
  console.log(`\n✓ 完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  commandStatus(values);
}

function commandStatus(values) {
  const dirs = layout(values.work || 'work/default');
  if (!exists(dirs.book)) fail(`工作目录不存在：${dirs.root}`);
  const counts = steps.fileCounts({ book: readJson(dirs.book), dirs });
  const index = readJson(dirs.l3SceneIndex, null);
  console.log(`\n工作目录：${counts.work}`);
  console.log(`段落：${counts.paragraphs}　章节：${counts.l1}`);
  console.log(`场景：${counts.scenes}　已分析：${counts.analysis}　句子层：${counts.l4}`);
  console.log(`人物弧：${counts.stages ? '✓' : '—'}　回填：${counts.index ? '✓' : '—'}　突破档案：${counts.breakthrough ? '✓' : '—'}`);
  if (index?.stages?.length) {
    console.log('阶段：');
    for (const stage of index.stages) console.log(`   ${stage.名称}　${stage.场景数} 个场景　${stage.起始状态} → ${stage.结束状态}`);
  }
}

function commandStats(values) {
  const dirs = layout(values.work || 'work/default');
  const file = path.join(dirs.stats, 'cliches.json');
  const result = readJson(file, null);
  if (!result) fail('还没有统计结果，先跑 run --to P9。');
  const profile = grammarProfile(collectSentences(dirs));
  console.log(`\n句子总数：${result.totalSentences}　场景数：${result.totalScenes}　句长均值：${profile?.averageLength ?? '—'}`);
  console.log(`\n高频表达（跨场景 ≥2 次）：`);
  for (const item of result.frequent.slice(0, 25)) {
    console.log(`   ${String(item.scenes).padStart(3)} 场景　${item.gram}`);
  }
}

function commandQuery(values) {
  const dirs = layout(values.work || 'work/default');
  const rows = search(dirs, {
    stage: values.stage, power: values.power, sceneStage: values['scene-stage'],
    direction: values.direction, near: values.near, character: values.character,
    text: values.text, limit: values.limit, hasTrajectory: values['has-trajectory'],
  });
  console.log(`\n命中 ${rows.length} 条\n`);
  for (const row of rows) console.log(`${formatRecord(row, { withText: values['with-text'] })}\n`);
}

function commandExport(values) {
  const dirs = layout(values.work || 'work/default');
  const book = readJson(dirs.book, null);
  const index = readJson(dirs.l3SceneIndex, null);
  if (!book || !index) fail('先跑完 P1–P6。');
  const scenes = index.scenes.map((entry) => ({
    ...entry,
    l4: readJson(dirs.l4File(entry.sceneId), null),
  }));
  const out = values.out || path.join(dirs.root, 'corpus.json');
  writeJson(out, {
    schema: 'corpus-kit/v1',
    generatedAt: new Date().toISOString(),
    book: { title: book.title, chapters: book.chapterCount, paragraphs: book.paragraphCount },
    stages: index.stages,
    breakthrough: readJson(dirs.l3Breakthrough, null),
    scenes,
    cliches: readJson(path.join(dirs.stats, 'cliches.json'), null),
  });
  console.log(`✓ 已导出 ${out}（${scenes.length} 个场景）`);
}

/** 一条命令完成「导入 + 跑完」：给不想记参数的人用。 */
async function commandAdd(values) {
  if (!values.file) fail('add 需要 --file <小说.txt|.md>');
  const base = path.basename(values.file, path.extname(values.file));
  const work = values.work || path.join('work', base);
  console.log(`导入：${values.file}`);
  console.log(`工作目录：${work}\n`);
  await commandInit({ ...values, work, force: true });
  console.log('');
  await commandRun({ ...values, work, from: 'P1', to: values.to || 'P9' });
}

/** 只重跑事件层的收尾（持续性 + 类型归一），不重跑分批抽取。 */
async function commandRefine(values) {
  const dirs = layout(values.work || 'work/default');
  const book = readJson(dirs.book, null);
  const eventsFile = readJson(dirs.l3Events, null);
  const index = readJson(dirs.l3SceneIndex, null);
  if (!book) fail(`找不到 ${dirs.book}`);
  if (!eventsFile) fail('没有 events.json，先跑 PE。');
  if (!index) fail('没有 scene-index.json，先跑完 P1–P6。');

  const ctx = buildContext(values, {
    book, dirs, mock: Boolean(values.mock), force: true, concurrency: 1,
    logFile: path.join(dirs.logs, `refine-${stamp()}.jsonl`),
  });

  const sceneById = new Map(index.scenes.map((scene) => [scene.sceneId, scene]));
  const events = await finalizeEvents(ctx, eventsFile.events, sceneById, index.breakthrough?.sceneId ?? null);
  writeJson(dirs.l3Events, { ...eventsFile, generatedAt: new Date().toISOString(), events });

  const byType = events.reduce((acc, event) => { acc[event.类型] = (acc[event.类型] || 0) + 1; return acc; }, {});
  const byPersistence = events.reduce((acc, event) => { acc[event.持续性] = (acc[event.持续性] || 0) + 1; return acc; }, {});
  console.log(`✓ 已归一 ${events.length} 条事件`);
  console.log(`  类型：${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join('　')}`);
  console.log(`  持续性：${Object.entries(byPersistence).map(([k, v]) => `${k} ${v}`).join('　')}`);
}

/** 续写顾问：根据大纲给写作建议。 */
async function commandAdvise(values) {
  const dirs = layout(values.work || 'work/default');
  const book = readJson(dirs.book, null);
  if (!book) fail(`找不到 ${dirs.book}`);
  if (!values.outline) fail('advise 需要 --outline "这一场要发生什么"');

  const ctx = buildContext(values, {
    book, dirs, mock: Boolean(values.mock), force: true, concurrency: 1,
    logFile: path.join(dirs.logs, `advise-${stamp()}.jsonl`),
  });
  // 跨书检索需要语料根目录。
  ctx.root = path.dirname(dirs.root);

  const result = await advise(ctx, { outline: values.outline, characters: values.characters });
  if (!result) fail('顾问三次都没给出合格结果，换个说法或换个模型再试。');
  if (result.错误) fail(result.错误);

  const dims = result.拆解 || {};
  console.log(`\n拆解　${dims.环境?.地点 || '—'} / ${dims.环境?.时间 || '—'} / ${dims.环境?.私密性 || '—'}`);
  console.log(`类型　${(dims.性爱类型 || []).join('、') || '—'}　强度 ${dims.强度 ?? '—'}/5`);
  console.log(`情境　${result.情境判断.阶段} · ${result.情境判断.权力}`);
  console.log(`关系　${result.情境判断.关系}`);
  console.log(`状态　${result.情境判断.人物状态}`);
  console.log(`\n轨迹　${result.推荐轨迹.起点} → ${result.推荐轨迹.终点}`);
  console.log(`触发　${result.推荐轨迹.触发}`);
  console.log('\n动作链骨架：');
  for (const link of result.动作链骨架) console.log(`  ${link}`);
  console.log('\n描写节点：');
  for (const node of result.描写节点) console.log(`  [${node.位置}] ${node.写什么}（${node.技法}）`);
  if (result.应避免?.length) console.log(`\n应避免：${result.应避免.join('、')}`);
  if (result.参考?.length) {
    console.log('\n跨书参考：');
    for (const item of result.参考) console.log(`  《${item.book}》${item.sceneId}　${item.为什么像}`);
  }
}

/** 清洗：把原文整理成带编号的完整语料（章/段/句/场景）。 */
async function commandClean(values) {
  if (!values.file) fail('clean 需要 --file <小说文件>');
  const raw = fs.readFileSync(values.file, 'utf8');
  const book = parseCorpusFile(raw, values.file);
  const work = values.work || path.join('work', path.basename(values.file, path.extname(values.file)));
  const dirs = layout(work);
  ensureDir(dirs.root);
  for (const dir of [dirs.l1, dirs.l2Analysis, dirs.l3, dirs.l4, dirs.stats, dirs.logs]) ensureDir(dir);
  writeJson(dirs.book, book);

  // --scenes semantic：清洗时顺手跑一遍语义切分，把场景一起写进语料。
  const mode = String(values.scenes || 'none').toLowerCase();
  let scenes = readJson(dirs.l2Scenes, null)?.scenes || [];

  if (mode === 'semantic') {
    const { segmentByChapters } = await import('./core/scenesByChapter.mjs');
    const { isEroticScene } = await import('./core/chains.mjs');
    const ctx = buildContext(values, {
      book, dirs, mock: Boolean(values.mock), force: true, concurrency: 1,
      logFile: path.join(dirs.logs, `clean-${stamp()}.jsonl`),
    });
    ctx.progress = (message) => console.log(`   ${message}`);
    console.log(`${ctx.modelInfo || ''}\n切分场景中…`);

    const result = await segmentByChapters(ctx, book.chapters.map((chapter) => ({
      index: chapter.index, title: chapter.title, paragraphs: chapter.paragraphs,
    })), { blockSize: 6, onChapter: (index, total) => ctx.progress(`第 ${index}/${total} 章`) });

    const paragraphText = new Map();
    for (const chapter of book.chapters) for (const paragraph of chapter.paragraphs) paragraphText.set(paragraph.id, paragraph.text);

    scenes = result.scenes.map((scene, index) => {
      const text = scene.ids.map((id) => paragraphText.get(id) || '').join('');
      return {
        sceneId: `S${String(index + 1).padStart(2, '0')}`,
        从: scene.ids[0],
        到: scene.ids[scene.ids.length - 1],
        段落: scene.ids,
        跨章: scene.chapters?.length > 1 ? scene.chapters : undefined,
        是否含情色: isEroticScene(text, {}),
        摘要: scene.state || '',
      };
    });
    writeJson(dirs.l2Scenes, { scenes });
  }

  const corpus = buildCorpus(book, scenes);
  const file = writeCorpus(dirs, corpus);
  const report = checkCorpus(corpus);

  console.log(`✓ 清洗完成 ${file}`);
  console.log(`   ${corpus.book.chapterCount} 章 / ${corpus.book.paragraphCount} 段 / ${corpus.book.sentenceCount} 句 / ${corpus.scenes.length} 场`);
  console.log(`   字数 ${corpus.book.charCount}`);
  if (corpus.scenes.length) {
    const erotic = corpus.scenes.filter((scene) => scene.是否含情色).length;
    console.log(`   其中含情色 ${erotic} 场`);
  }
  if (!report.ok) {
    console.log('\n自检问题：');
    for (const problem of report.problems.slice(0, 10)) console.log(`   · ${problem}`);
  } else {
    console.log('   自检通过：段落全覆盖、句子无空值');
  }
  if (!corpus.scenes.length) console.log('\n还没有场景：加 --scenes semantic 生成，或手工写 scenes 后重新 clean。');
}

/** 角色卡：先逐场抽细节，再按人物归并成卡。 */

/** 一键建库：流水线 + 情色分级 + 名册 + 人物卡 + 色情细节 + 逐句归属 + 人生轨迹 + 外貌 + 性别。 */
async function commandBuild(values) {
  const { spawnSync } = await import('node:child_process');
  const args = ['tools/build-all.mjs', '--work', values.work || 'work/default'];
  if (values.config) args.push('--config', values.config);
  if (values.from) args.push('--from', String(values.from));
  if (values.dry) args.push('--dry');
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

async function commandCards(values) {
  const dirs = layout(values.work || 'work/default');
  const book = readJson(dirs.book, null);
  if (!book) fail(`找不到 ${dirs.book}`);
  const scenesDoc = readJson(dirs.l2Scenes, null);
  if (!scenesDoc?.scenes?.length) fail('还没有场景，先跑 P2。');

  const ctx = buildContext(values, {
    book, dirs, mock: Boolean(values.mock), force: true,
    concurrency: Number(values.concurrency || 2),
    logFile: path.join(dirs.logs, `cards-${stamp()}.jsonl`),
  });

  const { extractFacts, mergeCards } = await import('./core/cards.mjs');
  const scenes = scenesDoc.scenes;

  console.log(`逐场抽取人物细节：${scenes.length} 场…`);
  const facts = await extractFacts(ctx, scenes, { force: Boolean(values.force) });
  console.log(`   新抽取 ${facts.extracted}，跳过 ${facts.skipped}，失败 ${facts.failed}`);

  console.log('按人物归并成卡…');
  const onlyList = values.only ? String(values.only).split(/[,，\s]+/).filter(Boolean) : [];
  const result = await mergeCards(ctx, scenes, {
    minScenes: Number(values['min-scenes'] || 2),
    only: onlyList,
  });
  const names = Object.keys(result.cards);
  console.log(`   生成 ${names.length} 张人物卡`);
  for (const name of names.slice(0, 12)) console.log(`   · ${name}（${result.cards[name].出现场次} 场）`);
  console.log(`\n输出：${dirs.root}\\l2\\cards.json 与 l2\\cards\\<姓名>.json`);
}

/** 暂停 / 继续：写一个标记文件，正在跑的进程会在下一个任务前停下。 */
async function commandPause(values) {
  const dirs = layout(values.work || 'work/default');
  if (!exists(dirs.book)) fail(`找不到 ${dirs.book}`);
  const on = values.off ? false : true;
  setPaused(dirs, on);
  console.log(on
    ? `已暂停：${dirs.root}\n正在跑的任务会跑完当前这一批再停，已完成的都保留。\n恢复：node cli.mjs pause --work ${values.work} --off`
    : `已恢复：${dirs.root}`);
}

/** 逐场顺序分析：先建简述，再一场一场分析，失败的可以之后单独修。 */
async function commandAnalyze(values) {
  const dirs = layout(values.work || 'work/default');
  const book = readJson(dirs.book, null);
  if (!book) fail(`找不到 ${dirs.book}`);
  const scenesDoc = readJson(dirs.l2Scenes, null);
  if (!scenesDoc?.scenes?.length) fail('还没有场景，先跑 clean 或 P2。');

  const ctx = buildContext(values, {
    book, dirs, mock: Boolean(values.mock), force: true, concurrency: 1,
    logFile: path.join(dirs.logs, `analyze-${stamp()}.jsonl`),
  });
  const scenes = scenesDoc.scenes;

  // 会话日志：CLI 跑的每一次模型对话也落盘，和界面跑的一致。
  const { createSession, wrapLlm } = await import('./core/sessionLog.mjs');
  const session = createSession(dirs.logs, `cli-${stamp()}`);
  ctx.llm = wrapLlm(ctx.llm, session);
  console.log(`对话日志：${session.file}`);

  // 第二步：给每个场景建立情节简述（已有就跳过）。
  const needBrief = scenes.filter((scene) => !scene.简述).length;
  if (needBrief) {
    console.log(`建立情节简述：${needBrief} 场…`);
    const { runSummaries } = await import('./core/summaries.mjs');
    const summaries = await runSummaries({ ...ctx, force: true, progress: (message) => console.log(`   ${message}`) }, scenes);
    const map = summaries?.scenes || {};
    for (const scene of scenes) {
      const brief = map[scene.sceneId]?.情节描述 || map[scene.sceneId]?.情节 || '';
      if (brief) scene.简述 = brief;
    }
    writeJson(dirs.l2Scenes, { scenes });
    console.log(`   已完成 ${Object.keys(map).length} 场简述`);
  }

  const repair = Boolean(values.repair);
  const targets = repair ? scenes.filter((scene) => scene.状态 === 'failed') : scenes;
  console.log(`${repair ? '修复' : '分析'} ${targets.length} 场，逐场进行…\n`);

  const { sequentialAnalyze } = await import('./core/sequential.mjs');
  const result = await sequentialAnalyze(ctx, scenes, {
    repair,
    force: Boolean(values.force),
    stageOf: (scene) => scene.场景阶段 || '未分阶段',
    progress: undefined,
    onFailure: async ({ scene, error }) => askContinue(scene, error),
  });

  console.log(`\n完成 ${result.done} 场，失败 ${result.failed.length} 场${result.stopped ? '（用户中止）' : ''}`);
  if (result.failed.length) {
    console.log('失败场景：', result.failed.join(', '));
    console.log('修复：node cli.mjs analyze --work <目录> --repair');
  }
}

/** 失败后问用户：停还是继续。60 秒没回应按“继续”处理。 */
function askContinue(scene, error) {
  return new Promise((resolve) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readline.close();
      resolve(answer);
    };
    const timer = setTimeout(() => {
      console.log(`\n   ${scene.sceneId} 失败：${error}`);
      console.log('   60 秒未操作，已标记为失败并继续下一场。');
      finish('continue');
    }, 60_000);

    console.log(`\n   ${scene.sceneId} 连续三次失败：${error}`);
    readline.question('   输入 s 停止分析，其它任意键继续（60 秒后自动继续）：', (answer) => {
      finish(String(answer).trim().toLowerCase() === 's' ? 'stop' : 'continue');
    });
  });
}

/** 完整性校验：原文是否每一段都进了场景、每个场景都有产物。 */
async function commandCheck(values) {
  const dirs = layout(values.work || 'work/default');
  const book = readJson(dirs.book, null);
  if (!book) fail(`找不到 ${dirs.book}`);
  const report = checkCoverage(book, dirs);
  console.log(formatReport(report));
  if (!report.ok) process.exitCode = 2;
}

/** 导出书籍工程：原文 + 全部分析结果合成一个 JSON。 */
async function commandExportProject(values) {
  const dirs = layout(values.work || 'work/default');
  const book = readJson(dirs.book, null);
  if (!book) fail(`找不到 ${dirs.book}`);
  const { path: out, project } = exportProject(dirs, book, values.out);
  console.log(`✓ 已导出 ${out}`);
  console.log(`   ${project.book.chapterCount} 章 / ${project.book.paragraphCount} 段 / ${project.stats.scenes} 场`);
  console.log(`   动作链 ${project.stats.scenesWithChain} 条　摘录 ${project.stats.excerpts} 条　事件 ${project.stats.events} 条`);
  console.log(`   日志 ${project.logs.length} 份（在 ${path.basename(out)}/logs/）`);
}

async function commandServe(values) {
  let root = path.resolve(values.root || values.work || 'work');
  // 允许直接传单本书的目录，自动退到它的父目录。
  if (exists(path.join(root, 'book.json'))) root = path.dirname(root);
  if (!exists(root)) fail(`语料根目录不存在：${root}`);
  const port = Number(values.port || 4173);
  const { url } = await startApp({ root, port, mock: Boolean(values.mock) });
  const books = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && exists(path.join(root, entry.name, 'book.json')));
  console.log(`\n语料工具已启动：${url}`);
  console.log(`根目录：${root}`);
  console.log(`书目：${books.map((entry) => entry.name).join('、') || '（空）'}`);
  console.log('在网页里点「导入新书」即可加书。按 Ctrl+C 停止。\n');
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      file: { type: 'string' }, work: { type: 'string' }, title: { type: 'string' },
      force: { type: 'boolean' }, mock: { type: 'boolean' }, config: { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' }, concurrency: { type: 'string' },
      limit: { type: 'string' }, out: { type: 'string' }, units: { type: 'string' },
      stage: { type: 'string' }, power: { type: 'string' }, 'scene-stage': { type: 'string' },
      direction: { type: 'string' }, near: { type: 'string' }, character: { type: 'string' },
      text: { type: 'string' }, 'with-text': { type: 'boolean' }, 'has-trajectory': { type: 'boolean' },
      root: { type: 'string' }, port: { type: 'string' },
      outline: { type: 'string' }, characters: { type: 'string' },
      scenes: { type: 'string' },
      repair: { type: 'boolean' },
      off: { type: 'boolean' },
      'min-scenes': { type: 'string' },
      only: { type: 'string' },
      quiet: { type: 'boolean' },
    },
  });

  const command = positionals[0];
  if (!command || command === 'help' || values.help) { console.log(USAGE); return; }

  switch (command) {
    case 'init': await commandInit(values); break;
    case 'add': await commandAdd(values); break;
    case 'run': await commandRun(values); break;
    case 'status': commandStatus(values); break;
    case 'stats': commandStats(values); break;
    case 'query': commandQuery(values); break;
    case 'serve': await commandServe(values); break;
    case 'analyze': await commandAnalyze(values); break;
    case 'pause': await commandPause(values); break;
    case 'cards': await commandCards(values); break;
    case 'build': await commandBuild(values); break;
    case 'check': await commandCheck(values); break;
    case 'clean': await commandClean(values); break;
    case 'export': await commandExportProject(values); break;
    case 'advise': await commandAdvise(values); break;
    case 'refine': await commandRefine(values); break;
    default: console.log(USAGE); fail(`未知命令：${command}`);
  }
}

main().catch((error) => fail(error.stack || String(error)));
