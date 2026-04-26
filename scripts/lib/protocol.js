/**
 * protocol.js - LobsterMail 协议
 * 
 * 邮件主题格式: [LOBSTER] <TYPE>:<FROM>→<TO> | <TASK_ID> | <PRIORITY>
 * 邮件正文格式: JSON (lobster-mail-v1)
 * 签名算法: HMAC-SHA256
 */

const crypto = require('crypto');

const PROTOCOL_VERSION = 'lobster-mail-v1';
const SUBJECT_PREFIX = '[LOBSTER]';

const MSG_TYPES = ['CMD', 'ACK', 'RESULT', 'ERROR', 'EXPIRED', 'HELLO', 'GOODBYE', 'DISCUSS', 'CONCLUDE'];

// 讨论角色定义
const DISCUSS_ROLES = {
  challenger:  { name: '找茬者',   desc: '专门反对、挑毛病、找漏洞' },
  researcher:  { name: '搜索者',   desc: '必须搜索网络找证据或案例才回答' },
  detailer:    { name: '细节控',   desc: '纠细节、算数字、查一致性' },
  divergent:   { name: '发散者',   desc: '天马行空、提可能性、防思维定势' },
  pragmatist:  { name: '务实者',   desc: '只关心能不能落地、成本多少' },
  synthesizer: { name: '归纳者',   desc: '梳理各方观点、找共识、整理结论' },
  observer:    { name: '旁观者',   desc: '不参与讨论，只记录和观察' }
};
const PRIORITIES = ['HIGH', 'NORMAL', 'LOW'];

/**
 * 构造邮件主题
 * 格式: [LOBSTER] CMD:A001→B002 | A001_20260425140000_f3a2 | HIGH
 */
function buildSubject(type, from, to, taskId, priority) {
  priority = priority || 'NORMAL';
  // CLIXML防御：不throw到stderr，改为返回null让调用方处理
  if (!MSG_TYPES.includes(type)) return null;
  if (!PRIORITIES.includes(priority)) return null;
  return `${SUBJECT_PREFIX} ${type}:${from}→${to} | ${taskId} | ${priority}`;
}

/**
 * 解析邮件主题
 * 返回: { type, from, to, taskId, priority } 或 null
 */
function parseSubject(subject) {
  if (!subject || !subject.startsWith(SUBJECT_PREFIX)) return null;
  
  try {
    const rest = subject.substring(SUBJECT_PREFIX.length).trim();
    // CMD:A001→B002 | A001_20260425140000_f3a2 | HIGH
    const parts = rest.split('|').map(s => s.trim());
    if (parts.length < 3) return null;
    
    // 解析 TYPE:FROM→TO
    const headerParts = parts[0].split(':');
    if (headerParts.length !== 2) return null;
    
    const type = headerParts[0].trim();
    const fromTo = headerParts[1].trim();
    const arrowIdx = fromTo.indexOf('→');
    if (arrowIdx === -1) return null;
    
    const from = fromTo.substring(0, arrowIdx).trim();
    const to = fromTo.substring(arrowIdx + 1).trim();
    const taskId = parts[1].trim();
    const priority = parts[2].trim();
    
    if (!MSG_TYPES.includes(type)) return null;
    if (!PRIORITIES.includes(priority)) return null;
    
    return { type, from, to, taskId, priority };
  } catch (e) {
    return null;
  }
}

/**
 * 构造完整的邮件正文JSON
 */
function buildBody(options) {
  const {
    from, to, taskId, type, priority,
    body, timeoutMin, replyToTaskId, retryCount,
    senderRole, sharedSecret, threadId
  } = options;
  
  const msg = {
    protocol: PROTOCOL_VERSION,
    from: from,
    to: to,
    task_id: taskId,
    thread_id: threadId || null,
    type: type,
    priority: priority || 'NORMAL',
    timestamp: new Date().toISOString(),
    body: body || {},
    timeout_min: timeoutMin || 30,
    reply_to_task_id: replyToTaskId || null,
    retry_count: retryCount || 0,
    sender_role: senderRole || null,
    signature: ''  // 占位，后面计算
  };
  
  // 计算签名
  msg.signature = computeSignature(msg, sharedSecret);
  
  return msg;
}

/**
 * 计算HMAC-SHA256签名
 * sign_content = from + to + task_id + type + timestamp + JSON.stringify(body)
 */
function computeSignature(msg, sharedSecret) {
  const signContent = msg.from + msg.to + msg.task_id + (msg.thread_id || '') + msg.type + msg.timestamp + JSON.stringify(msg.body);
  return crypto.createHmac('sha256', sharedSecret).update(signContent).digest('hex');
}

/**
 * 验证签名
 */
function verifySignature(msg, sharedSecret) {
  if (!msg || !msg.signature) return false;
  const expectedSig = computeSignature(msg, sharedSecret);
  // 使用时间安全比较
  if (msg.signature.length !== expectedSig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(msg.signature), Buffer.from(expectedSig));
}

/**
 * 解析邮件正文JSON
 * 返回: 解析后的对象 或 null
 */
function parseBody(text) {
  if (!text) return null;
  try {
    let cleanText = text.trim();
    // 163邮箱可能在JSON后面追加广告文本，严格匹配：找第一个 { 和最后一个 }
    const firstBrace = cleanText.indexOf('{');
    const lastBrace = cleanText.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    cleanText = cleanText.substring(firstBrace, lastBrace + 1);
    
    const parsed = JSON.parse(cleanText);
    if (parsed.protocol !== PROTOCOL_VERSION) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

/**
 * 检查邮件是否已超时
 */
function isExpired(msg, taskTimeoutMin) {
  const sentTime = new Date(msg.timestamp).getTime();
  const timeoutMs = (taskTimeoutMin || 30) * 60 * 1000;
  return Date.now() - sentTime > timeoutMs;
}

/**
 * 验证消息基本完整性
 */
function validateMessage(msg) {
  if (!msg) return { valid: false, error: '消息为空' };
  if (!msg.protocol || msg.protocol !== PROTOCOL_VERSION) return { valid: false, error: '协议版本不匹配' };
  if (!msg.from) return { valid: false, error: '缺少from字段' };
  if (!msg.to) return { valid: false, error: '缺少to字段' };
  if (!msg.task_id) return { valid: false, error: '缺少task_id字段' };
  if (!msg.type || !MSG_TYPES.includes(msg.type)) return { valid: false, error: `无效的type: ${msg.type}` };
  if (!msg.timestamp) return { valid: false, error: '缺少timestamp字段' };
  if (!msg.signature) return { valid: false, error: '缺少signature字段' };
  return { valid: true };
}

module.exports = {
  PROTOCOL_VERSION,
  SUBJECT_PREFIX,
  MSG_TYPES,
  PRIORITIES,
  DISCUSS_ROLES,
  buildSubject,
  parseSubject,
  buildBody,
  computeSignature,
  verifySignature,
  parseBody,
  isExpired,
  validateMessage
};
