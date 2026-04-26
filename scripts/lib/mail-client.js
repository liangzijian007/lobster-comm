/**
 * mail-client.js - IMAP/SMTP 邮件客户端封装
 * 
 * v2 改进:
 * - 两阶段fetch: Phase1只取envelope过滤，Phase2按需取source
 * - CMD自动移出INBOX到LOBSTER_DONE
 * - EXPIRED消息处理: 写入过期黑名单
 * - 增量poll: 用last_poll_time替代7天硬编码
 * - poll超时保护: 整体60秒超时
 * - INBOX邮件数告警: >20条时返回warning
 * - 邮件大小预检: 超过max_mail_size_kb跳过
 * - 轻量cleanup: poll末尾LOBSTER_DONE>50时批量删除
 * - 非LOBSTER未读邮件也标记已读（避免反复拉取）
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const protocol = require('./protocol');
const config = require('./config');

const POLL_TIMEOUT_MS = 60 * 1000;  // poll总超时60秒

// ============================================================
// CLIXML防御：debug日志写文件，不写stderr
// PowerShell会将stderr包裹为CLIXML格式，污染JSON输出
// ============================================================
const DEBUG = process.env.LOBSTER_DEBUG === '1';
const fs = require('fs');
const path = require('path');
const os = require('os');
const DEBUG_LOG = path.join(os.homedir(), '.config', 'lobster-comm', 'debug.log');

function debugLog(...args) {
  if (!DEBUG) return;
  try {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
    fs.appendFileSync(DEBUG_LOG, line);
  } catch (e) { /* 静默，绝不写stderr */ }
}

/**
 * 创建IMAP客户端
 */
function createImapClient(emailConfig) {
  return new ImapFlow({
    host: emailConfig.imap_host,
    port: emailConfig.imap_port,
    secure: true,
    auth: {
      user: emailConfig.account,
      pass: emailConfig.auth_code
    },
    logger: false,
    emitLogs: false
  });
}

/**
 * 创建SMTP传输器
 */
function createSmtpTransporter(emailConfig) {
  return nodemailer.createTransport({
    host: emailConfig.smtp_host,
    port: emailConfig.smtp_port,
    secure: true,  // 163使用465端口SSL
    auth: {
      user: emailConfig.account,
      pass: emailConfig.auth_code
    }
  });
}

/**
 * 测试IMAP连接
 */
async function testImapConnection(emailConfig) {
  const client = createImapClient(emailConfig);
  try {
    await client.connect();
    await client.logout();
    return { success: true, message: 'IMAP连接成功' };
  } catch (e) {
    return { success: false, message: `IMAP连接失败: ${e.message}` };
  }
}

/**
 * 测试SMTP连接
 */
async function testSmtpConnection(emailConfig) {
  const transporter = createSmtpTransporter(emailConfig);
  try {
    await transporter.verify();
    transporter.close();
    return { success: true, message: 'SMTP连接成功' };
  } catch (e) {
    return { success: false, message: `SMTP连接失败: ${e.message}` };
  }
}

/**
 * 发送LobsterMail邮件
 * 增加: 自发检测(to===from时拒绝)
 */
async function sendLobsterMail(appConfig, msgBody) {
  // 自发检测
  if (config.isSelfSend(msgBody.from, msgBody.to)) {
    return { success: false, message: `不能发指令给自己(${msgBody.from})，避免空转循环` };
  }
  
  const transporter = createSmtpTransporter(appConfig.email);
  
  const subject = protocol.buildSubject(
    msgBody.type,
    msgBody.from,
    msgBody.to,
    msgBody.task_id,
    msgBody.priority
  );
  
  // buildSubject返回null表示参数无效（不throw，避免CLIXML）
  if (!subject) {
    return { success: false, message: `无效的消息类型或优先级: type=${msgBody.type}, priority=${msgBody.priority}` };
  }
  
  const bodyText = JSON.stringify(msgBody, null, 2);
  
  try {
    const info = await transporter.sendMail({
      from: appConfig.email.account,
      to: appConfig.email.account,  // 发给自己（共享邮箱）
      subject: subject,
      text: bodyText,
      // 强制text/plain部分使用base64编码，避免163自动选择quoted-printable导致中文解码损坏
      // （simpleParser对qp编码的中文解码有bug，会损坏非ASCII字符）
      textEncoding: 'base64'
    });
    transporter.close();
    return { success: true, messageId: info.messageId };
  } catch (e) {
    transporter.close();
    return { success: false, message: `发送失败: ${e.message}` };
  }
}

