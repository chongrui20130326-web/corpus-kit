/**
 * 离线 mock：不访问网络，按步骤返回结构合法的数据。
 *
 * 存在的意义是让流水线可以被验证（校验器、回填、查询、断点续跑），
 * 而不是替代真实模型。mock 的数据本身没有分析价值。
 */

const EROTIC_HINTS = /吻|唇|舌|胸|乳|腰|腿|手|抱|压|喘|喘|湿|热|颤|呻吟|脱|衣|床|进|含|舔|摩擦|紧|痛|快感|战栗|瘫|软/;

function sentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?；;])/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstSentence(text) {
  return sentences(text)[0] || String(text || '').slice(0, 40);
}

function looksErotic(text) {
  const hits = String(text || '').match(new RegExp(EROTIC_HINTS.source, 'g'));
  return (hits?.length ?? 0) >= 2;
}

export function mockResponse(step, meta = {}) {
  switch (step) {
    case 'P1': {
      const paragraphs = meta.paragraphs || [];
      return {
        chapter: meta.chapter,
        paragraphs: paragraphs.map((paragraph) => ({
          id: paragraph.id,
          类型: looksErotic(paragraph.text) ? '情色' : '过场',
          概括: `${looksErotic(paragraph.text) ? '出现身体接触与情欲反应' : '推进情节，无性内容'}（${paragraph.text.length}字）`,
        })),
        章末状态: { 关系: '暧昧', 心理: '动摇', 权力: '对等', 身体熟悉度: '初识' },
      };
    }

    case 'P2': {
      const segments = meta.segments || [];
      const scenes = [];
      let cursor = null;
      for (const segment of segments) {
        if (segment.类型 !== '情色') {
          if (cursor) { scenes.push(cursor); cursor = null; }
          continue;
        }
        if (cursor && cursor.章 === segment.章) {
          cursor.到 = segment.到;
        } else {
          if (cursor) scenes.push(cursor);
          cursor = { 章: segment.章, 从: segment.从, 到: segment.到, 参与者: ['主角', '对方'], 场所: '室内' };
        }
      }
      if (cursor) scenes.push(cursor);
      if (scenes.length === 0 && segments.length) {
        const first = segments[0];
        scenes.push({ 章: first.章, 从: first.从, 到: first.到, 参与者: ['主角', '对方'], 场所: '室内' });
      }
      return {
        scenes: scenes.map((scene, index) => ({
          sceneId: `S${String(index + 1).padStart(2, '0')}`,
          章: scene.章,
          从: scene.从,
          到: scene.到,
          参与者: scene.参与者,
          场所: scene.场所,
          是否含情色: true,
        })),
      };
    }

    case 'P3': {
      const total = meta.chapterCount || 1;
      const names = ['疏离期', '试探期', '妥协期', '沉溺期', '余波期'];
      const count = Math.min(Math.max(3, Math.ceil(total / 3)), 5, total || 1);
      const stages = [];
      for (let index = 0; index < count; index += 1) {
        const from = Math.floor((index * total) / count) + 1;
        const to = Math.floor(((index + 1) * total) / count);
        if (to < from) continue;
        stages.push({
          名称: names[index % names.length],
          章范围: [String(from), String(to)],
          起始状态: index === 0 ? '疏离' : '动摇',
          结束状态: index === count - 1 ? '沉溺' : '动摇加深',
          核心矛盾: '欲望与自我认知的冲突',
        });
      }
      return { 阶段: stages, 候选转折: stages.slice(1).map((stage) => ({ 章: Number(stage.章范围[0]), 事件: '关系推进', 为什么是转折: '状态跳变' })) };
    }

    case 'P4': {
      const text = meta.text || '';
      const sentence = firstSentence(text);
      return {
        sceneId: meta.sceneId,
        参与者: [
          { 角色: '主角', 身份: '当事人', 初始状态: '抗拒', 动机: '想停下', 怕什么: '承认自己想要' },
          { 角色: '对方', 身份: '促成者', 初始状态: '主动', 动机: '逼近', 怕什么: '被拒绝' },
        ],
        权力: '半推半就',
        阶段: '前戏',
        场所: '室内',
        是否首次: false,
        轨迹: { 起点: '抗拒', 终点: '默许', 触发句: sentence, 触发类型: '身体先于意志反应' },
        节拍: [
          { 序: 1, 动作: '靠近', 谁主动: '对方' },
          { 序: 2, 动作: '后退半步', 谁主动: '主角' },
        ],
        反应链: [
          { 刺激: '对方的靠近', 心理: '不该这样', 生理: '呼吸乱了', 神态: '别开眼', 言语: '别', 证据: sentence },
        ],
        转折句: sentence,
      };
    }

    case 'P6': {
      const sceneIds = meta.sceneIds || [];
      const coarse = meta.coarseStages || [];
      const names = coarse.map((stage) => stage.名称);
      const fallback = names.length ? names : ['抗拒期', '妥协期', '沉溺期'];
      const perStage = Math.max(1, Math.ceil(sceneIds.length / fallback.length));
      const stages = fallback.map((name, index) => ({
        名称: name,
        场景: sceneIds.slice(index * perStage, (index + 1) * perStage),
        起始状态: index === 0 ? '疏离' : '动摇',
        结束状态: index === fallback.length - 1 ? '沉溺' : '动摇加深',
        核心矛盾: '欲望与自我认知的冲突',
      })).filter((stage) => stage.场景.length > 0);
      const positions = stages.flatMap((stage) => stage.场景.map((sceneId) => ({
        sceneId,
        所属阶段: stage.名称,
        是否阶段转换: sceneId === stage.场景[0],
        位移方向: '前进',
      })));
      return {
        阶段: stages,
        场景定位: positions,
        初次突破: sceneIds.length
          ? { sceneId: sceneIds[0], 前期铺垫: '长期共处', 抵抗方式: '回避', 突破口: '一次独处' }
          : null,
      };
    }

    case 'P7': {
      const text = meta.text || '';
      const sentence = firstSentence(text);
      return {
        sceneId: meta.sceneId,
        承载句: [{ 句: sentence, 承担: '把抗拒推向默许', 功能: '反应' }],
        功能序列: ['触觉起', '反应', '对话', '收束'],
        手法: { 视角: '第三人称限知', 节奏: '慢镜头', 感官配比: ['触觉', '听觉'], 比喻类型: '', 留白位置: '转折后' },
        金句: sentence,
      };
    }

    case 'P8': {
      const text = meta.text || '';
      const sentence = firstSentence(text);
      return {
        sceneId: meta.sceneId,
        突破前: { 关系: '暧昧', 心理: '抗拒', 权力: '对等', 身体熟悉度: '初识' },
        触发事件: '独处与一次意外接触',
        抵抗方式: ['回避视线', '口头拒绝'],
        抵抗到放弃的转折点: sentence,
        突破口: '对方没有停下',
        突破后即时反应: '沉默，随后不再拒绝',
      };
    }

    default:
      throw new Error(`mock 未实现的步骤：${step}`);
  }
}
