/**
 * config.js - 龙虾通信配置管理
 * 
 * 配置文件: ~/.config/lobster-comm/config.json
 * 状态文件: ~/.config/lobster-comm/state.json
 * 
 * v2 改进:
 * - state增加 expired_task_ids / offline_lobsters / last_poll_time
 * - 批量读写：poll期间state操作走内存，结束时统一写一次
 * - 原子写入：先写临时文件再rename，防写一半断电
 * - 发自己检测：发送时 to !== from
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'lobster-comm');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

// 默认配置
const DEFAULT_CONFIG = {
  email: {
    account: '',
    auth_code: '',
    imap_host: 'imap.163.com',
    imap_port: 993,
    smtp_host: 'smtp.163.com',
    smtp_port: 465
  },
  identity: {
    id: '',
    work_mode: 'full',       // receive_only | interactive | full
    can_initiate: true
  },
  polling: {
    interval_min: 10,
    task_timeout_min: 30,
    ack_timeout_min: 10
  },
  interaction: {
    max_auto_reply_rounds: 3,
    trust_whitelist: []
  },
  cleanup: {
    done_retention_hours: 24,
    error_retention_hours: 168
  },
  security: {
    shared_secret: ''
  },
  protocol: {
    version: 'lobster-mail-v1',
    max_mail_size_kb: 1024,
    max_result_size_kb: 100,
    max_retry_count: 3
  }
};

// 默认状态
const DEFAULT_STATE = {
  pending_acks: [],           // 等待ACK的CMD列表 { task_id, to, sent_at, no_ack_count }
  pending_results: [],        // 已收到ACK但等待RESULT的任务 { task_id, to, original_task_id, ack_at, no_result_count, description }
  processed_task_ids: [],     // 已处理的任务ID（最近100个）
  expired_task_ids: [],       // 被EXPIRED通知标记的过期任务ID（最近100个）
  offline_lobsters: {},       // 离线龙虾记录 { id: { since, failed_tasks } }
  known_lobsters: {},         // 已知龙虾记录 { id: { first_seen, last_active, role, status } }
  last_poll_time: null,       // 上次成功poll的ISO时间
  reply_chain_depth: {},      // 任务链回复深度追踪
  my_acked_tasks: [],         // 我ACK了但还没发RESULT的任务 { task_id, from, action, description, ack_at, no_result_remind_count }
  my_pending_discuss_replies: [], // 我需要回复但还没回复的讨论 { thread_id, round, from, topic, remind_count, created_at }
  active_threads: {}          // 活跃讨论线程 { thread_id: { topic, initiator, participants, roles, current_round, max_rounds, timeout_min, replies: {round: {lobster_id: msg_body}}, started_at, last_active, concluded } }
};

// ============================================================
// 内存批量读写（poll期间使用）
// ============================================================

let _inMemoryState = null;    // 内存中的state引用
let _stateDirty = false;      // 是否有未持久化的修改

/**
 * 确保配置目录存在
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * 原子写入JSON文件
 * 先写临时文件再rename，防止写一半断电导致文件损坏
 */
function atomicWriteJSON(filePath, data) {
  ensureConfigDir();
  const tmpFile = filePath + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  // rename在同一个文件系统上是原子操作
  fs.renameSync(tmpFile, filePath);
}

/**
 * 加载配置
 */
function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * 保存配置（原子写入）
 */
function saveConfig(config) {
  atomicWriteJSON(CONFIG_FILE, config);
}

/**
 * 加载状态（从磁盘）
 */