/**
 * 从simpleParser结果中提取邮件正文文本
 * 
 * 163邮箱兼容性修复：
 * 1. 优先使用text/plain部分（简单可靠）
 * 2. 如果text/plain为空或JSON解析失败，降级从html部分提取
 *    （163有时把text/plain部分留空，JSON只在html中）
 * 3. 从html提取时，先去除HTML标签，再尝试解析JSON
 * 
 * @param {Object} parsed - simpleParser的解析结果
 * @returns {string} 提取的正文文本
 */
function extractBodyText(parsed) {
  if (!parsed) return '';
  
  const textContent = parsed.text || '';
  const htmlContent = parsed.html || '';
  
  // 优先尝试text/plain
  if (textContent.trim()) {
    const textJson = tryParseJson(textContent);
    if (textJson) return textContent;
  }
  
  // text/plain解析失败或为空，降级从html提取
  if (htmlContent.trim()) {
    // 去除HTML标签，保留纯文本
    const cleanHtml = htmlContent.replace(/<[^>]+>/g, '');
    const htmlJson = tryParseJson(cleanHtml);
    if (htmlJson) return cleanHtml;
  }
  
  // 都失败，返回text（让parseBody做最终处理并报错）
  return textContent;
}

/**
 * 尝试从文本中提取并解析lobster-mail JSON
 * @param {string} text - 可能包含JSON的文本
 * @returns {Object|null} 解析成功返回对象，失败返回null
 */
