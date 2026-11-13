/**
 * 按步骤路由模型。
 *
 * 一本书里各步的成本差得很远：P1 要给每一段打标签（调用最多），
 * P4/P7/PC 只按场景跑（调用少，但直接决定质量）。
 * 所以允许「P1 用本地、其余用云端」，把成本压到最低、质量保住。
 *
 * 所有调用都会带 step 字段（P1/P2/P4/PC/PS/P7/PE…），这里只做一次分发。
 */
export function routeByStep(defaultLlm, map = {}) {
  if (!map || !Object.keys(map).length) return defaultLlm;
  return {
    model: defaultLlm.model,
    async chat(options) {
      const target = map[options.step];
      return (target || defaultLlm).chat(options);
    },
  };
}

/** 把 stepModels 里出现的模型去重，方便一次性建好客户端。 */
export function uniqueStepModels(stepModels = {}) {
  return [...new Set(Object.values(stepModels).filter(Boolean))];
}
