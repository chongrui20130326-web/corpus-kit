import fs from 'node:fs';

/** 工具里统一从环境变量取模型配置：工作流水线选什么模型，工具就用什么。 */
export function toolLlmConfig() {
  return {
    baseUrl: process.env.CORPUS_BASE_URL || 'http://127.0.0.1:8090/v1',
    apiKey: process.env.CORPUS_API_KEY || 'local',
    model: process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K',
    timeoutMs: Number(process.env.CORPUS_TIMEOUT || 900000),
    reasoningEffort: 'none',
    jsonMode: true,
  };
}

export function toolModelName() {
  return process.env.CORPUS_MODEL || 'qwen3.5:9b-uncensored-q8_0_64K';
}

// 兼容：脚本被直接 import 时不做事
export default { toolLlmConfig, toolModelName };