function tryParseJson(text) {
  if (!text) return null;
  try {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    const jsonStr = text.substring(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonStr);
    // 验证是lobster-mail格式
    if (parsed.protocol === 'lobster-mail-v1') return parsed;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 计算poll的sinceDate
 * 使用last_poll_time，回退到7天前
 */
function calcSinceDate() {
  const lastPoll = config.getLastPollTime();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // 回退5分钟，避免SMTP→IMAP同步延迟导致漏信
  const BACKWARD_MINUTES = 5;
  
  if (lastPoll) {
    const lastPollDate = new Date(lastPoll);
    // 防御：确保Date解析有效（无效字符串会产生Invalid Date）
    if (isNaN(lastPollDate.getTime())) {
      return sevenDaysAgo;
    }
    // 从lastPoll往前回退5分钟，覆盖SMTP投递延迟
    const sinceDate = new Date(lastPollDate.getTime() - BACKWARD_MINUTES * 60 * 1000);
    // last_poll_time太旧（>7天）时回退到7天
    return sinceDate > sevenDaysAgo ? sinceDate : sevenDaysAgo;
  }
  return sevenDaysAgo;
}

/**
 * 轮询邮箱，获取新的LobsterMail消息
 * 
 * v3 流程（单阶段，修复163 IMAP两阶段fetch丢数据问题）:
 * 1. 连接IMAP，开启批量模式
 * 2. 单阶段fetch: 同时取envelope+source → 本地过滤+解析+验签
 *    （163 IMAP对UID-based二次fetch不稳定，必须一次取完）
 * 3. 标记非LOBSTER未读为已读（避免反复拉取）
 * 4. 有效消息标记已读，CMD/RESULT/ERROR/EXPIRED/HELLO/GOODBYE移到对应文件夹
 * 5. 更新state，提交批量写入
 * 6. 轻量cleanup（LOBSTER_DONE>50时触发）
 */
async function pollInbox(appConfig) {
  const myId = appConfig.identity.id;
  const whitelist = appConfig.interaction.trust_whitelist || [];
  const sharedSecret = appConfig.security.shared_secret;
  const taskTimeout = appConfig.polling.task_timeout_min;
  const maxSizeKb = (appConfig.protocol && appConfig.protocol.max_mail_size_kb) || 1024;
  
  const client = createImapClient(appConfig.email);
  const validMessages = [];
  const errors = [];
  const warnings = [];
  
  // 开启批量模式
  config.beginBatch();
  
  // poll超时保护
  const pollTimeout = setTimeout(() => {
    debugLog('[poll] TIMEOUT - forcing return');
    // 超时后强制结束（如果还在等待IMAP操作，连接会被关闭）
    try { client.logout(); } catch (e) { /* 忽略 */ }
  }, POLL_TIMEOUT_MS);
  
  try {
    debugLog('[poll] Connecting...');
    await client.connect();
    debugLog('[poll] Connected');
    
    const lock = await client.getMailboxLock('INBOX');
    debugLog('[poll] Got INBOX lock');
    
    try {
      const sinceDate = calcSinceDate();
      debugLog('[poll] sinceDate:', sinceDate.toISOString());
      
      // ============================================================
      // 单阶段fetch: 同时取envelope+source（163 IMAP两阶段fetch丢数据）
      // ⚠️ source: true 底层用 BODY[]（非BODY.PEEK[]），fetch时自动标记\Seen
      //    - 处理成功的邮件：正常移到对应文件夹
      //    - 处理失败的邮件：fetch循环结束后恢复\Seen标志（下次poll重新拉取）
      //    - 如果poll中途崩溃：未处理的已读邮件会被遗漏，依赖手动cleanup处理
      // ============================================================
      debugLog('[poll] Single-phase: fetching envelope+source...');
      
      const fetchIterator = await client.fetch(
        { unseen: true, since: sinceDate },
        { envelope: true, flags: true, source: true, uid: true }
      );
      
      const nonLobsterUids = [];  // 非LOBSTER未读邮件UID
      let totalUnseen = 0;
      let matchedCount = 0;
      
      for await (const msgData of fetchIterator) {
        totalUnseen++;
        const subject = msgData.envelope ? msgData.envelope.subject : '';
        
        if (!subject || !subject.includes('[LOBSTER]')) {
          nonLobsterUids.push(msgData.uid);
          continue;
        }
        
        const subjectInfo = protocol.parseSubject(subject);
        if (!subjectInfo) {
          nonLobsterUids.push(msgData.uid);  // 格式不对的也标记已读
          continue;
        }
        
        // to字段可能是逗号分隔的多收件人（如"中枢,龙虾B"），需split后includes判断
        const toList = subjectInfo.to.split(',').map(s => s.trim()).filter(Boolean);
        if (!toList.includes(myId) && subjectInfo.to !== 'ALL') {
          continue;  // 不是给我的，也不是广播，不标记已读（其他龙虾会处理）
        }
        
        matchedCount++;
        
        // 直接解析source（不再分Phase2）
        try {
          const uid = msgData.uid;
          if (!subjectInfo) continue;
          
          // 邮件大小预检
          if (msgData.source) {
            const sizeKb = Buffer.byteLength(msgData.source) / 1024;
            if (sizeKb > maxSizeKb) {
              errors.push({ uid, error: `邮件过大(${Math.round(sizeKb)}KB>${maxSizeKb}KB)`, subject });
              continue;
            }
          }
          
          let parsed = null;
          if (msgData.source) {
            parsed = await simpleParser(msgData.source);
          }
          
          // 提取邮件正文JSON：优先从text/plain，失败则降级从html提取
          const bodyText = extractBodyText(parsed);
          const msgBody = protocol.parseBody(bodyText);
          if (!msgBody) {
            errors.push({ uid, error: '正文解析失败', subject });
            continue;
          }
          
          // 防护性解析：如果body.params是字符串，尝试JSON.parse为对象
          if (msgBody.body && msgBody.body.params && typeof msgBody.body.params === 'string') {
            try {
              msgBody.body.params = JSON.parse(msgBody.body.params);
            } catch (e) {
              // parse失败，保留原始字符串，接收方自行处理
            }
          }
          
          const validation = protocol.validateMessage(msgBody);
          if (!validation.valid) {
            errors.push({ uid, error: validation.error, subject });
            continue;
          }
          
          if (!protocol.verifySignature(msgBody, sharedSecret)) {
            errors.push({ uid, error: '签名验证失败', from: msgBody.from, task_id: msgBody.task_id });
            continue;
          }
          
          if (whitelist.length > 0 && !whitelist.includes(msgBody.from)) {
            errors.push({ uid, error: `不在白名单: ${msgBody.from}`, task_id: msgBody.task_id });
            continue;
          }
          
          // 已处理 → 跳过（task_id + type组合去重，同task_id的ACK和RESULT不互斥）
          if (config.isTaskProcessed(msgBody.task_id, subjectInfo.type)) continue;
            
            // 更新已知龙虾（从sender_role推断角色）
            const senderRole = msgBody.sender_role || (subjectInfo.type === 'CMD' || subjectInfo.type === 'EXPIRED' ? 'hub' : 'worker');
            config.updateKnownLobster(msgBody.from, senderRole);
            
            // HELLO消息特殊处理：宣告存在，提取部署信息
            if (subjectInfo.type === 'HELLO') {
              const helloBody = msgBody.body || {};
              // 用HELLO里的meta更新known_lobsters
              config.updateKnownLobster(msgBody.from, helloBody.role || senderRole, {
                host: helloBody.host || '',
                platform: helloBody.platform || '',
                user: helloBody.user || ''
              });
              debugLog(`[poll] HELLO from ${msgBody.from}: role=${helloBody.role}, host=${helloBody.host}`);
              config.addProcessedTaskId(msgBody.task_id, 'HELLO');
              // HELLO不需要回复，标记在线，直接归档
              config.markLobsterOnline(msgBody.from);
              validMessages.push({
                uid: uid,
                type: 'HELLO',
                from: msgBody.from,
                to: msgBody.to,
                task_id: msgBody.task_id,
                reply_to_task_id: null,
                priority: msgBody.priority || 'NORMAL',
                body: msgBody.body,
                timestamp: msgBody.timestamp
              });
              continue;
            }
            
            // GOODBYE消息特殊处理：对方被移除或主动退役
            if (subjectInfo.type === 'GOODBYE') {
              debugLog(`[poll] GOODBYE from ${msgBody.from}`);
              config.addProcessedTaskId(msgBody.task_id, 'GOODBYE');
              // GOODBYE不需要回复，单向通知
              validMessages.push({
                uid: uid,
                type: 'GOODBYE',
                from: msgBody.from,
                to: msgBody.to,
                task_id: msgBody.task_id,
                reply_to_task_id: null,
                priority: msgBody.priority || 'NORMAL',
                body: msgBody.body,
                timestamp: msgBody.timestamp
              });
              continue;
            }
            
            // DISCUSS消息处理：多轮讨论
            if (subjectInfo.type === 'DISCUSS') {
              debugLog(`[poll] DISCUSS from ${msgBody.from}, thread=${msgBody.thread_id}`);
              config.addProcessedTaskId(msgBody.task_id, 'DISCUSS');
              if (msgBody.from) config.markLobsterOnline(msgBody.from);
              validMessages.push({
                uid: uid,
                type: 'DISCUSS',
                from: msgBody.from,
                to: msgBody.to,
                task_id: msgBody.task_id,
                thread_id: msgBody.thread_id || null,
                reply_to_task_id: msgBody.reply_to_task_id || null,
                priority: msgBody.priority || 'NORMAL',
                body: msgBody.body,
                timestamp: msgBody.timestamp
              });
              continue;
            }
            
            // CONCLUDE消息处理：讨论结束
            if (subjectInfo.type === 'CONCLUDE') {
              debugLog(`[poll] CONCLUDE from ${msgBody.from}, thread=${msgBody.thread_id}`);
              config.addProcessedTaskId(msgBody.task_id, 'CONCLUDE');
              if (msgBody.from) config.markLobsterOnline(msgBody.from);
              validMessages.push({
                uid: uid,
                type: 'CONCLUDE',
                from: msgBody.from,
                to: msgBody.to,
                task_id: msgBody.task_id,
                thread_id: msgBody.thread_id || null,
                reply_to_task_id: msgBody.reply_to_task_id || null,
                priority: msgBody.priority || 'NORMAL',
                body: msgBody.body,
                timestamp: msgBody.timestamp
              });
              continue;
            }
            
            // EXPIRED消息特殊处理：写入过期黑名单
            if (subjectInfo.type === 'EXPIRED') {
              const expiredTaskId = msgBody.reply_to_task_id;
              if (expiredTaskId) {
                config.addExpiredTaskId(expiredTaskId);
                debugLog(`[poll] EXPIRED: task ${expiredTaskId} marked as expired`);
              }
              config.addProcessedTaskId(msgBody.task_id, 'EXPIRED');
              // EXPIRED不需要回复，直接归档
              validMessages.push({
                uid: uid,
                type: 'EXPIRED',
                from: msgBody.from,
                to: msgBody.to,
                task_id: msgBody.task_id,
                reply_to_task_id: msgBody.reply_to_task_id,
                priority: msgBody.priority || 'NORMAL',
                body: msgBody.body,
                timestamp: msgBody.timestamp
              });
              continue;
            }
            
            // CMD类型：检查是否已过期（在expired_task_ids中）
            if (subjectInfo.type === 'CMD' && config.isTaskExpired(msgBody.task_id)) {
              debugLog(`[poll] CMD expired (in blacklist): ${msgBody.task_id}`);
              config.addProcessedTaskId(msgBody.task_id, 'CMD');
              // 移到ERROR文件夹
              try { await client.messageMove(uid, 'LOBSTER_ERROR', { uid: true }); } catch (e) { /* 忽略 */ }
              continue;
            }
            
            // 超时检查
            if (protocol.isExpired(msgBody, taskTimeout)) {
              errors.push({ uid, error: '任务已超时', task_id: msgBody.task_id });
              config.addProcessedTaskId(msgBody.task_id, subjectInfo.type);
              continue;
            }
            
            // 记录为已处理（task_id + type组合去重）
            config.addProcessedTaskId(msgBody.task_id, subjectInfo.type);
            
            // 收到ACK/RESULT/ERROR → 发送方恢复在线
            if (['ACK', 'RESULT', 'ERROR'].includes(subjectInfo.type) && msgBody.from) {
              config.markLobsterOnline(msgBody.from);
            }
            
            // 加入有效消息列表
            validMessages.push({
              uid: uid,
              type: subjectInfo.type,
              from: msgBody.from,
              to: msgBody.to,
              task_id: msgBody.task_id,
              reply_to_task_id: msgBody.reply_to_task_id,
              priority: msgBody.priority,
              body: msgBody.body,
              timeout_min: msgBody.timeout_min,
              retry_count: msgBody.retry_count,
              timestamp: msgBody.timestamp
            });
            
          } catch (e) {
            errors.push({ uid: msgData.uid, error: `处理邮件异常: ${e.message}` });
          }
      }
      
      debugLog(`[poll] Fetch done: total=${totalUnseen}, matched=${matchedCount}, valid=${validMessages.length}, nonLobster=${nonLobsterUids.length}`);
      
      // INBOX [LOBSTER]邮件数告警
      if (matchedCount > 20) {
        warnings.push(`INBOX中[LOBSTER]未读邮件${matchedCount}封，可能有积压`);
      }
      
      // 标记非LOBSTER未读邮件为已读（避免每次poll都拉取）
      if (nonLobsterUids.length > 0) {
        try {
          await client.messageFlagsAdd(nonLobsterUids, ['\\Seen'], { uid: true });
          debugLog(`[poll] Marked ${nonLobsterUids.length} non-LOBSTER emails as seen`);
        } catch (flagErr) {
          debugLog('[poll] Non-LOBSTER flag failed:', flagErr.message);
        }
      }
      
      // ============================================================
      // 写操作：标记已读 + 移动邮件
      // ============================================================
      for (const msg of validMessages) {
        try {
          await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          
          // ACK处理：不在此处移除pending_ack，由lobster-comm.js的cmdPoll统一处理
          // （v3: cmdPoll负责将pending_ack移到pending_results）
          
          // RESULT/ERROR/EXPIRED：移动到LOBSTER_DONE
          if (msg.type === 'RESULT' || msg.type === 'ERROR' || msg.type === 'EXPIRED') {
            // v3: 不在此处移除pending_result，由lobster-comm.js的cmdPoll统一处理
            await client.messageMove(msg.uid, 'LOBSTER_DONE', { uid: true });
          }
          
          // CMD：标记已读 + 移动到LOBSTER_DONE（v2改进：自动移出INBOX）
          if (msg.type === 'CMD') {
            await client.messageMove(msg.uid, 'LOBSTER_DONE', { uid: true });
          }
          
          // ACK也移到LOBSTER_DONE
          if (msg.type === 'ACK') {
            await client.messageMove(msg.uid, 'LOBSTER_DONE', { uid: true });
          }
          
          // HELLO/GOODBYE也移到LOBSTER_DONE
          if (msg.type === 'HELLO' || msg.type === 'GOODBYE') {
            await client.messageMove(msg.uid, 'LOBSTER_DONE', { uid: true });
          }
          
          // DISCUSS/CONCLUDE也移到LOBSTER_DONE
          if (msg.type === 'DISCUSS' || msg.type === 'CONCLUDE') {
            await client.messageMove(msg.uid, 'LOBSTER_DONE', { uid: true });
          }
          
        } catch (actionErr) {
          debugLog(`[poll] Action failed for uid ${msg.uid}:`, actionErr.message);
        }
      }
      
      // ============================================================
      // 恢复处理失败邮件的未读状态
      // source: true 底层用 BODY[] 而非 BODY.PEEK[]，fetch时自动标记\Seen
      // 如果邮件解析失败，需要移除\Seen标志，确保下次poll能重新拉取
      // ============================================================
      const errorUids = errors.filter(e => e.uid).map(e => e.uid);
      if (errorUids.length > 0) {
        try {
          await client.messageFlagsRemove(errorUids, ['\\Seen'], { uid: true });
          debugLog(`[poll] Restored \\Seen for ${errorUids.length} error emails`);
        } catch (flagErr) {
          debugLog('[poll] Failed to restore \\Seen for error emails:', flagErr.message);
        }
      }
      
    } finally {
      lock.release();
      debugLog('[poll] Lock released');
    }
    
    // logout单独处理
    try {
      await client.logout();
      debugLog('[poll] Logged out');
    } catch (logoutErr) {
      debugLog('[poll] Logout failed:', logoutErr.message);
    }
    
    // 更新last_poll_time
    config.updateLastPollTime();
    
  } catch (e) {
    debugLog('[poll] ERROR:', e.message, e.stack?.split('\n').slice(0,2).join(' | '));
    // 即使出错也提交已收集的数据
    return { new_messages: validMessages, errors: [{ error: `IMAP操作失败: ${e.message}` }], warnings };
  } finally {
    // 清除超时定时器
    clearTimeout(pollTimeout);
    // 提交批量写入
    config.commitBatch();
  }
  
  // 轻量cleanup：LOBSTER_DONE邮件数>50时批量删除最旧的
  try {
    await lightweightCleanup(appConfig);
  } catch (e) {
    debugLog('[poll] Cleanup failed:', e.message);
  }
  
  return { new_messages: validMessages, errors: errors, warnings: warnings };
}

/**
 * 轻量cleanup：当LOBSTER_DONE邮件数>50时，删除最旧的邮件
 * 比cleanupExpiredMails更轻量，只处理DONE文件夹
 */
async function lightweightCleanup(appConfig) {
  const THRESHOLD = 50;
  
  const client = createImapClient(appConfig.email);
  try {
    await client.connect();
    
    try {
      const lock = await client.getMailboxLock('LOBSTER_DONE');
      try {
        const uids = await client.search({ all: true });
        if (uids.length > THRESHOLD) {
          debugLog(`[cleanup] LOBSTER_DONE has ${uids.length} mails, deleting oldest ${uids.length - 30}`);
          // IMAP search返回的UID一般是升序的，删除最旧的
          const deleteCount = uids.length - 30;  // 保留最近30封
          const toDelete = uids.slice(0, deleteCount);
          if (toDelete.length > 0) {
            await client.messageDelete(toDelete, { uid: true });
          }
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      // LOBSTER_DONE文件夹可能不存在
    }
    
    try { await client.logout(); } catch (e) { /* 忽略 */ }
  } catch (e) {
    // 连接失败不阻塞
  }
}

/**
 * 将已处理的CMD邮件移动到LOBSTER_DONE文件夹
 * （v2中poll已自动移动，此函数保留兼容）
 */
async function moveCmdToDone(appConfig, uid) {
  const client = createImapClient(appConfig.email);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageMove(uid, 'LOBSTER_DONE', { uid: true });
    } finally {
      lock.release();
    }
    await client.logout();
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * 将异常CMD邮件移动到LOBSTER_ERROR文件夹
 */
async function moveCmdToError(appConfig, uid) {
  const client = createImapClient(appConfig.email);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageMove(uid, 'LOBSTER_ERROR', { uid: true });
    } finally {
      lock.release();
    }
    await client.logout();
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * 确保LOBSTER_DONE和LOBSTER_ERROR邮箱文件夹存在
 */
async function ensureMailboxes(client) {
  try {
    const mailboxes = await client.list();
    const existingNames = new Set();
    for (const mb of mailboxes) {
      existingNames.add(mb.name.toUpperCase());
      if (mb.path) existingNames.add(mb.path.toUpperCase());
    }
    
    if (!existingNames.has('LOBSTER_DONE')) {
      try { await client.mailboxCreate('LOBSTER_DONE'); } catch (e) { /* 忽略 */ }
    }
    if (!existingNames.has('LOBSTER_ERROR')) {
      try { await client.mailboxCreate('LOBSTER_ERROR'); } catch (e) { /* 忽略 */ }
    }
  } catch (e) {
    // 列出文件夹失败不阻塞主流程
  }
}

/**
 * 清理过期邮件（完整版，手动cleanup命令使用）
 * - LOBSTER_DONE文件夹中超过done_retention_hours的邮件
 * - LOBSTER_ERROR文件夹中超过error_retention_hours的邮件
 */
async function cleanupExpiredMails(appConfig) {
  const doneRetentionMs = (appConfig.cleanup.done_retention_hours || 24) * 60 * 60 * 1000;
  const errorRetentionMs = (appConfig.cleanup.error_retention_hours || 168) * 60 * 60 * 1000;
  const now = Date.now();
  const results = { done_deleted: 0, error_deleted: 0 };
  
  const client = createImapClient(appConfig.email);
  try {
    await client.connect();
    
    // 清理LOBSTER_DONE
    try {
      const lock = await client.getMailboxLock('LOBSTER_DONE');
      try {
        const uids = await client.search({ all: true });
        if (uids.length === 0) { lock.release(); }
        else {
          // 批量fetch envelope获取日期，不取source
          const msgIterator = await client.fetch(uids, { envelope: true, uid: true });
          const toDelete = [];
          for await (const msg of msgIterator) {
            if (msg.envelope && msg.envelope.date) {
              const msgDate = new Date(msg.envelope.date).getTime();
              if (now - msgDate > doneRetentionMs) {
                toDelete.push(msg.uid);
              }
            }
          }
          lock.release();
          // 批量删除
          if (toDelete.length > 0) {
            await client.messageDelete(toDelete, { uid: true });
            results.done_deleted = toDelete.length;
          }
        }
      } catch (e) {
        try { lock.release(); } catch (x) { /* 忽略 */ }
      }
    } catch (e) {
      // LOBSTER_DONE文件夹可能不存在
    }
    
    // 清理LOBSTER_ERROR
    try {
      const lock = await client.getMailboxLock('LOBSTER_ERROR');
      try {
        const uids = await client.search({ all: true });
        if (uids.length === 0) { lock.release(); }
        else {
          const msgIterator = await client.fetch(uids, { envelope: true, uid: true });
          const toDelete = [];
          for await (const msg of msgIterator) {
            if (msg.envelope && msg.envelope.date) {
              const msgDate = new Date(msg.envelope.date).getTime();
              if (now - msgDate > errorRetentionMs) {
                toDelete.push(msg.uid);
              }
            }
          }
          lock.release();
          if (toDelete.length > 0) {
            await client.messageDelete(toDelete, { uid: true });
            results.error_deleted = toDelete.length;
          }
        }
      } catch (e) {
        try { lock.release(); } catch (x) { /* 忽略 */ }
      }
    } catch (e) {
      // LOBSTER_ERROR文件夹可能不存在
    }
    
    try { await client.logout(); } catch (e) { /* 忽略 */ }
  } catch (e) {
    return { success: false, message: e.message, ...results };
  }
  
  return { success: true, ...results };
}

module.exports = {
  createImapClient,
  createSmtpTransporter,
  testImapConnection,
  testSmtpConnection,
  sendLobsterMail,
  pollInbox,
  moveCmdToDone,
  moveCmdToError,
  cleanupExpiredMails,
  ensureMailboxes
};
