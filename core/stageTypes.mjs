/**
 * 阶段类型归一。
 *
 * 问题：阶段名（抗拒期/妥协期/离别期…）是模型每次现起的，同一本书换个模型就换一套名字，
 * 跨书更没法比。名字可以自由，但「这个阶段处于弧线的哪一段」是结构属性，必须用固定闭集。
 *
 * 做法：先按名字里的语义线索判定，判不出来再按位置（开头/中间/结尾）兜底。
 */

export const STAGE_TYPES = ['起始', '升温', '越界', '沉迷', '余波'];

const HINTS = [
  ['余波', /离别|余波|尾声|之后|后来|结局|收束|平淡/],
  ['沉迷', /沉溺|沉迷|沦陷|习惯|放纵|依赖|深陷/],
  ['越界', /转折|越界|突破|妥协|失守|变化|动摇/],
  ['升温', /升温|试探|暧昧|靠近|松动|靠近|默契/],
  ['起始', /抗拒|疏离|初始|开端|陌生|戒备/],
];

/** 名字线索优先；否则按位置在闭集里取一个。 */
export function canonicalStageType(name, index, total) {
  const text = String(name || '');
  for (const [type, pattern] of HINTS) {
    if (pattern.test(text)) return type;
  }

  if (total <= 1) return '起始';
  if (index === 0) return '起始';
  if (index === total - 1) return total >= 5 ? '余波' : '沉迷';

  const span = Math.max(1, total - 2);
  const position = (index - 1) / span;
  if (position < 0.34) return '升温';
  if (position < 0.67) return '越界';
  return '沉迷';
}

/** 给一组阶段补上 类型，并保证顺序单调（后一个不能比前一个靠前）。 */
export function annotateStages(stages) {
  const total = stages.length;
  let floor = 0;
  return stages.map((stage, index) => {
    if (stage.类型 && STAGE_TYPES.includes(stage.类型)) {
      floor = Math.max(floor, STAGE_TYPES.indexOf(stage.类型));
      return { ...stage, 类型: stage.类型 };
    }
    let type = canonicalStageType(stage.名称, index, total);
    let rank = STAGE_TYPES.indexOf(type);
    if (rank < floor) { type = STAGE_TYPES[floor]; rank = floor; }
    floor = rank;
    return { ...stage, 类型: type };
  });
}
