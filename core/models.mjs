/**
 * 模型目录。
 *
 * 从 NovelStyle 那套（src/services/localModelPolicy.ts）搬过来：
 * Qwen3.8 的三个量化版本各自跑在一个 Strata 服务上（OpenAI 兼容 /v1），
 * Qwen3.5 走本地 Ollama（原生 /api/chat）。两边协议不同，所以这里统一登记。
 */

export const STRATA_MODELS = [
  {
    id: 'orcarouter-qwen3.8-flash-next-uncensored-iq2_xxs',
    label: 'Qwen3.8-Flash-Next Uncensored IQ2_XXS · Strata',
    short: 'Qwen3.8-Flash-Next Uncensored IQ2_XXS',
    quant: 'IQ2_XXS',
    provider: 'strata',
    baseUrl: 'http://127.0.0.1:8080/v1',
  },
  {
    id: 'orcarouter-qwen3.8-flash-next-uncensored-iq3_xxs',
    label: 'Qwen3.8-Flash-Next Uncensored IQ3_XXS · Strata',
    short: 'Qwen3.8-Flash-Next Uncensored IQ3_XXS',
    quant: 'IQ3_XXS',
    provider: 'strata',
    baseUrl: 'http://127.0.0.1:8082/v1',
  },
  {
    id: 'orcarouter-qwen3.8-flash-next-uncensored-q4_k_s',
    label: 'Qwen3.8-Flash-Next Uncensored Q4_K_S · Strata',
    short: 'Qwen3.8-Flash-Next Uncensored Q4_K_S',
    quant: 'Q4_K_S',
    provider: 'strata',
    baseUrl: 'http://127.0.0.1:8084/v1',
  },
];

/**
 * 云端 API 模型（OpenAI 兼容）。
 * 上下文比本地大一个数量级，所以每块的字符预算也能放大，调用次数少很多。
 */
export const API_MODELS = [
  {
    id: 'api:deepseek-chat',
    apiName: 'deepseek-chat',
    label: 'DeepSeek Chat · API',
    short: 'DeepSeek Chat',
    provider: 'api',
    baseUrl: 'https://api.deepseek.com/v1',
    chunkChars: 12000,
    contextTokens: 65536,
  },
  {
    id: 'api:deepseek-reasoner',
    apiName: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner · API',
    short: 'DeepSeek Reasoner',
    provider: 'api',
    baseUrl: 'https://api.deepseek.com/v1',
    chunkChars: 12000,
    contextTokens: 65536,
  },
];

export function findApiModel(id) {
  const key = String(id || '');
  return API_MODELS.find((model) => model.id === key || model.apiName === key) || null;
}

export const OLLAMA_FALLBACKS = [
  { id: 'qwen3.5:9b-uncensored', label: 'Qwen3.5-9B 非审查版 · Ollama', short: 'Qwen3.5-9B 非审查版' },
  { id: 'qwen3.5:4b', label: 'Qwen3.5-4B · Ollama', short: 'Qwen3.5-4B' },
];

/** 同一个模型可能带别名，统一解析。 */
export function resolveModel(id) {
  const model = String(id || '').trim();
  if (model === 'qwen3.8-flash-next-iq2_xs' || model === 'Qwen3.8-27B-RANA-abliterated-IQ3_XXS') {
    return STRATA_MODELS[0].id;
  }
  return model;
}

export function findModel(id) {
  const resolved = resolveModel(id);
  return STRATA_MODELS.find((model) => model.id === resolved) || null;
}

export function isStrataModel(id) {
  return Boolean(findModel(id));
}

export function modelLabel(id) {
  const resolved = resolveModel(id);
  if (resolved.startsWith('api:')) return `${resolved.slice(4)} · API`;
  const api = findApiModel(resolved);
  if (api) return api.label;
  const strata = findModel(resolved);
  if (strata) return strata.label;
  const known = OLLAMA_FALLBACKS.find((model) => model.id === resolved);
  return known ? known.label : `${resolved} · Ollama`;
}