function loadState() {
  ensureConfigDir();
  if (!fs.existsSync(STATE_FILE)) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    // 兼容旧版state（补充新字段）
    if (!state.expired_task_ids) state.expired_task_ids = [];
    if (!state.offline_lobsters) state.offline_lobsters = {};
    if (!state.known_lobsters) state.known_lobsters = {};
    if (!state.last_poll_time) state.last_poll_time = null;
    if (!state.pending_results) state.pending_results = [];
    if (!state.my_acked_tasks) state.my_acked_tasks = [];
    if (!state.my_pending_discuss_replies) state.my_pending_discuss_replies = [];
    // 兼容旧版pending_acks：去掉retry_count/ack_timeout_min，加no_ack_count
    for (const pa of (state.pending_acks || [])) {
      if (pa.no_ack_count === undefined) pa.no_ack_count = pa.retry_count || 0;
      delete pa.retry_count;
      delete pa.last_retry_at;
      delete pa.ack_timeout_min;
    }
    return state;
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

/**
 * 保存状态（原子写入，自动截断列表）
 * 增加防覆盖：写入前检查磁盘state是否比内存state更新（另一个进程可能修改了）
 */
function saveState(state) {
  // 保持各列表不超过上限
  if (state.processed_task_ids && state.processed_task_ids.length > 100) {
    state.processed_task_ids = state.processed_task_ids.slice(-100);
  }
  if (state.expired_task_ids && state.expired_task_ids.length > 100) {
    state.expired_task_ids = state.expired_task_ids.slice(-100);
  }
  // 待RESULT列表不超过50个
  if (state.pending_results && state.pending_results.length > 50) {
    state.pending_results = state.pending_results.slice(-50);
  }
  // 已ACK未RESULT列表不超过50个
  if (state.my_acked_tasks && state.my_acked_tasks.length > 50) {
    state.my_acked_tasks = state.my_acked_tasks.slice(-50);
  }
  // 待回复讨论列表不超过50个
  if (state.my_pending_discuss_replies && state.my_pending_discuss_replies.length > 50) {
    state.my_pending_discuss_replies = state.my_pending_discuss_replies.slice(-50);
  }
  // 离线龙虾记录不超过20个
  if (state.offline_lobsters) {
    const keys = Object.keys(state.offline_lobsters);
    if (keys.length > 20) {
      const keep = keys.slice(-20);
      const trimmed = {};
      for (const k of keep) trimmed[k] = state.offline_lobsters[k];
      state.offline_lobsters = trimmed;
    }
  }
  // 已知龙虾记录不超过50个
  if (state.known_lobsters) {
    const keys = Object.keys(state.known_lobsters);
    if (keys.length > 50) {
      const keep = keys.slice(-50);
      const trimmed = {};
      for (const k of keep) trimmed[k] = state.known_lobsters[k];
      state.known_lobsters = trimmed;
    }
  }
  // 非批量模式下，merge磁盘state防止跨进程覆盖
  if (!_inMemoryState) {
    try {
      const diskState = loadState();
      // merge: 保留磁盘中有但内存中没有的processed_task_ids和expired_task_ids
      for (const id of (diskState.processed_task_ids || [])) {
        if (!state.processed_task_ids.includes(id)) {
          state.processed_task_ids.push(id);
        }
      }
      for (const id of (diskState.expired_task_ids || [])) {
        if (!state.expired_task_ids.includes(id)) {
          state.expired_task_ids.push(id);
        }
      }
    } catch (e) {
      // 磁盘state损坏，直接用内存state覆盖
    }
  }
  atomicWriteJSON(STATE_FILE, state);
}

/**
 * 获取配置
 */
function getConfig() {
  return loadConfig();
}

/**
 * 获取状态（优先从内存取）
 */
function getState() {
  if (_inMemoryState) return _inMemoryState;
  return loadState();
}

/**
 * 检查配置是否完整
 */
function isConfigured() {
  const config = loadConfig();
  if (!config) return false;
  if (!config.email || !config.email.account || !config.email.auth_code) return false;
  if (!config.identity || !config.identity.id) return false;
  if (!config.security || !config.security.shared_secret) return false;
  return true;
}

/**
 * 检测是否发给自己（to === from）
 */
function isSelfSend(from, to) {
  return from === to;
}

/**
 * 生成随机通信密钥
 */
function generateSecret() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 生成任务ID
 * 格式：<龙虾ID>_<YYYYMMDDHHmmss>_<4位随机hex>
 */
function generateTaskId(myId) {
  const now = new Date();
  const ts = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const rand = crypto.randomBytes(2).toString('hex');
  return `${myId}_${ts}_${rand}`;
}

// ============================================================
// 批量读写API（poll期间使用）
// ============================================================

/**
 * 开始批量模式：将state加载到内存
 */
function beginBatch() {
  _inMemoryState = loadState();
  _stateDirty = false;
}

/**
 * 批量模式中：标记state已修改
 */
function markDirty() {
  _stateDirty = true;
}

/**
 * 结束批量模式：将内存中的state持久化到磁盘
 * 如果saveState失败（磁盘满、权限等），不丢弃内存state，保留以便下次重试
 * @returns {boolean} 是否成功持久化
 */
function commitBatch() {
  if (_inMemoryState && _stateDirty) {
    try {
      saveState(_inMemoryState);
    } catch (e) {
      // saveState失败不丢弃内存state，保留_dirty标记以便下次commitBatch重试
      // 只清除inMemoryState会导致已处理的邮件ID丢失，下次poll重复处理
      _stateDirty = true;
      return false;
    }
  }
  _inMemoryState = null;
  _stateDirty = false;
  return true;
}

// ============================================================
// 待ACK管理
// ============================================================

// ============================================================
// 待ACK管理（新机制：轮询计数制，不重发CMD）
// ============================================================

/**
 * 添加待ACK记录
 * @param {string} taskId - 任务ID
 * @param {string} to - 目标龙虾ID
 * @param {string} description - 任务描述（可选）
 */
function addPendingAck(taskId, to, description) {
  const state = getState();
  state.pending_acks.push({
    task_id: taskId,
    to: to,
    sent_at: new Date().toISOString(),
    no_ack_count: 0,
    description: description || ''
  });
  markDirty();
  if (!_inMemoryState) saveState(state);
}

function removePendingAck(taskId) {
  const state = getState();
  state.pending_acks = state.pending_acks.filter(p => p.task_id !== taskId);
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 递增未收到ACK的轮询计数
 * @returns {number} 新的no_ack_count
 */
function incrementNoAckCount(taskId) {
  const state = getState();
  const pending = state.pending_acks.find(p => p.task_id === taskId);
  if (pending) {
    pending.no_ack_count = (pending.no_ack_count || 0) + 1;
    markDirty();
    if (!_inMemoryState) saveState(state);
    return pending.no_ack_count;
  }
  return -1;
}

/**
 * 获取所有待ACK记录
 */
function getPendingAcks() {
  const state = getState();
  return state.pending_acks || [];
}

// ============================================================
// 待RESULT管理（已收到ACK，等待执行结果）
// ============================================================

/**
 * 添加待RESULT记录（收到ACK时调用）
 * @param {string} originalTaskId - 原CMD的任务ID
 * @param {string} to - 执行者龙虾ID
 * @param {string} description - 任务描述（可选）
 */
function addPendingResult(originalTaskId, to, description) {
  const state = getState();
  if (!state.pending_results) state.pending_results = [];
  state.pending_results.push({
    task_id: originalTaskId,
    to: to,
    ack_at: new Date().toISOString(),
    no_result_count: 0,
    description: description || ''
  });
  markDirty();
  if (!_inMemoryState) saveState(state);
}

function removePendingResult(taskId) {
  const state = getState();
  if (!state.pending_results) return;
  state.pending_results = state.pending_results.filter(p => p.task_id !== taskId);
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 递增未收到RESULT的轮询计数
 * @returns {number} 新的no_result_count
 */
function incrementNoResultCount(taskId) {
  const state = getState();
  if (!state.pending_results) return -1;
  const pending = state.pending_results.find(p => p.task_id === taskId);
  if (pending) {
    pending.no_result_count = (pending.no_result_count || 0) + 1;
    markDirty();
    if (!_inMemoryState) saveState(state);
    return pending.no_result_count;
  }
  return -1;
}

/**
 * 获取所有待RESULT记录
 */
function getPendingResults() {
  const state = getState();
  return state.pending_results || [];
}

// ============================================================
// my_acked_tasks管理（执行者侧：我ACK了但还没发RESULT的任务）
// ============================================================

/**
 * 添加已ACK但未发RESULT的任务记录（auto-ACK时调用）
 * @param {string} taskId - 原CMD的task_id
 * @param {string} from - CMD发送者龙虾ID
 * @param {string} action - CMD的action标识
 * @param {string} description - 任务描述（可选）
 */
function addMyAckedTask(taskId, from, action, description) {
  const state = getState();
  if (!state.my_acked_tasks) state.my_acked_tasks = [];
  // 防重复
  if (state.my_acked_tasks.find(t => t.task_id === taskId)) return;
  state.my_acked_tasks.push({
    task_id: taskId,
    from: from,
    action: action || '',
    description: description || '',
    ack_at: new Date().toISOString(),
    no_result_remind_count: 0
  });
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 移除已ACK任务记录（手动发RESULT/ERROR时调用）
 * @param {string} taskId - 原CMD的task_id
 */
function removeMyAckedTask(taskId) {
  const state = getState();
  if (!state.my_acked_tasks) return;
  state.my_acked_tasks = state.my_acked_tasks.filter(t => t.task_id !== taskId);
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 递增已ACK任务的提醒计数
 * @param {string} taskId - 原CMD的task_id
 * @returns {number} 新的no_result_remind_count
 */
function incrementMyAckedRemindCount(taskId) {
  const state = getState();
  if (!state.my_acked_tasks) return -1;
  const task = state.my_acked_tasks.find(t => t.task_id === taskId);
  if (task) {
    task.no_result_remind_count = (task.no_result_remind_count || 0) + 1;
    markDirty();
    if (!_inMemoryState) saveState(state);
    return task.no_result_remind_count;
  }
  return -1;
}

/**
 * 获取所有已ACK但未发RESULT的任务
 */
function getMyAckedTasks() {
  const state = getState();
  return state.my_acked_tasks || [];
}

// ============================================================
// my_pending_discuss_replies管理（执行者侧：我需要回复但还没回复的讨论）
// ============================================================

/**
 * 添加待回复讨论记录（收到DISCUSS + waiting_for_me时调用）
 * @param {string} threadId - 讨论线程ID
 * @param {number} round - 当前轮次
 * @param {string} from - 讨论发起者/消息发送者
 * @param {string} topic - 讨论话题
 */
function addMyPendingDiscussReply(threadId, round, from, topic) {
  const state = getState();
  if (!state.my_pending_discuss_replies) state.my_pending_discuss_replies = [];
  // 防重复：同线程同轮次只记录一次
  if (state.my_pending_discuss_replies.find(d => d.thread_id === threadId && d.round === round)) return;
  state.my_pending_discuss_replies.push({
    thread_id: threadId,
    round: round,
    from: from,
    topic: topic || '',
    remind_count: 0,
    created_at: new Date().toISOString()
  });
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 移除待回复讨论记录（回复后调用）
 * @param {string} threadId - 讨论线程ID
 * @param {number} round - 轮次（可选，不传则移除该线程所有记录）
 */
function removeMyPendingDiscussReply(threadId, round) {
  const state = getState();
  if (!state.my_pending_discuss_replies) return;
  if (round !== undefined) {
    state.my_pending_discuss_replies = state.my_pending_discuss_replies.filter(
      d => !(d.thread_id === threadId && d.round === round)
    );
  } else {
    state.my_pending_discuss_replies = state.my_pending_discuss_replies.filter(
      d => d.thread_id !== threadId
    );
  }
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 递增待回复讨论的提醒计数
 * @param {string} threadId - 讨论线程ID
 * @param {number} round - 轮次
 * @returns {number} 新的remind_count
 */
function incrementMyDiscussRemindCount(threadId, round) {
  const state = getState();
  if (!state.my_pending_discuss_replies) return -1;
  const item = state.my_pending_discuss_replies.find(d => d.thread_id === threadId && d.round === round);
  if (item) {
    item.remind_count = (item.remind_count || 0) + 1;
    markDirty();
    if (!_inMemoryState) saveState(state);
    return item.remind_count;
  }
  return -1;
}

/**
 * 获取所有待回复讨论
 */
function getMyPendingDiscussReplies() {
  const state = getState();
  return state.my_pending_discuss_replies || [];
}

// ============================================================
// 已处理/过期任务管理
// ============================================================

function addProcessedTaskId(taskId, type) {
  const state = getState();
  const key = type ? `${taskId}::${type}` : taskId;
  if (!state.processed_task_ids.includes(key)) {
    state.processed_task_ids.push(key);
    markDirty();
    if (!_inMemoryState) saveState(state);
  }
}

function isTaskProcessed(taskId, type) {
  const state = getState();
  const key = type ? `${taskId}::${type}` : taskId;
  return state.processed_task_ids.includes(key);
}

/**
 * 添加过期任务ID（收到EXPIRED通知时调用）
 */
function addExpiredTaskId(taskId) {
  const state = getState();
  if (!state.expired_task_ids.includes(taskId)) {
    state.expired_task_ids.push(taskId);
    markDirty();
    if (!_inMemoryState) saveState(state);
  }
}

/**
 * 检查任务是否已过期
 */
function isTaskExpired(taskId) {
  const state = getState();
  return state.expired_task_ids.includes(taskId);
}

// ============================================================
// 离线龙虾管理
// ============================================================

/**
 * 标记龙虾离线
 */
function markLobsterOffline(lobsterId, failedTaskId) {
  const state = getState();
  if (!state.offline_lobsters) state.offline_lobsters = {};
  if (!state.offline_lobsters[lobsterId]) {
    state.offline_lobsters[lobsterId] = {
      since: new Date().toISOString(),
      failed_tasks: []
    };
  }
  if (failedTaskId && !state.offline_lobsters[lobsterId].failed_tasks.includes(failedTaskId)) {
    state.offline_lobsters[lobsterId].failed_tasks.push(failedTaskId);
  }
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 标记龙虾恢复在线（收到其ACK/RESULT时调用）
 */
function markLobsterOnline(lobsterId) {
  const state = getState();
  if (state.offline_lobsters && state.offline_lobsters[lobsterId]) {
    delete state.offline_lobsters[lobsterId];
    markDirty();
    if (!_inMemoryState) saveState(state);
  }
}

/**
 * 检查龙虾是否离线
 */
function isLobsterOffline(lobsterId) {
  const state = getState();
  return !!(state.offline_lobsters && state.offline_lobsters[lobsterId]);
}

// ============================================================
// 已知龙虾（团队）管理
// ============================================================

/**
 * 记录/更新已知龙虾信息
 * @param {string} lobsterId - 龙虾ID
 * @param {string} role - 角色: 'hub'（中枢） | 'worker'（干活）
 * @param {object} meta - 附加信息 { host, platform, user }
 * @param {boolean} updateActive - 是否更新last_active
 */
function updateKnownLobster(lobsterId, role, meta, updateActive) {
  if (!lobsterId) return;
  const state = getState();
  if (!state.known_lobsters) state.known_lobsters = {};
  const now = new Date().toISOString();
  
  if (!state.known_lobsters[lobsterId]) {
    // 新发现的龙虾
    state.known_lobsters[lobsterId] = {
      first_seen: now,
      last_active: now,
      role: role || 'worker',
      status: 'online',
      host: (meta && meta.host) || '',
      platform: (meta && meta.platform) || '',
      user: (meta && meta.user) || ''
    };
  } else {
    // 已有记录，更新
    const existing = state.known_lobsters[lobsterId];
    // 如果角色从worker升级为hub，优先hub（中枢不会降级为worker）
    if (role === 'hub' && existing.role !== 'hub') {
      existing.role = 'hub';
    }
    // 更新部署信息（有新值就覆盖）
    if (meta) {
      if (meta.host) existing.host = meta.host;
      if (meta.platform) existing.platform = meta.platform;
      if (meta.user) existing.user = meta.user;
    }
    if (updateActive !== false) {
      existing.last_active = now;
    }
    existing.status = 'online';
  }
  
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 获取所有已知龙虾
 */
function getKnownLobsters() {
  const state = getState();
  return state.known_lobsters || {};
}

/**
 * 从已知龙虾列表中移除（forget命令调用）
 * 同时清除其离线状态
 * @returns {boolean} 是否成功移除
 */
function forgetLobster(lobsterId) {
  const state = getState();
  let removed = false;
  if (state.known_lobsters && state.known_lobsters[lobsterId]) {
    delete state.known_lobsters[lobsterId];
    removed = true;
  }
  if (state.offline_lobsters && state.offline_lobsters[lobsterId]) {
    delete state.offline_lobsters[lobsterId];
  }
  // 清除相关的pending_acks和pending_results
  if (state.pending_acks) {
    state.pending_acks = state.pending_acks.filter(p => p.to !== lobsterId);
  }
  if (state.pending_results) {
    state.pending_results = state.pending_results.filter(p => p.to !== lobsterId);
  }
  if (removed) {
    markDirty();
    if (!_inMemoryState) saveState(state);
  }
  return removed;
}

/**
 * 根据ID列表批量更新已知龙虾状态为离线
 */
function syncKnownLobsterStatus() {
  const state = getState();
  if (!state.known_lobsters) return;
  const offlineIds = new Set(Object.keys(state.offline_lobsters || {}));
  for (const [id, info] of Object.entries(state.known_lobsters)) {
    info.status = offlineIds.has(id) ? 'offline' : 'online';
  }
  markDirty();
  if (!_inMemoryState) saveState(state);
}

// ============================================================
// poll时间管理
// ============================================================

/**
 * 更新上次poll时间
 */
function updateLastPollTime() {
  const state = getState();
  state.last_poll_time = new Date().toISOString();
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 获取上次poll时间
 */
function getLastPollTime() {
  const state = getState();
  return state.last_poll_time || null;
}

// ============================================================
// 回复链深度管理
// ============================================================

function incrementReplyDepth(taskId) {
  const state = getState();
  if (!state.reply_chain_depth) state.reply_chain_depth = {};
  state.reply_chain_depth[taskId] = (state.reply_chain_depth[taskId] || 0) + 1;
  markDirty();
  if (!_inMemoryState) saveState(state);
  return state.reply_chain_depth[taskId];
}

function getReplyDepth(taskId) {
  const state = getState();
  return (state.reply_chain_depth && state.reply_chain_depth[taskId]) || 0;
}

function cleanupReplyDepths() {
  const state = getState();
  if (!state.reply_chain_depth) return;
  const keys = Object.keys(state.reply_chain_depth);
  if (keys.length > 50) {
    const keep = keys.slice(-50);
    const newDepths = {};
    for (const k of keep) {
      newDepths[k] = state.reply_chain_depth[k];
    }
    state.reply_chain_depth = newDepths;
    markDirty();
    if (!_inMemoryState) saveState(state);
  }
}

// ============================================================
// 讨论线程管理
// ============================================================

/**
 * 创建讨论线程
 */
function createThread(threadId, topic, initiator, participants, roles, timeoutMin, maxRounds) {
  const state = getState();
  if (!state.active_threads) state.active_threads = {};
  state.active_threads[threadId] = {
    topic: topic,
    initiator: initiator,
    participants: participants,           // ['龙二', '龙三']
    roles: roles || {},                   // { '龙二': 'challenger', '龙三': 'researcher' }
    current_round: 1,
    max_rounds: maxRounds || 5,
    timeout_min: timeoutMin || 10,
    replies: {},                          // { 1: { '龙二': {...}, '龙三': {...} } }
    started_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    concluded: false,
    conclusion: null,
    round_timed_out: {},                  // { 1: ['龙三'] }
    pending_summary_sent: false           // 本轮参与方全部回复后，是否已通知发起方总结
  };
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 获取讨论线程
 */
function getThread(threadId) {
  const state = getState();
  if (!state.active_threads) return null;
  return state.active_threads[threadId] || null;
}

/**
 * 获取所有活跃线程
 */
function getActiveThreads() {
  const state = getState();
  if (!state.active_threads) return {};
  return state.active_threads;
}

/**
 * 记录讨论回复
 */
function addThreadReply(threadId, round, from, replyBody) {
  const state = getState();
  if (!state.active_threads || !state.active_threads[threadId]) return false;
  const thread = state.active_threads[threadId];
  if (!thread.replies[round]) thread.replies[round] = {};
  thread.replies[round][from] = replyBody;
  thread.last_active = new Date().toISOString();
  markDirty();
  if (!_inMemoryState) saveState(state);
  return true;
}

/**
 * 推进到下一轮（支持指定目标轮次，用于ROUND_ADVANCE同步）
 * 推进时重置pending_summary_sent，新轮次需要等待参与方回复后再次总结
 * @param {string} threadId - 线程ID
 * @param {number} [targetRound] - 目标轮次，不传则current_round+1
 */
function advanceThreadRound(threadId, targetRound) {
  const state = getState();
  if (!state.active_threads || !state.active_threads[threadId]) return false;
  const thread = state.active_threads[threadId];
  if (targetRound !== undefined) {
    thread.current_round = targetRound;
  } else {
    thread.current_round++;
  }
  thread.last_active = new Date().toISOString();
  thread.pending_summary_sent = false;  // 新轮次重置
  markDirty();
  if (!_inMemoryState) saveState(state);
  return true;
}

/**
 * 标记已通知发起方总结（防止重复通知）
 */
function setPendingSummarySent(threadId, value) {
  const state = getState();
  if (!state.active_threads || !state.active_threads[threadId]) return false;
  state.active_threads[threadId].pending_summary_sent = value;
  markDirty();
  if (!_inMemoryState) saveState(state);
  return true;
}

/**
 * 结束讨论
 */
function concludeThread(threadId, conclusion) {
  const state = getState();
  if (!state.active_threads || !state.active_threads[threadId]) return false;
  const thread = state.active_threads[threadId];
  thread.concluded = true;
  thread.conclusion = conclusion || '';
  thread.last_active = new Date().toISOString();
  markDirty();
  if (!_inMemoryState) saveState(state);
  return true;
}

/**
 * 记录轮次超时
 */
function markThreadRoundTimeout(threadId, round, timedOutLobsters) {
  const state = getState();
  if (!state.active_threads || !state.active_threads[threadId]) return false;
  const thread = state.active_threads[threadId];
  if (!thread.round_timed_out) thread.round_timed_out = {};
  thread.round_timed_out[round] = timedOutLobsters;
  markDirty();
  if (!_inMemoryState) saveState(state);
  return true;
}

/**
 * 删除讨论线程
 */
function removeThread(threadId) {
  const state = getState();
  if (!state.active_threads) return;
  delete state.active_threads[threadId];
  markDirty();
  if (!_inMemoryState) saveState(state);
}

/**
 * 检查某轮是否所有参与方都已回复
 * 发起方是主持人，不需要每轮回复；只有非发起方的参与方需要回复
 * 返回 { complete: bool, replied: [], missing: [], pending_summary: bool }
 */
function checkRoundComplete(threadId, round) {
  const thread = getThread(threadId);
  if (!thread) return { complete: false, replied: [], missing: [], pending_summary: false };
  const roundReplies = thread.replies[round] || {};
  const replied = Object.keys(roundReplies);
  // 发起方是主持人，不参与每轮回复；只检查非发起方的参与方
  const requiredParticipants = thread.participants.filter(p => p !== thread.initiator);
  const missing = requiredParticipants.filter(p => !replied.includes(p));
  // pending_summary: 所有参与方已回复，等待发起方总结并推进
  const pendingSummary = missing.length === 0 && !thread.pending_summary_sent;
  return { complete: missing.length === 0, replied, missing, pending_summary: pendingSummary };
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  STATE_FILE,
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  atomicWriteJSON,
  getConfig,
  getState,
  isConfigured,
  isSelfSend,
  generateSecret,
  generateTaskId,
  beginBatch,
  markDirty,
  commitBatch,
  addPendingAck,
  removePendingAck,
  incrementNoAckCount,
  getPendingAcks,
  addPendingResult,
  removePendingResult,
  incrementNoResultCount,
  getPendingResults,
  addMyAckedTask,
  removeMyAckedTask,
  incrementMyAckedRemindCount,
  getMyAckedTasks,
  addMyPendingDiscussReply,
  removeMyPendingDiscussReply,
  incrementMyDiscussRemindCount,
  getMyPendingDiscussReplies,
  addProcessedTaskId,
  isTaskProcessed,
  addExpiredTaskId,
  isTaskExpired,
  markLobsterOffline,
  markLobsterOnline,
  isLobsterOffline,
  updateKnownLobster,
  getKnownLobsters,
  forgetLobster,
  syncKnownLobsterStatus,
  updateLastPollTime,
  getLastPollTime,
  incrementReplyDepth,
  getReplyDepth,
  cleanupReplyDepths,
  createThread,
  getThread,
  getActiveThreads,
  addThreadReply,
  advanceThreadRound,
  concludeThread,
  markThreadRoundTimeout,
  removeThread,
  checkRoundComplete,
  setPendingSummarySent
};
