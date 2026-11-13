import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 一键建库：把这本书需要的全部产物按依赖顺序跑一遍。
 *
 * 每一步都是幂等的（已有的会跳过），中断了重跑即可接着来。
 * 用法：
 *   node tools/build-all.mjs --work "work/某本书" [--from 步骤号] [--dry]
 */

const args = process.argv.slice(2);
const getValue = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const work = getValue('work', 'work/default');
const config = getValue('config', 'config.gateway.json');
const fromStep = Number(getValue('from', '1'));
const dry = args.includes('--dry');
const root = process.cwd();

const steps = [
  { n: 1, name: '段落索引 / 场景切分 / 场景分析 / 弧线 / 摘要 / 动作链 / 句子层 / 阶段 / 事件', cmd: ['cli.mjs', 'run', '--work', work, '--config', config] },
  { n: 2, name: '情色分级（core / edge / none）', cmd: ['tools/tag-erotic.mjs', work] },
  { n: 3, name: '人物名册（全书真名）', cmd: ['tools/resolve-roster.mjs', work] },
  { n: 4, name: '称呼对照（我 / 老婆 → 真名）', cmd: ['tools/mine-aliases.mjs', work] },
  { n: 5, name: '人物事实逐场抽取 + 归并成卡', cmd: ['cli.mjs', 'cards', '--work', work, '--config', config, '--concurrency', '1'] },
  { n: 6, name: '人物关系图', cmd: ['tools/build-relations.mjs', work] },
  { n: 7, name: '关系校订', cmd: ['tools/seed-relations.mjs', work] },
  { n: 8, name: '关系校正卡片', cmd: ['tools/apply-relations.mjs', work] },
  { n: 9, name: '色情细节抽取（身体 / 姿势 / 淫语 / 反应 / 敏感）', cmd: ['tools/extract-erotic.mjs', work] },
  { n: 7, name: '引文校验（编造 / 错位 / 性别）', cmd: ['tools/audit-erotic.mjs', work, '--apply'] },
  { n: 8, name: '色情细节汇总进卡', cmd: ['tools/merge-erotic.mjs', work] },
  { n: 9, name: '性爱描写逐句归属', cmd: ['tools/attribute-sentences.mjs', work] },
  { n: 10, name: '按逐句归属重算性爱描写', cmd: ['tools/merge-erotic.mjs', work] },
  { n: 11, name: '人生轨迹', cmd: ['tools/build-timeline.mjs', work, '30'] },
  { n: 12, name: '外貌逐场抽取', cmd: ['tools/build-appearance-llm.mjs', work] },
  { n: 13, name: '外貌汇总进卡', cmd: ['tools/merge-appearance.mjs', work] },
  { n: 14, name: '衣着档案抽取', cmd: ['tools/build-outfit-llm.mjs', work] },
  { n: 15, name: '衣着档案汇总', cmd: ['tools/merge-outfit.mjs', work] },
  { n: 16, name: '全书台词归属', cmd: ['tools/build-dialogue.mjs', work] },
  { n: 17, name: '台词库汇总', cmd: ['tools/merge-dialogue.mjs', work] },
  { n: 18, name: '语言档案（按情境）', cmd: ['tools/build-speech-full.mjs', work, '10'] },
  { n: 17, name: '性格档案（按情境）', cmd: ['tools/build-personality.mjs', work, '8'] },
  { n: 18, name: '性别标注', cmd: ['tools/mark-gender.mjs', work] },
  { n: 19, name: '收尾清理（合并同人、去泛称）', cmd: ['tools/cleanup-cards.mjs', work] },
];

console.log(`建库流程：${work}`);
console.log(`共 ${steps.length} 步${fromStep > 1 ? `，从第 ${fromStep} 步开始` : ''}${dry ? '（演练，不执行）' : ''}\n`);

for (const step of steps) {
  if (step.n < fromStep) continue;
  const command = `node ${step.cmd.join(' ')}`;
  console.log(`[${step.n}/${steps.length}] ${step.name}`);
  console.log(`      ${command}`);
  if (dry) continue;

  const started = Date.now();
  const result = spawnSync(process.execPath, step.cmd, { cwd: root, stdio: 'inherit' });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.status !== 0) {
    console.log(`\n第 ${step.n} 步失败（退出码 ${result.status}），已执行 ${seconds} 秒。`);
    console.log('排查后可用 --from 从下一步继续。');
    process.exit(1);
  }
  console.log(`      ✓ ${seconds} 秒\n`);
}

console.log('全部完成。');
