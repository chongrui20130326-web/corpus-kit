/**
 * 色情抽取结果的清洗规则。
 *
 * 9B 模型不太守规矩：会把脚上的水泡当"身体描写"、把"扒衣服"当姿势、
 * 还会把女性的私处描写记到男性头上。这里用确定性规则纠一遍。
 */

const BODY_PARTS = new Set(['口舌', '唇', '颈', '肩', '背', '腰', '腹', '臀', '腿', '足', '乳', '乳头', '阴户', '阴蒂', '阴道', '肛', '手', '肌肤', '毛发']);
const PART_ALIAS = { 嘴唇: '唇', 舌: '口舌', 乳房: '乳', 屁股: '臀', 脚: '足', 鸡巴: '阴茎', 肉棒: '阴茎', 花穴: '阴户', 蜜穴: '阴户', 小穴: '阴户', 肉穴: '阴户' };
const POSES = new Set(['正面', '后背', '侧入', '坐姿', '站立', '口交', '肛交', '骑乘', '69', '手交', '后入', '传教士']);
const DAILY = /水泡|包\b|车门|关上车|灯|针|鞋|袜子|饭碗|筷子|手机|钥匙/;
const SEXY_TALK = /骚|操|插|射|穴|肉棒|鸡巴|奶子|乳房|乳头|硬了|湿|好爽|轻点|用力|高潮|后面|里面|舔|含住|顶到|干我|干死|要去了|不行了/;
const FEMALE_ONLY = new Set(['乳', '乳头', '阴户', '阴蒂', '阴道', '毛发']);
const MALE_ONLY = new Set(['阴茎', '龟头']);

export const FEMALE_NAMES = new Set(['解婧', '许婉玉', '余柳薇', '韩小颖', '姚丽丽', '慕容清秋', '虹姐', '江莱', '武君怡', '彤彤', '彪嫂', '孙莎莎', '丽丽', '小薇', '王英', '倪若芸', '许婉玉']);

function normalizePart(part) {
  const text = String(part || '').trim();
  if (BODY_PARTS.has(text)) return text;
  if (PART_ALIAS[text]) return PART_ALIAS[text];
  for (const [alias, target] of Object.entries(PART_ALIAS)) {
    if (text.includes(alias)) return target;
  }
  return '';
}

function normalizePose(pose) {
  const text = String(pose || '').trim();
  if (POSES.has(text)) return text;
  const hit = [...POSES].find((item) => text.includes(item));
  return hit || '';
}

/** 清洗一条场景结果；participants 来自 P4 分析，用来纠正归属。 */
export function sanitizeScene(item, sceneId, participants = []) {
  const people = participants.filter(Boolean);
  const femaleInScene = people.find((name) => FEMALE_NAMES.has(name));

  let person = String(item.人物 || '').trim();

  const body = (item.身体 || []).map((entry) => {
    const part = normalizePart(entry.部位);
    const quote = String(entry.引文 || '');
    if (!part || !quote || DAILY.test(quote)) return null;
    if (FEMALE_ONLY.has(part) && !FEMALE_NAMES.has(person) && femaleInScene) person = femaleInScene;
    return { 部位: part, 描写: String(entry.描写 || '').slice(0, 60), 引文: quote };
  }).filter(Boolean);

  const poses = [];
  const seenPose = new Set();
  for (const entry of item.姿势 || []) {
    const raw = typeof entry === 'string' ? entry : entry?.姿势;
    const pose = normalizePose(raw);
    if (!pose || seenPose.has(pose)) continue;
    seenPose.add(pose);
    poses.push({ 姿势: pose, 引文: String(entry?.引文 || '') });
  }

  const talk = (item.淫语 || [])
    .map((entry) => String(entry?.原话 || '').trim())
    .filter((line) => line.length >= 4 && SEXY_TALK.test(line));

  const reactions = (item.性反应 || []).filter((entry) => entry && (entry.引文 || entry.反应));

  const sensitive = (item.敏感点 || []).map((entry) => {
    const part = normalizePart(entry?.部位);
    if (!part) return null;
    return { 部位: part, 引文: String(entry?.引文 || '') };
  }).filter(Boolean);

  const toys = (item.性用品 || []).filter((entry) => entry && entry.引文 && /套|润滑|跳蛋|绳|镜|相机|玩具/.test(String(entry.物 || entry.引文)));

  if (!body.length && !poses.length && !talk.length) return null;

  return { 人物: person, 身体: body, 姿势: poses, 淫语: talk, 性反应: reactions, 敏感点: sensitive, 性用品: toys };
}
