// These rules identify known risks, not proof that text is safe to share.
const RULES = [
  ['credential', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----|\bsk-[a-z0-9_-]{16,}|\bgh[pousr]_[a-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[a-z0-9._~+/-]{12,}|(?:密码|口令|验证码|动态码|短信码|支付密码|CVV|password|passwd|otp|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|SESSDATA|bili_jct|cookie)\s*(?:[：:=是为]|\s)\s*[^\s，。；;、]{3,}/i],
  ['identity', /(?:身份证(?:号|正反面|照片)?|护照(?:号|照片)?|指纹|人脸|手持身份证|银行卡|信用卡|驾照|车牌|门禁卡|工牌)/i],
  ['identity-number', /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dx](?!\d)/i],
  ['contact', /(?<!\d)1[3-9]\d{9}(?!\d)|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|(?:手机号|电话号码|联系方式|微信号|QQ号|群号)\s*[：:=是为]?\s*[a-z0-9_-]{5,}/i],
  ['address-location', /(?:地址|住址|门牌号|门禁密码|实时位置|定位在|住在|家住|快递单|外卖单|登机牌|机票|车票)/i],
  ['child', /(?:孩子|小孩|儿童|未成年|儿子|女儿).{0,30}(?:全名|名字|姓名|学校|班级|作息|路线|校服|定位|行程)|(?:学校|班级|作息|路线|校服|定位|行程).{0,30}(?:孩子|小孩|儿童|未成年|儿子|女儿)/i],
  ['work', /(?:内部文件|内部资料|客户名单|客户资料|系统账号|公司机密|商业秘密|未公开文件)/i],
  ['personal-context', /(?:医院|看病|住院|诊断|病历|疾病|怀孕|心理治疗|抑郁|家庭矛盾|离婚|分手|出轨|性生活|工资|债务|欠款)/i],
  ['private', /(?:别告诉|不要告诉|不能告诉|不许告诉|仅告诉你|只告诉你|不要外传|别外传|不要公开|别公开|(?:别|不要|不能|不许|禁止|拒绝|停止|不想)(?:再|向外|对外)?(?:分享|共享|传播|转发|透露|扩散)|保密|私密照片|私人照片|私密聊天|聊天记录|通讯录|家庭矛盾|家里没人)/i],
  ['media', /\[(?:图片|语音|视频|引用消息|文件|转发消息)/i],
];

function sourceText(source) {
  return [source?.incoming, source?.reply, ...(Array.isArray(source?.messages) ? source.messages.map((message) => message?.text) : [])]
    .filter((value) => typeof value === 'string').join('\n');
}

export function assessMemoryPrivacy(candidate, sources) {
  if (!Array.isArray(sources) || !sources.length || sources.some((source) => !source || typeof source !== 'object')) {
    return { version: 1, status: 'unassessed', reasons: ['source-unavailable'] };
  }
  const values = [...sources.map(sourceText), ...['who', 'event', 'feeling'].map((field) => typeof candidate?.[field] === 'string' ? candidate[field] : '')];
  const text = values.join('\n').normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
  const reasons = RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return { version: 1, status: reasons.length ? 'restricted' : 'review', reasons };
}

export function readMemoryPrivacy(value) {
  const names = new Set(RULES.map(([name]) => name));
  if (!value || value.version !== 1 || !['restricted', 'review'].includes(value.status) ||
      !Array.isArray(value.reasons) || value.reasons.some((reason) => !names.has(reason)) ||
      (value.status === 'review' && value.reasons.length) || (value.status === 'restricted' && !value.reasons.length)) {
    return { version: 1, status: 'unassessed', reasons: ['legacy-or-invalid'] };
  }
  return { version: 1, status: value.status, reasons: [...new Set(value.reasons)] };
}

export function sourcedNickname(candidate, sources) {
  const person = typeof candidate?.who === 'string' ? candidate.who.normalize('NFKC').trim() : '';
  if (!person || /[\p{C}]|\d{5,}|https?:\/\/|www\./iu.test(person) || /^\d+$/u.test(person)) return undefined;
  return sources.some(({ messages }) => Array.isArray(messages) && messages.some((message) =>
    typeof message?.senderNickname === 'string' && message.senderNickname.normalize('NFKC').trim() === person))
    ? person : undefined;
}

export function shareSummaryIsUsable(summary, candidate, sources) {
  if (typeof summary !== 'string' || !summary.trim() || Array.from(summary).length > 160 || /[\r\n]/.test(summary)) return false;
  if (assessMemoryPrivacy({ ...candidate, event: summary }, sources).status !== 'review') return false;
  const normalized = summary.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const person = typeof candidate?.who === 'string' ? candidate.who.normalize('NFKC').trim() : '';
  if (/(?:https?:\/\/|www\.|(?<!\d)\d{5,20}(?!\d))/i.test(normalized) ||
      (Array.from(person).length >= 2 && normalized.includes(person) && !sourcedNickname(candidate, sources))) return false;
  // A proposed abstraction must not simply reproduce a message from the source.
  return !sources.some((source) => [source?.incoming, source?.reply, ...(Array.isArray(source?.messages) ? source.messages.map((m) => m?.text) : [])]
    .some((text) => {
      if (typeof text !== 'string') return false;
      const original = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
      return original === normalized || (Array.from(normalized).length >= 8 && original.includes(normalized)) ||
        (Array.from(original).length >= 8 && normalized.includes(original));
    }));
}

export function defaultSharedSummary(candidate, sources) {
  if (candidate?.sharingDecision === 'private' || readMemoryPrivacy(candidate?.privacy).status !== 'review') return null;
  if (typeof candidate?.event !== 'string') return null;
  const person = typeof candidate.who === 'string' ? candidate.who.normalize('NFKC').trim() : '';
  if (sourcedNickname(candidate, sources)) {
    const summary = candidate.event.trim();
    return shareSummaryIsUsable(summary, candidate, sources) ? summary : null;
  }
  if (/[、，,;/&]|(?:和|与|及|跟)|\b(?:and|or)\b/i.test(person) ||
      (Array.from(person).length === 1 && !/^[我他她]$/.test(person))) return null;
  const event = candidate.event.normalize('NFKC');
  const summary = (Array.from(person).length >= 2 && event !== person ? event.split(person).join('一位对话者') : event)
    .replace(/^(?:我(?:们)?|他(?:们)?|她(?:们)?|你(?:们)?|I\b|we\b|you\b)/i, '一位对话者');
  return shareSummaryIsUsable(summary, candidate, sources) ? summary.trim() : null;
}
