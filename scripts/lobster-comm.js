#!/usr/bin/env node
/**
 * lobster-comm.js - 龙虾跨平台通信主入口
 * 
 * v3 改进:
 * - 超时判定与轮询间隔解耦：时间为主（ack_timeout_min/result_timeout_min/discuss_timeout_min），轮询计数降为兜底
 * - 收到ACK后转入pending_results，超时未收RESULT→通知用户
 * - compact输出模式(--compact)省token
 * - poll输出精简(去掉uid，pending_acks只返回概要)
 * - 离线龙虾状态展示
 * 
 * 用法:
 *   node lobster-comm.js setup                   # 交互式配置向导
 *   node lobster-comm.js send [options]           # 发送邮件
 *   node lobster-comm.js poll [--compact]         # 轮询邮箱
 *   node lobster-comm.js status                   # 查看状态
 *   node lobster-comm.js cleanup                  # 清理过期邮件
 *   node lobster-comm.js test-conn                # 测试连接
 */

const path = require('path');
const os = require('os');
const readline = require('readline');
const cfg = require('./lib/config');
const proto = require('./lib/protocol');
const mail = require('./lib/mail-client');

// ============================================================
// CLIXML防御：拦截未捕获异常，输出到stdout而非stderr
// PowerShell会将stderr包裹为CLIXML，污染JSON输出
// ============================================================
process.on('uncaughtException', (err) => {
  try {
    println(`❌ 未捕获异常: ${err.message}`);
    process.exit(1);
  } catch (e) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  try {
    println(`❌ 未处理的Promise异常: ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exit(1);
  } catch (e) {
    process.exit(1);
  }
});

// ============================================================
// 工具函数
// ============================================================

function println(text) {
  const output = text || '';
  // CLIXML防御：剥离PowerShell可能注入的CLIXML包裹
  // 即使防线1+2已经堵住源头，这里做最终兜底
  const cleaned = stripCLIXML(output);
  console.log(cleaned);
}

/**
 * 剥离PowerShell CLIXML包裹
 * CLIXML格式：#< CLIXML<Objs...>...</Objs>
 * 可能出现在stdout输出的前面或中间
 */
function stripCLIXML(text) {
  if (!text || typeof text !== 'string') return text;
  // 匹配 #< CLIXML 开头到 </Objs> 结束的整个块
  let cleaned = text.replace(/#<\s*CLIXML[\s\S]*?<\/Objs>/gi, '');
  // 也匹配只有开始标记没有结束标记的情况（截断的CLIXML）
  cleaned = cleaned.replace(/#<\s*CLIXML[\s\S]*/gi, '');
  // 匹配残留的XML片段 <S S="Error">...</S>
  cleaned = cleaned.replace(/<S\s+S="Error">[\s\S]*?<\/S>/gi, '');
  cleaned = cleaned.replace(/<S\s+S="Warning">[\s\S]*?<\/S>/gi, '');
  return cleaned.trim();
}

function printSeparator() {
  println('═══════════════════════════════════════════════════');
}

function question(rl, prompt) {
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      resolve(answer.trim());
    });
  });
}

function questionSecret(rl, prompt) {
  return new Promise(resolve => {
    const pw = [];
    process.stdout.write(prompt);
    
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    
    const onData = (char) => {
      const c = char.toString();
      switch (c) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl+D
          if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
          stdin.removeListener('data', onData);
          println('');
          resolve(pw.join(''));
          break;
        case '\u0003': // Ctrl+C
          process.exit();
          break;
        case '\u007F': // Backspace
          pw.pop();
          break;
        default:
          pw.push(c);
          break;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * 友好的时间差显示
 */
function timeAgo(isoStr) {
  if (!isoStr) return '未知';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function parseArgs(argv) {
  const args = {};
  let i = 2; // skip node and script
  while (i < argv.length) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].substring(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 2;
      } else {
        args[key] = true;
        i += 1;
      }
    } else {
      if (!args._command) args._command = argv[i];
      i++;
    }
  }
  // ── 内容安全通道 ──
  // 1. --content-file: 从文件读取内容（彻底绕过shell转义/截断问题）
  if (args.contentFile) {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.resolve(args.contentFile);
      args.content = fs.readFileSync(filePath, 'utf-8').trim();
    } catch (e) {
      console.error(`❌ 无法读取 --content-file: ${e.message}`);
      process.exit(1);
    }
  }
  // 2. --content 中的 \n 转义为真实换行符（shell无法传递真实换行）
  if (args.content && typeof args.content === 'string') {
    args.content = args.content.replace(/\\n/g, '\n');
  }
  // 同理处理 --params-file
  if (args.paramsFile) {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.resolve(args.paramsFile);
      args.params = fs.readFileSync(filePath, 'utf-8').trim();
    } catch (e) {
      console.error(`❌ 无法读取 --params-file: ${e.message}`);
      process.exit(1);
    }
  }
  return args;
}

// ============================================================
// setup 命令 - 交互式配置向导
// ============================================================

async function cmdSetup(args) {
  // ══════════════════════════════════════
  // 非交互式模式：--json 或 --json-file
  // ══════════════════════════════════════
  let setupJson = null;
  if (args && args.jsonFile) {
    try {
      const fs = require('fs');
      const filePath = require('path').resolve(args.jsonFile);
      setupJson = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      println(`❌ 无法读取 --json-file: ${e.message}`);
      process.exit(1);
    }
  } else if (args && args.json && args.json !== true) {
    try {
      setupJson = JSON.parse(args.json);
    } catch (e) {
      println(`❌ --json 格式错误: ${e.message}`);
      process.exit(1);
    }
  }
  
  if (setupJson) {
    // ── 非交互式：校验必填字段 ──
    const errors = [];
    if (!setupJson.account) errors.push('account（163邮箱账号）');
    if (!setupJson.auth_code) errors.push('auth_code（授权码）');
    if (!setupJson.id) errors.push('id（龙虾唯一ID）');
    if (!setupJson.shared_secret) errors.push('shared_secret（通信密钥，可设"auto"自动生成）');
    if (setupJson.trust_ids === undefined || setupJson.trust_ids === '') errors.push('trust_ids（信任龙虾ID，*号=全部信任）');
    if (!setupJson.interval_min) errors.push('interval_min（轮询间隔分钟数）');
    if (errors.length) {
      println(`❌ 缺少必填字段: ${errors.join(', ')}`);
      println('');
      println('必需字段示例:');
      println(JSON.stringify({
        account: 'xxx@163.com',
        auth_code: '授权码',
        id: '龙虾ID',
        work_mode: 'full',
        shared_secret: 'auto',
        trust_ids: '*',
        interval_min: 10,
        task_timeout_min: 30
      }, null, 2));
      process.exit(1);
    }
    
    // ── 解析字段 ──
    const account = setupJson.account;
    const authCode = setupJson.auth_code;
    const id = setupJson.id;
    const workMode = ['full','interactive','receive_only'].includes(setupJson.work_mode) ? setupJson.work_mode : 'full';
    const workModeLabel = { 'full': '中枢', 'interactive': '交互', 'receive_only': '被动' }[workMode];
    const canInitiate = workMode === 'full' ? true : (setupJson.can_initiate === true);
    let sharedSecret = setupJson.shared_secret;
    if (sharedSecret === 'auto' || !sharedSecret) {
      sharedSecret = cfg.generateSecret();
    }
    const trustIds = setupJson.trust_ids;
    const trustWhitelist = trustIds === '*' ? [] : String(trustIds).split(',').map(s => s.trim()).filter(Boolean);
    const intervalMin = parseInt(setupJson.interval_min) || 10;
    const taskTimeout = parseInt(setupJson.task_timeout_min) || 30;
    const maxReply = parseInt(setupJson.max_auto_reply_rounds) || 0;
    const doneRetention = parseInt(setupJson.done_retention_hours) || 24;
    const errorRetention = parseInt(setupJson.error_retention_hours) || 168;
    
    if (intervalMin < 5) println('⚠️  间隔太短，163 IMAP限频，建议≥5分钟');
    
    // ── 构建配置 ──
    const newConfig = {
      email: {
        account: account,
        auth_code: authCode,
        imap_host: 'imap.163.com',
        imap_port: 993,
        smtp_host: 'smtp.163.com',
        smtp_port: 465
      },
      identity: {
        id: id,
        work_mode: workMode,
        can_initiate: canInitiate
      },
      polling: {
        interval_min: intervalMin,
        task_timeout_min: taskTimeout,
        ack_timeout_min: intervalMin * 3
      },
      interaction: {
        max_auto_reply_rounds: maxReply,
        trust_whitelist: trustWhitelist
      },
      cleanup: {
        done_retention_hours: doneRetention,
        error_retention_hours: errorRetention
      },
      security: {
        shared_secret: sharedSecret
      },
      protocol: {
        version: 'lobster-mail-v1',
        max_mail_size_kb: 1024,
        max_result_size_kb: 100,
        max_retry_count: 3
      }
    };
    
    cfg.saveConfig(newConfig);
    cfg.saveState(JSON.parse(JSON.stringify(cfg.DEFAULT_STATE)));
    
    // ── 配置摘要 ──
    printSeparator();
    println('  ✅ 配置已保存！（非交互式模式）');
    printSeparator();
    println(`  龙虾ID:     ${id}`);
    println(`  职责角色:   ${workModeLabel}`);
    println(`  轮询间隔:   ${intervalMin} 分钟`);
    println(`  信任龙虾:   ${trustIds === '*' ? '全部（*）' : trustWhitelist.join(', ')}`);
    println(`  通信密钥:   ${sharedSecret.substring(0, 8)}...`);
    println('');
    
    // ── 测试邮箱连接 ──
    println('正在测试邮箱连接...');
    const imapResult = await mail.testImapConnection(newConfig.email);
    const smtpResult = await mail.testSmtpConnection(newConfig.email);
    
    println(`  IMAP: ${imapResult.success ? '✅ ' + imapResult.message : '❌ ' + imapResult.message}`);
    println(`  SMTP: ${smtpResult.success ? '✅ ' + smtpResult.message : '❌ ' + smtpResult.message}`);
    
    if (!imapResult.success || !smtpResult.success) {
      println('');
      println('⚠️  连接测试失败，请检查邮箱账号和授权码是否正确。');
      println('   可稍后运行 node scripts/lobster-comm.js test-conn 重新测试。');
    }
    
    // ── 自动发送HELLO ──
    if (imapResult.success && smtpResult.success) {
      println('');
      println('📢 正在向共享邮箱发送HELLO宣告存在...');
      const helloResult = await sendHelloInternal(newConfig);
      if (helloResult.success) {
        println('   ✅ HELLO已发送，其他龙虾将在轮询时发现你');
      } else {
        println(`   ⚠️  HELLO发送失败: ${helloResult.message}，可稍后手动运行: node scripts/lobster-comm.js hello`);
      }
    }
    
    // ── 自动创建定时轮询任务（输出JSON供Agent读取） ──
    println('');
    println(`⏰ 轮询自动化配置（Agent请据此创建自动化任务）:`);
    println('---AUTOMATION_CONFIG---');
    println(JSON.stringify({
      name: `龙虾轮询-${id}`,
      interval_min: intervalMin,
      poll_command: 'poll --compact',
      script_dir: __dirname.replace(/\\/g, '/'),
      lobster_id: id
    }));
    println('---END_AUTOMATION_CONFIG---');
    println('');
    println('🦞 部署完成！接下来可以:');
    println(`  - 轮询邮箱: node scripts/lobster-comm.js poll`);
    println(`  - 发送指令: node scripts/lobster-comm.js send --type CMD --to 龙二 --action "xxx"`);
    println(`  - 查看状态: node scripts/lobster-comm.js status`);
    return;
  }
  
  // ══════════════════════════════════════
  // 交互式模式（原有逻辑）
  // ══════════════════════════════════════
  printSeparator();
  println('  🦞 龙虾跨平台通信 v3 - 部署配置向导');
  printSeparator();
  println('');
  
  // 检查是否已有配置
  const existing = cfg.loadConfig();
  if (existing && existing.identity && existing.identity.id) {
    println(`⚠️  检测到已有配置（龙虾ID: ${existing.identity.id}）`);
    println('  1) 重新配置（覆盖现有配置）');
    println('  2) 放弃');
    println('');
    
    const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const choice = await question(rl0, '请选择 (1-2): ');
    rl0.close();
    
    if (choice !== '1') {
      println('已取消。');
      return;
    }
    println('');
  }
  
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  // ══════════════════════════════════════
  // 第1步：共享邮箱（必填）
  // ══════════════════════════════════════
  println('━━━ 第1步：共享邮箱（必填） ━━━');
  println('  所有龙虾通过同一个163邮箱通信，需开启IMAP/SMTP并获取授权码');
  println('');
  
  let account = '';
  while (!account) {
    account = (await question(rl, '  ① 163邮箱账号: ')).trim();
    if (!account) println('     ❌ 邮箱账号不能为空');
    else if (!account.includes('@')) println('     ❌ 邮箱格式不正确，需要包含@');
    else if (!account.includes('163.com')) println('     ⚠️  当前仅支持163邮箱');
  }
  
  let authCode = '';
  while (!authCode) {
    authCode = (await questionSecret(rl, '  ② 授权码（输入不显示）: ')).trim();
    if (!authCode) println('     ❌ 授权码不能为空');
  }
  println('');
  
  // ══════════════════════════════════════
  // 第2步：本龙虾身份（必填）
  // ══════════════════════════════════════
  println('━━━ 第2步：本龙虾身份（必填） ━━━');
  println('');
  
  let id = '';
  while (!id) {
    id = (await question(rl, '  ③ 龙虾唯一ID（如龙一、龙二、龙三，不可重复）: ')).trim();
    if (!id) println('     ❌ ID不能为空');
  }
  
  println('');
  println('  ④ 职责角色:');
  println('     [1] 中枢 — 完整模式：收发+可主动指挥其他龙虾+发起讨论');
  println('     [2] 交互 — 可接收也可按规则回复，不主动指挥');
  println('     [3] 被动 — 仅接收不主动回复');
  const modeChoice = (await question(rl, '     请选择 (1-3，默认1): ')).trim() || '1';
  const workModeMap = { '1': 'full', '2': 'interactive', '3': 'receive_only' };
  const workMode = workModeMap[modeChoice] || 'full';
  const workModeLabel = { 'full': '中枢', 'interactive': '交互', 'receive_only': '被动' }[workMode];
  
  const canInitiate = workMode === 'full' ? true : 
    (await question(rl, '  ⑤ 是否允许主动发邮件指挥其他龙虾 (y/n): ')).toLowerCase() === 'y';
  println('');
  
  // ══════════════════════════════════════
  // 第3步：安全配置（必填）
  // ══════════════════════════════════════
  println('━━━ 第3步：安全配置（必填） ━━━');
  println('');
  
  let sharedSecret = (await question(rl, '  ⑥ 通信密钥（所有龙虾必须一致，留空自动生成）: ')).trim();
  if (!sharedSecret) {
    sharedSecret = cfg.generateSecret();
    println(`     ↳ 已自动生成: ${sharedSecret}`);
  }
  println('     ⚠️  请将此密钥配置到其他龙虾，不一致将无法通信！');
  
  let trustIds = '';
  while (!trustIds) {
    trustIds = (await question(rl, '  ⑦ 信任龙虾ID（允许哪些龙虾给你发指令，逗号分隔，*号=全部信任）: ')).trim();
    if (!trustIds) println('     ❌ 信任ID不能为空，至少输入一个（或输入*信任所有）');
  }
  const trustWhitelist = trustIds === '*' ? [] : trustIds.split(',').map(s => s.trim()).filter(Boolean);
  println('');
  
  // ══════════════════════════════════════
  // 第4步：轮询间隔（必填，关联自动化）
  // ══════════════════════════════════════
  println('━━━ 第4步：轮询配置（必填） ━━━');
  println('  轮询间隔决定检查邮箱的频率，设置后将自动创建定时轮询任务');
  println('  建议：中枢龙虾5-10分钟，交互龙虾10-15分钟，被动龙虾15-30分钟');
  println('');
  
  let intervalMin = 0;
  while (intervalMin < 1) {
    const input = (await question(rl, '  ⑧ 轮询间隔（分钟，5/10/15/30/60）: ')).trim();
    intervalMin = parseInt(input) || 0;
    if (intervalMin < 1) println('     ❌ 必须填写轮询间隔');
    else if (intervalMin < 5) println('     ⚠️  间隔太短，163 IMAP限频，建议≥5分钟');
  }
  
  const taskTimeout = parseInt((await question(rl, '  ⑨ 任务超时作废时间（分钟，默认30）: ')).trim()) || 30;
  println('');
  
  // ══════════════════════════════════════
  // 第5步：高级配置（可选，有默认值）
  // ══════════════════════════════════════
  println('━━━ 第5步：高级配置（可选，回车使用默认值） ━━━');
  println('');
  
  const maxReply = parseInt((await question(rl, '  ⑩ 最大自动互回复轮次（0=永不自动回复，默认0）: ')).trim()) || 0;
  const doneRetention = parseInt((await question(rl, '  ⑪ 已处理邮件保留时间（小时，默认24）: ')).trim()) || 24;
  const errorRetention = parseInt((await question(rl, '  ⑫ 异常邮件保留时间（小时，默认168=7天）: ')).trim()) || 168;
  
  rl.close();
  
  // ── 构建配置 ──
  const newConfig = {
    email: {
      account: account,
      auth_code: authCode,
      imap_host: 'imap.163.com',
      imap_port: 993,
      smtp_host: 'smtp.163.com',
      smtp_port: 465
    },
    identity: {
      id: id,
      work_mode: workMode,
      can_initiate: canInitiate
    },
    polling: {
      interval_min: intervalMin,
      task_timeout_min: taskTimeout,
      ack_timeout_min: intervalMin * 3
    },
    interaction: {
      max_auto_reply_rounds: maxReply,
      trust_whitelist: trustWhitelist
    },
    cleanup: {
      done_retention_hours: doneRetention,
      error_retention_hours: errorRetention
    },
    security: {
      shared_secret: sharedSecret
    },
    protocol: {
      version: 'lobster-mail-v1',
      max_mail_size_kb: 1024,
      max_result_size_kb: 100,
      max_retry_count: 3
    }
  };
  
  cfg.saveConfig(newConfig);
  cfg.saveState(JSON.parse(JSON.stringify(cfg.DEFAULT_STATE)));
  
  // ── 配置摘要 ──
  println('');
  printSeparator();
  println('  ✅ 配置已保存！');
  printSeparator();
  println('');
  println(`  龙虾ID:     ${id}`);
  println(`  职责角色:   ${workModeLabel}`);
  println(`  轮询间隔:   ${intervalMin} 分钟`);
  println(`  信任龙虾:   ${trustIds === '*' ? '全部（*）' : trustWhitelist.join(', ')}`);
  println(`  通信密钥:   ${sharedSecret.substring(0, 8)}...`);
  println('');
  
  // ── 测试邮箱连接 ──
  println('正在测试邮箱连接...');
  const imapResult = await mail.testImapConnection(newConfig.email);
  const smtpResult = await mail.testSmtpConnection(newConfig.email);
  
  println(`  IMAP: ${imapResult.success ? '✅ ' + imapResult.message : '❌ ' + imapResult.message}`);
  println(`  SMTP: ${smtpResult.success ? '✅ ' + smtpResult.message : '❌ ' + smtpResult.message}`);
  
  if (!imapResult.success || !smtpResult.success) {
    println('');
    println('⚠️  连接测试失败，请检查邮箱账号和授权码是否正确。');
    println('   可稍后运行 node scripts/lobster-comm.js test-conn 重新测试。');
  }
  
  // ── 自动发送HELLO ──
  if (imapResult.success && smtpResult.success) {
    println('');
    println('📢 正在向共享邮箱发送HELLO宣告存在...');
    const helloResult = await sendHelloInternal(newConfig);
    if (helloResult.success) {
      println('   ✅ HELLO已发送，其他龙虾将在轮询时发现你');
    } else {
      println(`   ⚠️  HELLO发送失败: ${helloResult.message}，可稍后手动运行: node scripts/lobster-comm.js hello`);
    }
  }
  
  // ── 自动创建定时轮询任务（输出JSON供Agent读取） ──
  println('');
  println(`⏰ 轮询自动化配置（Agent请据此创建自动化任务）:`);
  println('---AUTOMATION_CONFIG---');
  println(JSON.stringify({
    name: `龙虾轮询-${id}`,
    interval_min: intervalMin,
    poll_command: 'poll --compact',
    script_dir: __dirname.replace(/\\/g, '/'),
    lobster_id: id
  }));
  println('---END_AUTOMATION_CONFIG---');
  println('');
  println('🦞 部署完成！接下来可以:');
  println(`  - 轮询邮箱: node scripts/lobster-comm.js poll`);
  println(`  - 发送指令: node scripts/lobster-comm.js send --type CMD --to 龙二 --action "xxx"`);
  println(`  - 查看状态: node scripts/lobster-comm.js status`);
}

// ============================================================
// HELLO内部发送函数（setup和hello命令共用）
// ============================================================

async function sendHelloInternal(appConfig) {
  const myRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
  const helloBody = proto.buildBody({
    from: appConfig.identity.id,
    to: 'ALL',
    taskId: cfg.generateTaskId(appConfig.identity.id),
    type: 'HELLO',
    priority: 'NORMAL',
    body: {
      role: myRole,
      host: os.hostname(),
      platform: os.platform(),
      user: os.userInfo().username
    },
    timeoutMin: appConfig.polling.task_timeout_min,
    senderRole: myRole,
    sharedSecret: appConfig.security.shared_secret
  });
  
  return await mail.sendLobsterMail(appConfig, helloBody);
}

// ============================================================
// hello 命令 - 手动发送HELLO宣告存在
// ============================================================

async function cmdHello() {
  if (!cfg.isConfigured()) {
    println('❌ 未配置，请先运行: node scripts/lobster-comm.js setup');
    process.exit(1);
  }
  
  const appConfig = cfg.getConfig();
  println('📢 正在发送HELLO...');
  const result = await sendHelloInternal(appConfig);
  
  if (result.success) {
    println('✅ HELLO已发送！其他龙虾将在轮询时发现你。');
  } else {
    println(`❌ HELLO发送失败: ${result.message}`);
    process.exit(1);
  }
}

// ============================================================
// forget 命令 - 从已知龙虾列表中移除
// ============================================================

async function cmdForget(args) {
  if (!cfg.isConfigured()) {
    println('❌ 未配置，请先运行: node scripts/lobster-comm.js setup');
    process.exit(1);
  }
  
  const targetId = args._command !== 'forget' ? args._command : (process.argv[3] || '');
  if (!targetId || targetId.startsWith('--')) {
    println('❌ 请指定要移除的龙虾ID');
    println('   用法: node scripts/lobster-comm.js forget <龙虾ID>');
    process.exit(1);
  }
  
  // 先检查是否存在
  const known = cfg.getKnownLobsters();
  if (!known[targetId]) {
    println(`⚠️  龙虾 ${targetId} 不在已知列表中`);
    process.exit(0);
  }
  
  // 发送GOODBYE通知
  const appConfig = cfg.getConfig();
  const myRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
  const goodbyeBody = proto.buildBody({
    from: appConfig.identity.id,
    to: targetId,
    taskId: cfg.generateTaskId(appConfig.identity.id),
    type: 'GOODBYE',
    priority: 'NORMAL',
    body: {
      reason: 'forgotten_by_user',
      message: `用户已将 ${targetId} 从团队列表中移除`
    },
    timeoutMin: appConfig.polling.task_timeout_min,
    senderRole: myRole,
    sharedSecret: appConfig.security.shared_secret
  });
  
  await mail.sendLobsterMail(appConfig, goodbyeBody);
  
  // 从本地状态中移除
  const removed = cfg.forgetLobster(targetId);
  
  if (removed) {
    println(`✅ 已移除龙虾 ${targetId}`);
    println('   已发送GOODBYE通知，相关pending任务已清理');
  } else {
    println(`⚠️  龙虾 ${targetId} 移除失败（可能已被移除）`);
  }
}

// ============================================================
// send 命令 - 发送LobsterMail邮件
// ============================================================

async function cmdSend(args) {
  if (!cfg.isConfigured()) {
    println('❌ 未配置，请先运行: node scripts/lobster-comm.js setup');
    process.exit(1);
  }
  
  const appConfig = cfg.getConfig();
  
  // 检查权限
  const msgType = args.type || 'CMD';
  if (msgType === 'CMD' && !appConfig.identity.can_initiate && appConfig.identity.work_mode !== 'full') {
    println('❌ 当前工作模式不允许主动发送指令');
    process.exit(1);
  }
  
  const to = args.to;
  if (!to) {
    println('❌ 缺少目标龙虾ID，请使用 --to 指定');
    process.exit(1);
  }
  
  // 自发检测
  if (cfg.isSelfSend(appConfig.identity.id, to)) {
    println(`❌ 不能发指令给自己(${to})，避免空转循环`);
    process.exit(1);
  }
  
  // 读取replyTo（提前，ACK/RESULT/ERROR需要复用作为task-id）
  const replyToTaskId = args.replyTo || args.replyToTaskId || null;
  
  // 生成或使用任务ID（黑名单：只有回复型必须关联原任务，其余自动生成）
  const REPLY_TYPES = ['ACK', 'RESULT', 'ERROR'];
  let taskId = args.taskId || replyToTaskId;
  if (!taskId) {
    if (REPLY_TYPES.includes(msgType)) {
      println('❌ ACK/RESULT/ERROR类型必须指定 --task-id 或 --reply-to');
      process.exit(1);
    }
    taskId = cfg.generateTaskId(appConfig.identity.id);
  }
  
  // 构建body
  const body = {};
  if (args.action) body.action = args.action;
  if (args.params) {
    // 统一params处理：先尝试JSON.parse，确保params是对象
    let parsedParams;
    try {
      parsedParams = typeof args.params === 'string' ? JSON.parse(args.params) : args.params;
    } catch (e) {
      // parse失败，保留原始字符串，接收方可自行处理
      parsedParams = args.params;
    }
    body.params = parsedParams;
  }
  if (args.description) body.description = args.description;
  
  // ACK/RESULT/ERROR：将params内容展开到body顶层（兼容旧版），同时保留params字段
  if (msgType !== 'CMD' && msgType !== 'EXPIRED' && body.params && typeof body.params === 'object') {
    Object.assign(body, body.params);
  }
  
  // EXPIRED类型的body构造
  if (msgType === 'EXPIRED') {
    body.reason = body.reason || 'no_ack_3_polls';
    body.poll_count = parseInt(args.pollCount) || 3;
    body.message = body.message || '连续3次轮询未响应ACK，任务已过时';
  }

  // content字段：所有类型都支持（CMD用content传任务详细说明，DISCUSS/CONCLUDE也是核心字段）
  if (args.content) body.content = args.content;
  
  // DISCUSS/CONCLUDE特有字段
  if (msgType === 'DISCUSS' || msgType === 'CONCLUDE') {
    if (args.topic) body.topic = args.topic;
    if (args.conclusion) body.conclusion = args.conclusion;
  }
  
  const retryCount = parseInt(args.retryCount) || 0;
  const timeout = parseInt(args.timeout) || appConfig.polling.task_timeout_min;
  const priority = args.priority || 'NORMAL';
  
  // 构造完整消息
  const myRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
  const threadId = args.threadId || args.thread || null;
  const msgBody = proto.buildBody({
    from: appConfig.identity.id,
    to: to,
    taskId: taskId,
    type: msgType,
    priority: priority,
    body: body,
    timeoutMin: timeout,
    replyToTaskId: replyToTaskId,
    retryCount: retryCount,
    senderRole: myRole,
    sharedSecret: appConfig.security.shared_secret,
    threadId: threadId
  });
  
  // 发送
  const result = await mail.sendLobsterMail(appConfig, msgBody);
  
  if (result.success) {
    println('✅ 邮件发送成功！');
    println(`   类型:   ${msgType}`);
    println(`   从:     ${appConfig.identity.id}`);
    println(`   到:     ${to}`);
    println(`   任务ID: ${taskId}`);
    if (replyToTaskId) println(`   回复:   ${replyToTaskId}`);
    println(`   优先级: ${priority}`);
    
    // 如果是CMD，记录待ACK
    if (msgType === 'CMD') {
      cfg.addPendingAck(taskId, to, body.description || '');
      const ackTimeoutMin = appConfig.polling.ack_timeout_min || 60;
      println(`   ⏱️  等待ACK确认（${ackTimeoutMin}分钟无响应则判定离线，指令作废）`);
    }
    
    // 如果是RESULT/ERROR，从my_acked_tasks中移除（Agent手动发送了RESULT/ERROR，不再需要自动超时）
    if ((msgType === 'RESULT' || msgType === 'ERROR') && replyToTaskId) {
      cfg.removeMyAckedTask(replyToTaskId);
    }
    
    // 如果是DISCUSS回复，立即记录自己的回复到本地replies（不等下次poll）
    if (msgType === 'DISCUSS' && threadId) {
      const thread = cfg.getThread(threadId);
      if (thread) {
        // 发起方不能用send回复讨论，必须用discuss命令总结并推进
        if (thread.initiator === appConfig.identity.id) {
          println('⚠️ 发起方请使用 discuss --thread 命令总结并推进轮次，不要用 send --type DISCUSS');
        } else {
          const round = body.round || thread.current_round;
          const existingReplies = thread.replies[round] || {};
          if (!existingReplies[appConfig.identity.id]) {
            cfg.addThreadReply(threadId, round, appConfig.identity.id, body);
          }
          // 从my_pending_discuss_replies移除（已回复讨论）
          cfg.removeMyPendingDiscussReply(threadId, round);
        }
      }
    }
    
    // 输出JSON供AI解析
    if (args.json) {
      println('');
      println('---JSON---');
      println(JSON.stringify({ task_id: taskId, type: msgType, to: to, sent: true }));
    }
  } else {
    println(`❌ 发送失败: ${result.message}`);
    process.exit(1);
  }
}

// ============================================================
// poll 命令 - 轮询邮箱
// ============================================================

/**
 * cmdDiscuss - 发起或参与讨论
 * 
 * 用法:
 *   发起讨论: node lobster-comm.js discuss --topic "话题" --to "龙二,龙三" --roles '{"龙二":"challenger"}' --timeout 10 --max-rounds 5 --content "讨论内容"
 *   参与讨论: node lobster-comm.js discuss --thread "thread_id" --content "我的观点"
 */
async function cmdDiscuss(args) {
  if (!cfg.isConfigured()) {
    println('❌ 未配置，请先运行: node scripts/lobster-comm.js setup');
    process.exit(1);
  }
  
  const appConfig = cfg.getConfig();
  const threadId = args.thread || args.threadId || null;
  const content = args.content || '';
  
  // ── 参与讨论（回复已有线程）──
  if (threadId) {
    const thread = cfg.getThread(threadId);
    if (!thread) {
      println(`❌ 线程 ${threadId} 不存在`);
      process.exit(1);
    }
    if (thread.concluded) {
      println(`❌ 线程 ${threadId} 已结束`);
      process.exit(1);
    }
    
    const round = thread.current_round;
    const isInitiator = thread.initiator === appConfig.identity.id;
    
    // ── 发起方：总结并推进轮次 ──
    if (isInitiator) {
      const rc = cfg.checkRoundComplete(threadId, round);
      if (!rc.complete) {
        println(`❌ 参与方尚未全部回复，无法总结。等待中的: ${rc.missing.join(', ')}`);
        process.exit(1);
      }
      
      // 发起方总结：记录总结内容 + 推进轮次 + 通知参与方
      cfg.addThreadReply(threadId, round, appConfig.identity.id, {
        round: round,
        role: thread.roles[appConfig.identity.id] || 'synthesizer',
        content: content,
        is_summary: true
      });
      cfg.removeMyPendingDiscussReply(threadId, round);
      
      // 检查是否达到最大轮次
      if (round >= thread.max_rounds) {
        // 达到最大轮次，自动结束
        const conclusion = content || `达到最大轮次(${thread.max_rounds})，讨论结束`;
        cfg.concludeThread(threadId, conclusion);
        const notifyBody = proto.buildBody({
          from: appConfig.identity.id,
          to: thread.participants.join(','),
          taskId: cfg.generateTaskId(appConfig.identity.id),
          type: 'CONCLUDE',
          priority: 'NORMAL',
          body: {
            round: round,
            total_rounds: thread.max_rounds,
            concluded: true,
            auto_concluded: false
          },
          senderRole: appConfig.identity.work_mode === 'full' ? 'hub' : 'worker',
          sharedSecret: appConfig.security.shared_secret,
          threadId: threadId
        });
        await mail.sendLobsterMail(appConfig, notifyBody);
        println('✅ 讨论总结已发送，讨论已结束！');
        println(`   线程:   ${threadId}`);
        println(`   轮次:   ${round}/${thread.max_rounds}（最后一轮）`);
        println(`   结论:   ${content || '达到最大轮次'}`);
        if (args.json) {
          println('');
          println('---JSON---');
          println(JSON.stringify({ type: 'CONCLUDE', thread_id: threadId, round: round, concluded: true }));
        }
      } else {
        // 推进到下一轮
        cfg.advanceThreadRound(threadId);
        const nextRound = round + 1;
        // 通知参与方进入下一轮，携带发起方的总结
        const notifyBody = proto.buildBody({
          from: appConfig.identity.id,
          to: thread.participants.join(','),
          taskId: cfg.generateTaskId(appConfig.identity.id),
          type: 'DISCUSS',
          priority: 'NORMAL',
          body: {
            action: 'ROUND_ADVANCE',
            round: nextRound,
            thread_id: threadId,
            summary: content,
            summary_from: appConfig.identity.id
          },
          senderRole: appConfig.identity.work_mode === 'full' ? 'hub' : 'worker',
          sharedSecret: appConfig.security.shared_secret,
          threadId: threadId
        });
        await mail.sendLobsterMail(appConfig, notifyBody);
        println('✅ 讨论总结已发送，推进到下一轮！');
        println(`   线程:   ${threadId}`);
        println(`   轮次:   ${round}→${nextRound}`);
        println(`   总结:   ${content ? content.substring(0, 50) + '...' : '（无总结内容）'}`);
        if (args.json) {
          println('');
          println('---JSON---');
          println(JSON.stringify({ type: 'DISCUSS', thread_id: threadId, round: round, next_round: nextRound, advanced: true }));
        }
      }
      return;
    }
    
    // ── 参与方：正常回复讨论 ──
    const myRole = thread.roles[appConfig.identity.id] || null;
    
    const body = {
      round: round,
      role: myRole,
      content: content
    };
    
    const taskId = cfg.generateTaskId(appConfig.identity.id);
    const senderRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
    
    const msgBody = proto.buildBody({
      from: appConfig.identity.id,
      to: thread.initiator,
      taskId: taskId,
      type: 'DISCUSS',
      priority: 'NORMAL',
      body: body,
      timeoutMin: thread.timeout_min,
      senderRole: senderRole,
      sharedSecret: appConfig.security.shared_secret,
      threadId: threadId
    });
    
    const result = await mail.sendLobsterMail(appConfig, msgBody);
    
    if (result.success) {
      // 同时记录到本地线程状态
      cfg.addThreadReply(threadId, round, appConfig.identity.id, body);
      // 从my_pending_discuss_replies移除（已回复）
      cfg.removeMyPendingDiscussReply(threadId, round);
      println('✅ 讨论回复已发送！');
      println(`   线程:   ${threadId}`);
      println(`   轮次:   ${round}`);
      println(`   角色:   ${myRole || '未指定'}`);
      println(`   任务ID: ${taskId}`);
      if (args.json) {
        println('');
        println('---JSON---');
        println(JSON.stringify({ task_id: taskId, type: 'DISCUSS', thread_id: threadId, round: round, sent: true }));
      }
    } else {
      println(`❌ 发送失败: ${result.error}`);
      process.exit(1);
    }
    return;
  }
  
  // ── 发起新讨论 ──
  const topic = args.topic;
  if (!topic) {
    println('❌ 发起讨论必须指定 --topic');
    process.exit(1);
  }
  
  const to = args.to;
  if (!to) {
    println('❌ 发起讨论必须指定 --to（参与者，逗号分隔）');
    process.exit(1);
  }
  
  const participants = to.split(',').map(s => s.trim()).filter(s => s);
  if (participants.length === 0) {
    println('❌ 至少需要一个参与者');
    process.exit(1);
  }
  
  // 解析角色（支持两种格式）
  // 格式1 简写：龙二:challenger,龙三:researcher（推荐，避免Shell中文编码问题）
  // 格式2 JSON：'{"龙二":"challenger"}'（PowerShell下中文易损坏，不推荐）
  let roles = {};
  if (args.roles) {
    const raw = typeof args.roles === 'string' ? args.roles : String(args.roles);
    if (raw.trim().startsWith('{')) {
      // JSON格式
      try {
        roles = JSON.parse(raw);
      } catch (e) {
        println('❌ --roles JSON解析失败（PowerShell下中文易损坏，建议用简写格式 龙二:challenger）');
        process.exit(1);
      }
    } else {
      // 简写格式：龙二:challenger,龙三:researcher
      for (const pair of raw.split(',')) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.lastIndexOf(':');
        if (colonIdx <= 0) {
          println(`❌ --roles 简写格式错误: "${trimmed}"，正确格式: 龙二:challenger`);
          process.exit(1);
        }
        const lobsterId = trimmed.substring(0, colonIdx).trim();
        const role = trimmed.substring(colonIdx + 1).trim();
        roles[lobsterId] = role;
      }
    }
  }
  
  // 验证角色
  const validRoles = Object.keys(proto.DISCUSS_ROLES);
  for (const [lobsterId, role] of Object.entries(roles)) {
    if (!validRoles.includes(role)) {
      println(`❌ 无效角色: ${role}（有效值: ${validRoles.join(', ')}）`);
      process.exit(1);
    }
  }
  
  const timeoutMin = parseInt(args.timeout) || 10;
  const maxRounds = parseInt(args.maxRounds) || 5;
  const newThreadId = cfg.generateTaskId(appConfig.identity.id);
  
  // 中枢自己的角色
  const initiatorRole = roles[appConfig.identity.id] || 'synthesizer';
  const allParticipants = [appConfig.identity.id, ...participants.filter(p => p !== appConfig.identity.id)];
  const allRoles = { [appConfig.identity.id]: initiatorRole, ...roles };
  
  const body = {
    round: 1,
    topic: topic,
    content: content,
    participants: allRoles,
    timeout_min: timeoutMin,
    max_rounds: maxRounds
  };
  
  const taskId = cfg.generateTaskId(appConfig.identity.id);
  const senderRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
  
  const msgBody = proto.buildBody({
    from: appConfig.identity.id,
    to: participants.join(','),
    taskId: taskId,
    type: 'DISCUSS',
    priority: 'NORMAL',
    body: body,
    timeoutMin: timeoutMin,
    senderRole: senderRole,
    sharedSecret: appConfig.security.shared_secret,
    threadId: newThreadId
  });
  
  const result = await mail.sendLobsterMail(appConfig, msgBody);
  
  if (result.success) {
    // 创建本地线程状态
    cfg.createThread(newThreadId, topic, appConfig.identity.id,
      allParticipants, allRoles, timeoutMin, maxRounds);
    // 记录发起者自己的回复
    cfg.addThreadReply(newThreadId, 1, appConfig.identity.id, body);
    
    println('✅ 讨论已发起！');
    println(`   话题:   ${topic}`);
    println(`   线程ID: ${newThreadId}`);
    println(`   参与者: ${allParticipants.join(', ')}`);
    println(`   角色:   ${Object.entries(allRoles).map(([k,v]) => `${k}=${proto.DISCUSS_ROLES[v]?.name || v}`).join(', ')}`);
    println(`   超时:   ${timeoutMin}分钟/轮`);
    println(`   最大轮: ${maxRounds}`);
    println(`   任务ID: ${taskId}`);
    if (args.json) {
      println('');
      println('---JSON---');
      println(JSON.stringify({ task_id: taskId, type: 'DISCUSS', thread_id: newThreadId, sent: true }));
    }
  } else {
    println(`❌ 发送失败: ${result.error}`);
    process.exit(1);
  }
}

/**
 * cmdConclude - 结束讨论
 */
async function cmdConclude(args) {
  if (!cfg.isConfigured()) {
    println('❌ 未配置，请先运行: node scripts/lobster-comm.js setup');
    process.exit(1);
  }
  
  const appConfig = cfg.getConfig();
  const threadId = args.thread || args.threadId;
  
  if (!threadId) {
    println('❌ 必须指定 --thread');
    process.exit(1);
  }
  
  const thread = cfg.getThread(threadId);
  if (!thread) {
    println(`❌ 线程 ${threadId} 不存在`);
    process.exit(1);
  }
  
  if (thread.initiator !== appConfig.identity.id) {
    println(`❌ 只有发起者(${thread.initiator})才能结束讨论`);
    process.exit(1);
  }
  
  const conclusion = args.conclusion || args.content || '';
  const votes = args.votes ? (typeof args.votes === 'string' ? JSON.parse(args.votes) : args.votes) : null;
  
  // CONCLUDE邮件只发最小信息（通知参与者线程已结束，不发结论/总结，避免浪费参与者token）
  // 结论由发起方呈现给用户，不通过邮件传递
  const body = {
    round: thread.current_round,
    total_rounds: thread.max_rounds,
    concluded: true,
    auto_concluded: false
  };
  if (votes) body.votes = votes;
  
  const taskId = cfg.generateTaskId(appConfig.identity.id);
  const senderRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
  
  const msgBody = proto.buildBody({
    from: appConfig.identity.id,
    to: thread.participants.join(','),
    taskId: taskId,
    type: 'CONCLUDE',
    priority: 'NORMAL',
    body: body,
    timeoutMin: thread.timeout_min,
    senderRole: senderRole,
    sharedSecret: appConfig.security.shared_secret,
    threadId: threadId
  });
  
  const result = await mail.sendLobsterMail(appConfig, msgBody);
  
  if (result.success) {
    cfg.concludeThread(threadId, conclusion);
    println('✅ 讨论已结束！');
    println(`   线程:   ${threadId}`);
    println(`   话题:   ${thread.topic}`);
    println(`   轮次:   ${thread.current_round}`);
    println(`   结论:   ${conclusion}`);
    if (args.json) {
      println('');
      println('---JSON---');
      println(JSON.stringify({ type: 'CONCLUDE', thread_id: threadId, concluded: true }));
    }
  } else {
    println(`❌ 发送失败: ${result.error}`);
    process.exit(1);
  }
}

/**
 * cmdThreads - 查看讨论线程状态
 */
async function cmdThreads(args) {
  const threads = cfg.getActiveThreads();
  const entries = Object.entries(threads);
  
  if (entries.length === 0) {
    println('📭 没有讨论线程');
    return;
  }
  
  if (args.json || !process.stdout.isTTY) {
    println(JSON.stringify(threads, null, 2));
    return;
  }
  
  for (const [threadId, thread] of entries) {
    const status = thread.concluded ? '🔴 已结束' : '🟢 进行中';
    println('');
    println(`  ${status} ${thread.topic}`);
    println(`  线程ID: ${threadId}`);
    println(`  发起者: ${thread.initiator}`);
    println(`  参与者: ${thread.participants.join(', ')}`);
    println(`  角色:   ${Object.entries(thread.roles).map(([k,v]) => `${k}=${proto.DISCUSS_ROLES[v]?.name || v}`).join(', ')}`);
    println(`  轮次:   ${thread.current_round}/${thread.max_rounds}`);
    println(`  超时:   ${thread.timeout_min}分钟/轮`);
    
    if (!thread.concluded) {
      const rc = cfg.checkRoundComplete(threadId, thread.current_round);
      println(`  当前轮: ${rc.replied.join(',')}已回复, ${rc.missing.length > 0 ? rc.missing.join(',') + '未回复' : '全部已回复'}`);
    } else {
      println(`  结论:   ${thread.conclusion || '无'}`);
    }
  }
}

async function cmdPoll(args) {
  if (!cfg.isConfigured()) {
    println('❌ 未配置，请先运行: node scripts/lobster-comm.js setup');
    process.exit(1);
  }
  
  const appConfig = cfg.getConfig();
  const isCompact = args.compact || false;
  const isActionOnly = args.actionOnly || false;
  const myId = appConfig.identity.id;
  
  // 轮询邮箱
  const result = await mail.pollInbox(appConfig);
  
  // ============================================================
  // v3: 轮询计数制 — 不重发CMD
  // ============================================================
  const pollNotifications = [];  // 通知给AI/用户的信息
  
  // ── 收到CMD自动ACK：确保通信链路不因Agent不自觉而断裂 ──
  const incomingCmds = result.new_messages.filter(m => m.type === 'CMD' && m.to === myId);
  for (const cmdMsg of incomingCmds) {
    // 自动回复ACK：收到即确认，不需要等Agent手动调用send
    const myRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
    const ackTaskId = cfg.generateTaskId(appConfig.identity.id);
    const isProgressQuery = cmdMsg.body && cmdMsg.body.action === 'progress_query';
    const ackBody = proto.buildBody({
      from: appConfig.identity.id,
      to: cmdMsg.from,
      taskId: ackTaskId,
      type: 'ACK',
      priority: 'NORMAL',
      body: {
        status: 'received',
        message: `${appConfig.identity.id}已收到指令${isProgressQuery ? '（进度询问）' : ''}`,
        action: cmdMsg.body ? cmdMsg.body.action : undefined
      },
      timeoutMin: appConfig.polling.task_timeout_min,
      replyToTaskId: cmdMsg.task_id,
      retryCount: 0,
      senderRole: myRole,
      sharedSecret: appConfig.security.shared_secret
    });
    
    const ackResult = await mail.sendLobsterMail(appConfig, ackBody);
    if (ackResult.success) {
      // 记录到my_acked_tasks：跟踪"我ACK了但还没发RESULT"的任务
      if (!isProgressQuery) {
        cfg.addMyAckedTask(cmdMsg.task_id, cmdMsg.from,
          cmdMsg.body ? cmdMsg.body.action : '',
          cmdMsg.body ? (cmdMsg.body.description || '') : '');
      }
      if (isProgressQuery) {
        // 进度询问：静默ACK，不推送通知打扰用户
        // (CLIXML防御：debug日志写文件，不写stderr)
      } else {
        // 正式CMD：通知Agent需要执行并发RESULT
        // 执行完毕后必须回复RESULT/ERROR：这是执行结果反馈，不是ACK确认（ACK已自动发）
        const cmdContent = cmdMsg.body ? (cmdMsg.body.content || cmdMsg.body.description || '') : '';
        pollNotifications.push({
          type: 'AUTO_ACK_SENT',
          task_id: cmdMsg.task_id,
          from: cmdMsg.from,
          action: cmdMsg.body ? cmdMsg.body.action : '',
          content: cmdContent || undefined,
          must_reply: true,  // 执行完毕后必须回复RESULT或ERROR（ACK是执行前确认已自动发，RESULT是执行后反馈必须手动发）
          action_required: true,
          action_type: 'reply_result',
          message: `📤 已自动ACK ${cmdMsg.from} 的指令 (${cmdMsg.body ? cmdMsg.body.action : cmdMsg.task_id})，执行完毕后必须回复RESULT或ERROR${cmdContent ? '\n任务内容: ' + cmdContent : ''}`
        });
      }
    }
  }
  
  // ── 处理ACK消息：从pending_acks移到pending_results ──
  const ackMessages = result.new_messages.filter(m => m.type === 'ACK' && m.reply_to_task_id);
  for (const ackMsg of ackMessages) {
    // 找到对应的pending_ack
    const pendingAck = cfg.getPendingAcks().find(p => p.task_id === ackMsg.reply_to_task_id);
    if (pendingAck) {
      // 移到pending_results
      cfg.addPendingResult(pendingAck.task_id, pendingAck.to, pendingAck.description);
      cfg.removePendingAck(pendingAck.task_id);
      pollNotifications.push({
        type: 'ACK_RECEIVED',
        task_id: pendingAck.task_id,
        from: ackMsg.from,
        message: `✅ ${ackMsg.from} 已确认接收任务 ${pendingAck.task_id}`
      });
    }
  }
  
  // ── 处理RESULT/ERROR消息：从pending_results移除 ──
  const resultMessages = result.new_messages.filter(m => (m.type === 'RESULT' || m.type === 'ERROR') && m.reply_to_task_id);
  for (const resMsg of resultMessages) {
    const pendingResult = cfg.getPendingResults().find(p => p.task_id === resMsg.reply_to_task_id);
    if (pendingResult) {
      cfg.removePendingResult(resMsg.reply_to_task_id);
      pollNotifications.push({
        type: resMsg.type === 'RESULT' ? 'RESULT_RECEIVED' : 'ERROR_RECEIVED',
        task_id: resMsg.reply_to_task_id,
        from: resMsg.from,
        message: resMsg.type === 'RESULT'
          ? `✅ ${resMsg.from} 执行完毕: ${JSON.stringify(resMsg.body)}`
          : `❌ ${resMsg.from} 执行失败: ${JSON.stringify(resMsg.body)}`
      });
    }
  }
  
  // ── 检查pending_acks：时间判定 ──
  const ACK_TIMEOUT_MIN = appConfig.polling.ack_timeout_min || 60;  // 默认60分钟
  const currentPendingAcks = cfg.getPendingAcks();
  const acksToRemove = [];
  
  for (const pending of currentPendingAcks) {
    const elapsedMin = (Date.now() - new Date(pending.sent_at).getTime()) / 60000;
    
    if (elapsedMin >= ACK_TIMEOUT_MIN) {
      // 超时无ACK → 发EXPIRED → 判定离线
      pollNotifications.push({
        type: 'ACK_TIMEOUT',
        task_id: pending.task_id,
        to: pending.to,
        elapsed_min: Math.round(elapsedMin),
        timeout_min: ACK_TIMEOUT_MIN,
        message: `❌ 龙虾 ${pending.to} ${Math.round(elapsedMin)}分钟未响应ACK（超时${ACK_TIMEOUT_MIN}分钟），判定离线，指令作废`
      });
      
      // 标记离线
      cfg.markLobsterOffline(pending.to, pending.task_id);
      
      // 发送EXPIRED通知
      const myRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
      const expiredBody = proto.buildBody({
        from: appConfig.identity.id,
        to: pending.to,
        taskId: cfg.generateTaskId(appConfig.identity.id),
        type: 'EXPIRED',
        priority: 'NORMAL',
        body: {
          reason: 'ack_timeout',
          elapsed_min: Math.round(elapsedMin),
          timeout_min: ACK_TIMEOUT_MIN,
          message: `${Math.round(elapsedMin)}分钟未响应ACK，任务已过时`
        },
        timeoutMin: appConfig.polling.task_timeout_min,
        replyToTaskId: pending.task_id,
        retryCount: 0,
        senderRole: myRole,
        sharedSecret: appConfig.security.shared_secret
      });
      
      const expiredResult = await mail.sendLobsterMail(appConfig, expiredBody);
      if (expiredResult.success) {
        // (CLIXML防御：EXPIRED发送成功，不写stderr)
      }
      
      acksToRemove.push(pending.task_id);
    }
    // 未超时不发通知，用status命令查看
  }
  
  // 批量移除已超时的pending_acks
  for (const taskId of acksToRemove) {
    cfg.removePendingAck(taskId);
  }
  
  // ── 检查pending_results：时间判定 ──
  const RESULT_TIMEOUT_MIN = appConfig.polling.result_timeout_min || 120;  // 默认120分钟
  const currentPendingResults = cfg.getPendingResults();
  const resultsToRemove = [];
  
  for (const pending of currentPendingResults) {
    const elapsedMin = (Date.now() - new Date(pending.ack_at).getTime()) / 60000;
    
    if (elapsedMin >= RESULT_TIMEOUT_MIN) {
      // 超时无RESULT → 通知用户
      pollNotifications.push({
        type: 'RESULT_TIMEOUT',
        task_id: pending.task_id,
        to: pending.to,
        elapsed_min: Math.round(elapsedMin),
        timeout_min: RESULT_TIMEOUT_MIN,
        message: `⚠️ 龙虾 ${pending.to} 已确认接收但${Math.round(elapsedMin)}分钟未交付结果（超时${RESULT_TIMEOUT_MIN}分钟）`
      });
      resultsToRemove.push(pending.task_id);
    }
    // 未超时不发通知，不询问进度，用status命令查看
  }
  
  // 批量移除已超时的pending_results
  for (const taskId of resultsToRemove) {
    cfg.removePendingResult(taskId);
  }
  
  // ── 检查my_acked_tasks：执行者侧时间判定 ──
  // 我ACK了别人的CMD但还没发RESULT → 检查时间 → 超时自动发ERROR RESULT
  const MY_ACKED_TIMEOUT_MIN = appConfig.polling.result_timeout_min || 120;  // 默认120分钟
  const myAckedTasks = cfg.getMyAckedTasks();
  const myAckedToRemove = [];
  
  for (const ackedTask of myAckedTasks) {
    const elapsedMin = (Date.now() - new Date(ackedTask.acked_at || ackedTask.ack_at).getTime()) / 60000;
    
    if (elapsedMin >= MY_ACKED_TIMEOUT_MIN) {
      // 超时未发RESULT → 自动发ERROR RESULT关闭链路
      pollNotifications.push({
        type: 'MY_ACKED_TIMEOUT',
        task_id: ackedTask.task_id,
        from: ackedTask.from,
        action: ackedTask.action,
        elapsed_min: Math.round(elapsedMin),
        timeout_min: MY_ACKED_TIMEOUT_MIN,
        message: `❌ 任务 ${ackedTask.task_id}（来自${ackedTask.from}）${Math.round(elapsedMin)}分钟未交付RESULT，已自动发送ERROR关闭链路`
      });
      
      // 自动发送ERROR RESULT
      const myRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
      const errorBody = proto.buildBody({
        from: appConfig.identity.id,
        to: ackedTask.from,
        taskId: cfg.generateTaskId(appConfig.identity.id),
        type: 'ERROR',
        priority: 'NORMAL',
        body: {
          status: 'timeout',
          message: `${appConfig.identity.id} 在${MY_ACKED_TIMEOUT_MIN}分钟内未交付RESULT，任务自动关闭`,
          original_task_id: ackedTask.task_id,
          action: ackedTask.action,
          auto_generated: true
        },
        timeoutMin: appConfig.polling.task_timeout_min,
        replyToTaskId: ackedTask.task_id,
        retryCount: 0,
        senderRole: myRole,
        sharedSecret: appConfig.security.shared_secret
      });
      
      const errorResult = await mail.sendLobsterMail(appConfig, errorBody);
      if (errorResult.success) {
        // (CLIXML防御：Auto-ERROR RESULT发送成功，不写stderr)
      }
      
      myAckedToRemove.push(ackedTask.task_id);
    }
    // 未超时不发提醒，用status命令查看
  }
  
  // 批量移除已超时的my_acked_tasks
  for (const taskId of myAckedToRemove) {
    cfg.removeMyAckedTask(taskId);
  }
  
  // ── 检查my_pending_discuss_replies：时间判定 ──
  // 我需要回复讨论但还没回复 → 检查时间 → 超时标记
  const DISCUSS_TIMEOUT_MIN = appConfig.polling.discuss_timeout_min || 120;  // 默认120分钟
  const myPendingDiscuss = cfg.getMyPendingDiscussReplies();
  const discussToRemove = [];
  
  for (const pending of myPendingDiscuss) {
    // 检查该讨论线程是否还存在且未结束
    const thread = cfg.getThread(pending.thread_id);
    if (!thread || thread.concluded) {
      // 讨论已结束，直接移除
      discussToRemove.push({ thread_id: pending.thread_id, round: pending.round });
      continue;
    }
    // 检查是否还需要行动
    const isInitiator = thread.initiator === myId;
    if (isInitiator) {
      // 发起方：检查是否还需要总结（round未推进且pending_summary_sent）
      if (pending.round < thread.current_round || !thread.pending_summary_sent) {
        // 轮次已推进（已总结）或pending_summary已清除 → 不再需要行动
        discussToRemove.push({ thread_id: pending.thread_id, round: pending.round });
        continue;
      }
    } else {
      // 参与方：检查是否还在missing列表中
      const missing = cfg.checkRoundComplete(pending.thread_id, thread.current_round).missing;
      if (!missing.includes(myId)) {
        // 已不需要我回复（可能已回复或轮次已推进）
        discussToRemove.push({ thread_id: pending.thread_id, round: pending.round });
        continue;
      }
    }
    
    const elapsedMin = (Date.now() - new Date(pending.created_at).getTime()) / 60000;
    
    if (elapsedMin >= DISCUSS_TIMEOUT_MIN) {
      if (isInitiator) {
        // ── 发起方超时未总结 ──
        // 活跃线程检查中有独立的pending_summary超时机制会自动推进轮次
        // 这里只需通知+移除pending
        pollNotifications.push({
          type: 'MY_DISCUSS_SUMMARY_TIMEOUT',
          thread_id: pending.thread_id,
          round: pending.round,
          topic: pending.topic,
          elapsed_min: Math.round(elapsedMin),
          timeout_min: DISCUSS_TIMEOUT_MIN,
          message: `❌ 讨论[${pending.topic}]第${pending.round}轮你${Math.round(elapsedMin)}分钟未总结，系统将自动推进轮次`
        });
        discussToRemove.push({ thread_id: pending.thread_id, round: pending.round });
      } else {
        // ── 参与方超时未回复 ──
        pollNotifications.push({
          type: 'MY_DISCUSS_TIMEOUT',
          thread_id: pending.thread_id,
          round: pending.round,
          topic: pending.topic,
          elapsed_min: Math.round(elapsedMin),
          timeout_min: DISCUSS_TIMEOUT_MIN,
          message: `❌ 讨论[${pending.topic}]第${pending.round}轮你${Math.round(elapsedMin)}分钟未回复，已标记轮次超时`
        });
        
        // 通知发起方该参与者本轮超时
        const myRole = appConfig.identity.work_mode === 'full' ? 'hub' : 'worker';
        const timeoutBody = proto.buildBody({
          from: appConfig.identity.id,
          to: thread.initiator,
          taskId: cfg.generateTaskId(appConfig.identity.id),
          type: 'DISCUSS',
          priority: 'NORMAL',
          body: { 
            action: 'PARTICIPANT_ROUND_TIMEOUT', 
            round: pending.round, 
            thread_id: pending.thread_id, 
            participant: appConfig.identity.id,
            message: `${appConfig.identity.id} 在${DISCUSS_TIMEOUT_MIN}分钟内未回复讨论，轮次超时`
          },
          senderRole: myRole,
          sharedSecret: appConfig.security.shared_secret,
          threadId: pending.thread_id
        });
        mail.sendLobsterMail(appConfig, timeoutBody).catch(() => {});
        
        discussToRemove.push({ thread_id: pending.thread_id, round: pending.round });
      }
    }
    // 未超时不发提醒，用status命令查看
  }
  
  // 批量移除已超时/已结束的my_pending_discuss_replies
  for (const item of discussToRemove) {
    cfg.removeMyPendingDiscussReply(item.thread_id, item.round);
  }
  
  // ── 处理DISCUSS消息：记录到active_threads ──
  const discussMessages = result.new_messages.filter(m => m.type === 'DISCUSS');
  for (const dmsg of discussMessages) {
    const threadId = dmsg.thread_id;
    if (!threadId) continue;
    
    // 跳过已结束线程的消息
    const existingThread = cfg.getThread(threadId);
    if (existingThread && existingThread.concluded) continue;
    
    const body = dmsg.body || {};
    const round = body.round || 1;
    
    // ROUND_ADVANCE：发起方总结+通知参与者进入下一轮
    if (body.action === 'ROUND_ADVANCE') {
      const thread = cfg.getThread(threadId);
      if (thread && !thread.concluded) {
        // 参与者：更新本地current_round到指定轮次 + 展示总结 + 标记需要回复
        if (thread.initiator !== appConfig.identity.id) {
          cfg.advanceThreadRound(threadId, round);
          // 如果有总结，记录到上一轮的replies中
          if (body.summary && body.summary_from) {
            cfg.addThreadReply(threadId, round - 1, body.summary_from, {
              round: round - 1,
              role: thread.roles[body.summary_from] || 'synthesizer',
              content: body.summary,
              is_summary: true
            });
          }
          // 标记需要回复新轮次
          cfg.addMyPendingDiscussReply(threadId, round, body.summary_from || thread.initiator, thread.topic);
          pollNotifications.push({
            type: 'DISCUSS_ROUND_ADVANCE',
            thread_id: threadId,
            round: round,
            summary: body.summary || null,
            summary_from: body.summary_from || null,
            action_required: true,
            action_type: 'reply_discussion',
            message: body.summary 
              ? `📝 讨论[${thread.topic}] 发起方总结第${round-1}轮并推进到第${round}轮，请回复\n总结摘要: ${body.summary.substring(0, 100)}${body.summary.length > 100 ? '...' : ''}`
              : `💬 讨论[${thread.topic}] 进入第${round}轮，请回复`
          });
        }
      }
      continue;
    }
    
    // ROUND_AUTO_CONCLUDE：发起方通知参与者讨论自动结束
    if (body.action === 'ROUND_AUTO_CONCLUDE') {
      const thread = cfg.getThread(threadId);
      if (thread && !thread.concluded) {
        cfg.concludeThread(threadId, body.conclusion || '达到最大轮次，自动结束');
        pollNotifications.push({
          type: 'DISCUSS_AUTO_CONCLUDED',
          thread_id: threadId,
          round: round,
          message: `🏁 讨论[${thread.topic}] 发起方通知讨论已结束`
        });
      }
      continue;
    }
    
    // PARTICIPANT_ROUND_TIMEOUT：参与者通知发起方本轮超时未回复
    if (body.action === 'PARTICIPANT_ROUND_TIMEOUT') {
      const thread = cfg.getThread(threadId);
      if (thread && !thread.concluded && thread.initiator === appConfig.identity.id) {
        // 发起方收到超时通知：标记该参与者本轮超时
        cfg.markThreadRoundTimeout(threadId, body.round || round, [body.participant || dmsg.from]);
        pollNotifications.push({
          type: 'PARTICIPANT_DISCUSS_TIMEOUT',
          thread_id: threadId,
          round: body.round || round,
          participant: body.participant || dmsg.from,
          message: `⚠️ 讨论[${thread.topic}] 参与者${body.participant || dmsg.from}第${body.round || round}轮超时未回复`
        });
      }
      continue;
    }
    
    // 如果是发起者发来的讨论（包含participants字段），创建线程
    if (body.participants && body.topic) {
      if (!existingThread) {
        cfg.createThread(threadId, body.topic, dmsg.from, 
          Object.keys(body.participants), body.participants,
          body.timeout_min || 10, body.max_rounds || 5);
      }
    }
    
    // 记录回复（所有参与者包括发起方）
    const thread = cfg.getThread(threadId);
    if (thread) {
      // 避免重复记录（同一轮同一人只记录一次）
      const existingReplies = thread.replies[round] || {};
      if (!existingReplies[dmsg.from]) {
        cfg.addThreadReply(threadId, round, dmsg.from, body);
      }
      
      // 检查本轮是否完成（只有非发起方的参与方全部回复才算完成）
      const rc = cfg.checkRoundComplete(threadId, round);
      if (rc.complete) {
        if (thread.initiator === appConfig.identity.id) {
          // ── 发起方：所有参与方已回复，等待发起方总结后推进 ──
          // 不再自动推进，而是通知发起方总结
          if (!thread.pending_summary_sent) {
            cfg.setPendingSummarySent(threadId, true);
            // 添加到my_pending_discuss_replies，让Agent知道需要总结
            cfg.addMyPendingDiscussReply(threadId, round, appConfig.identity.id, thread.topic);
            pollNotifications.push({
              type: 'DISCUSS_PENDING_SUMMARY',
              thread_id: threadId,
              round: round,
              message: `📝 讨论[${thread.topic}] 第${round}轮参与方全部回复完毕，请总结并推进下一轮（discuss --thread ${threadId} --content "你的总结"）`
            });
          }
        } else {
          // ── 参与方：只记录通知，等待发起方总结并推进 ──
          pollNotifications.push({
            type: 'DISCUSS_ROUND_COMPLETE',
            thread_id: threadId,
            round: round,
            message: `💬 讨论[${thread.topic}] 第${round}轮全部回复完毕，等待发起方总结并推进`
          });
        }
      } else {
        pollNotifications.push({
          type: 'DISCUSS_ROUND_WAITING',
          thread_id: threadId,
          round: round,
          message: `💬 讨论[${thread.topic}] 第${round}轮：${rc.missing.join(',')} 尚未回复`
        });
      }
    }
  }
  
  // ── 处理CONCLUDE消息：标记讨论结束 ──
  const concludeMessages = result.new_messages.filter(m => m.type === 'CONCLUDE');
  for (const cmsg of concludeMessages) {
    const threadId = cmsg.thread_id;
    if (!threadId) continue;
    cfg.concludeThread(threadId, (cmsg.body || {}).conclusion || '');
    pollNotifications.push({
      type: 'DISCUSS_CONCLUDED',
      thread_id: threadId,
      from: cmsg.from,
      message: `🏁 讨论[${threadId}]已结束: ${(cmsg.body || {}).conclusion || ''}`
    });
  }
  
  // ── 检查活跃线程：等待发起方总结 / 轮次超时（只有发起方执行） ──
  const activeThreads = cfg.getActiveThreads();
  for (const [threadId, thread] of Object.entries(activeThreads)) {
    if (thread.concluded) continue;
    // 参与者不检测轮次推进/超时，由发起方统一推进
    if (thread.initiator !== appConfig.identity.id) continue;
    
    const rc = cfg.checkRoundComplete(threadId, thread.current_round);
    
    // 情况1：所有参与方已回复，等待发起方总结
    if (rc.complete && !thread.pending_summary_sent) {
      cfg.setPendingSummarySent(threadId, true);
      cfg.addMyPendingDiscussReply(threadId, thread.current_round, appConfig.identity.id, thread.topic);
      pollNotifications.push({
        type: 'DISCUSS_PENDING_SUMMARY',
        thread_id: threadId,
        round: thread.current_round,
        message: `📝 讨论[${thread.topic}] 第${thread.current_round}轮参与方全部回复完毕，请总结并推进下一轮（discuss --thread ${threadId} --content "你的总结"）`
      });
      continue;
    }
    
    // 情况2：参与方全部回复，已通知发起方，检查总结超时
    if (rc.complete && thread.pending_summary_sent) {
      const summaryWaitMin = (Date.now() - new Date(thread.last_active).getTime()) / 60000;
      if (summaryWaitMin > thread.timeout_min) {
        // 发起方超时未总结，自动推进
        if (thread.current_round >= thread.max_rounds) {
          cfg.concludeThread(threadId, `达到最大轮次(${thread.max_rounds})，自动结束`);
          const notifyBody = proto.buildBody({
            from: appConfig.identity.id,
            to: thread.participants.join(','),
            taskId: cfg.generateTaskId(appConfig.identity.id),
            type: 'DISCUSS',
            priority: 'NORMAL',
          body: { action: 'ROUND_AUTO_CONCLUDE', round: thread.current_round, thread_id: threadId, concluded: true },
          senderRole: appConfig.identity.work_mode === 'full' ? 'hub' : 'worker',
          sharedSecret: appConfig.security.shared_secret,
          threadId: threadId
        });
        mail.sendLobsterMail(appConfig, notifyBody).catch(() => {});
        pollNotifications.push({
          type: 'DISCUSS_AUTO_CONCLUDED',
          thread_id: threadId,
          round: thread.current_round,
          message: `⏰ 讨论[${thread.topic}] 发起方超时未总结，达到最大轮次，自动结束`
        });
      } else {
        cfg.advanceThreadRound(threadId);
        const nextRound = thread.current_round + 1;
        const notifyBody = proto.buildBody({
          from: appConfig.identity.id,
          to: thread.participants.join(','),
          taskId: cfg.generateTaskId(appConfig.identity.id),
          type: 'DISCUSS',
          priority: 'NORMAL',
          body: { action: 'ROUND_ADVANCE', round: nextRound, thread_id: threadId, summary_timeout: true },
            senderRole: appConfig.identity.work_mode === 'full' ? 'hub' : 'worker',
            sharedSecret: appConfig.security.shared_secret,
            threadId: threadId
          });
          mail.sendLobsterMail(appConfig, notifyBody).catch(() => {});
          pollNotifications.push({
            type: 'DISCUSS_SUMMARY_TIMEOUT',
            thread_id: threadId,
            round: thread.current_round,
            message: `⏰ 讨论[${thread.topic}] 发起方超时未总结，自动推进到第${nextRound}轮`
          });
        }
        cfg.removeMyPendingDiscussReply(threadId, thread.current_round);
      }
      continue;
    }
    
    // 情况3：参与方未全部回复，检查轮次超时
    const roundStartTime = thread.last_active;
    const elapsedMin = (Date.now() - new Date(roundStartTime).getTime()) / 60000;
    if (elapsedMin > thread.timeout_min && !rc.complete) {
      cfg.markThreadRoundTimeout(threadId, thread.current_round, rc.missing);
      if (thread.current_round >= thread.max_rounds) {
        cfg.concludeThread(threadId, `达到最大轮次(${thread.max_rounds})，自动结束`);
        const notifyBody = proto.buildBody({
          from: appConfig.identity.id,
          to: thread.participants.join(','),
          taskId: cfg.generateTaskId(appConfig.identity.id),
          type: 'DISCUSS',
          priority: 'NORMAL',
          body: { action: 'ROUND_AUTO_CONCLUDE', round: thread.current_round, thread_id: threadId, concluded: true },
          senderRole: appConfig.identity.work_mode === 'full' ? 'hub' : 'worker',
          sharedSecret: appConfig.security.shared_secret,
          threadId: threadId
        });
        mail.sendLobsterMail(appConfig, notifyBody).catch(() => {});
        pollNotifications.push({
          type: 'DISCUSS_AUTO_CONCLUDED',
          thread_id: threadId,
          message: `⏰ 讨论[${thread.topic}] 达到最大轮次，自动结束`
        });
      } else {
        cfg.advanceThreadRound(threadId);
        const nextRound = thread.current_round + 1;
        const notifyBody = proto.buildBody({
          from: appConfig.identity.id,
          to: thread.participants.join(','),
          taskId: cfg.generateTaskId(appConfig.identity.id),
          type: 'DISCUSS',
          priority: 'NORMAL',
          body: { action: 'ROUND_ADVANCE', round: nextRound, thread_id: threadId, timeout_missing: rc.missing },
          senderRole: appConfig.identity.work_mode === 'full' ? 'hub' : 'worker',
          sharedSecret: appConfig.security.shared_secret,
          threadId: threadId
        });
        mail.sendLobsterMail(appConfig, notifyBody).catch(() => {});
        pollNotifications.push({
          type: 'DISCUSS_ROUND_TIMEOUT',
          thread_id: threadId,
          round: thread.current_round,
          message: `⏰ 讨论[${thread.topic}] 第${thread.current_round}轮超时，${rc.missing.join(',')}未回复，自动推进到第${nextRound}轮`
        });
      }
    }
  }
  
  // 清理回复链深度
  cfg.cleanupReplyDepths();
  
  // 同步known_lobsters的离线状态
  cfg.syncKnownLobsterStatus();
  
  // ============================================================
  // 输出结果
  // ============================================================
  
  // 精简版消息（去掉uid等内部字段）
  const slimMessages = result.new_messages.map(m => {
    const slim = {
      type: m.type,
      from: m.from,
      to: m.to,
      task_id: m.task_id,
      reply_to_task_id: m.reply_to_task_id || undefined,
      priority: m.priority !== 'NORMAL' ? m.priority : undefined,
      body: m.body,
      timeout_min: m.type === 'CMD' ? m.timeout_min : undefined,
      timestamp: m.timestamp
    };
    if (m.thread_id) slim.thread_id = m.thread_id;
    // action_required标记：需要本龙虾行动的消息
    // CMD发给自己的 → 需要回ACK+执行
    // DISCUSS发给自己且当前轮次waiting包含自己 → 需要回复讨论
    if (m.type === 'CMD' && m.to === myId) {
      slim.action_required = true;
      slim.action_type = 'reply_result';  // ACK是执行前确认（已自动发），RESULT是执行后反馈（Agent必须发）
      slim.must_reply = true;  // 执行完毕后必须回复RESULT/ERROR，不回复会导致任务卡死
      // 确保content/description展示在body中，方便Agent看到任务详情
      if (slim.body && !slim.body.content && !slim.body.description) {
        slim.body._note = 'body中无content/description，请告知中枢需要更多信息';
      }
    } else if (m.type === 'DISCUSS' && m.to === myId && m.thread_id) {
      let thread = (cfg.getActiveThreads() || {})[m.thread_id];
      
      // 本地找不到线程时，尝试从消息内容自动创建（防止因state丢失或线程ID不匹配导致消息被忽略）
      if (!thread && m.body) {
        const body = m.body;
        // 从DISCUSS消息中提取线程信息
        if (body.topic || body.content) {
          const isInitiatorMsg = body.action === 'ROUND_ADVANCE' || body.action === 'ROUND_AUTO_CONCLUDE';
          // 自动创建线程：发起方=消息发送者，我是参与方
          const initiator = m.from;
          const participants = [initiator, myId];
          const roles = { [myId]: 'divergent' };  // 默认角色
          const maxRounds = body.max_rounds || body.round || 5;
          const timeoutMin = body.timeout_min || 20;
          cfg.createThread(m.thread_id, body.topic || '未知话题', initiator, participants, roles, timeoutMin, maxRounds);
          thread = cfg.getThread(m.thread_id);
          // 如果是ROUND_ADVANCE，同步轮次
          if (isInitiatorMsg && body.round) {
            cfg.advanceThreadRound(m.thread_id, body.round);
            thread = cfg.getThread(m.thread_id);
          }
          // 记录发起方的回复（如果有的话）
          if (body.content && initiator !== myId) {
            cfg.addThreadReply(m.thread_id, body.round || 1, initiator, body);
          }
          pollNotifications.push({
            type: 'DISCUSS_THREAD_RECOVERED',
            thread_id: m.thread_id,
            message: `⚠️ 收到未知线程[${m.thread_id}]的DISCUSS消息，已自动创建线程。可能是state丢失或线程ID不匹配。`
          });
        }
      }
      
      if (thread && !thread.concluded) {
        const isInitiator = thread.initiator === myId;
        const rc = cfg.checkRoundComplete(m.thread_id, thread.current_round);
        
        if (isInitiator) {
          // ── 发起方：参与方全部回复后等待总结 ──
          const waitingForSummary = rc.complete;
          if (slim.body && typeof slim.body === 'object') {
            slim.body.max_rounds = thread.max_rounds;
            slim.body.waiting_for_me = waitingForSummary;
            slim.body.discuss_status = waitingForSummary ? 'SUMMARY_REQUIRED' : 'WAITING_PARTICIPANTS';
            if (waitingForSummary) {
              slim.body.must_reply = true;
            }
            const roundInfo = `[第${thread.current_round}轮/共${thread.max_rounds}轮 | ${waitingForSummary ? '📝请总结并推进下一轮' : '⏳等待参与方回复'}]`;
            if (slim.body.content && typeof slim.body.content === 'string') {
              slim.body.content = roundInfo + ' ' + slim.body.content;
            }
          }
          if (waitingForSummary) {
            slim.action_required = true;
            slim.action_type = 'summarize_discussion';
            cfg.addMyPendingDiscussReply(m.thread_id, thread.current_round, myId, thread.topic);
          }
        } else {
          // ── 参与方：等待我回复讨论 ──
          const missing = rc.missing;
          const waitingForMe = missing.includes(myId);
          if (slim.body && typeof slim.body === 'object') {
            slim.body.max_rounds = thread.max_rounds;
            slim.body.waiting_for_me = waitingForMe;
            slim.body.discuss_status = waitingForMe ? 'REPLY_REQUIRED' : 'WAITING_OTHERS';
            if (waitingForMe) {
              slim.body.must_reply = true;
            }
            const roundInfo = `[第${thread.current_round}轮/共${thread.max_rounds}轮 | ${waitingForMe ? '⚡必须回复' : '⏳已回复等待他人'}]`;
            if (slim.body.content && typeof slim.body.content === 'string') {
              slim.body.content = roundInfo + ' ' + slim.body.content;
            }
          }
          if (waitingForMe) {
            slim.action_required = true;
            slim.action_type = 'reply_discussion';
            cfg.addMyPendingDiscussReply(m.thread_id, thread.current_round,
              m.from, thread.topic);
          }
        }
      }
    } else if (m.type === 'ERROR' && m.to === myId) {
      slim.action_required = true;
      slim.action_type = 'handle_error';
    }
    return slim;
  });
  
  // 精简版pending概要
  const fullState = cfg.getState();
  const ackTimeoutMin = appConfig.polling.ack_timeout_min || 60;
  const resultTimeoutMin = appConfig.polling.result_timeout_min || 120;
  const ackSummary = fullState.pending_acks.length > 0
    ? { count: fullState.pending_acks.length, waiting_for: [...new Set(fullState.pending_acks.map(p => p.to))], details: fullState.pending_acks.map(p => ({ task_id: p.task_id, to: p.to, elapsed_min: Math.round((Date.now() - new Date(p.sent_at).getTime()) / 60000), timeout_min: ackTimeoutMin })) }
    : { count: 0 };
  const resultSummary = (fullState.pending_results || []).length > 0
    ? { count: fullState.pending_results.length, waiting_for: [...new Set(fullState.pending_results.map(p => p.to))], details: fullState.pending_results.map(p => ({ task_id: p.task_id, to: p.to, elapsed_min: Math.round((Date.now() - new Date(p.ack_at).getTime()) / 60000), timeout_min: resultTimeoutMin })) }
    : { count: 0 };
  
  // 讨论概要
  const discussSummary = (() => {
    const threads = cfg.getActiveThreads();
    const active = Object.entries(threads).filter(([_, t]) => !t.concluded);
    if (active.length === 0) return { count: 0 };
    return {
      count: active.length,
      threads: active.map(([id, t]) => {
        const rc = cfg.checkRoundComplete(id, t.current_round);
        const isInitiator = t.initiator === myId;
        return {
          thread_id: id,
          topic: t.topic,
          round: t.current_round,
          max_rounds: t.max_rounds,
          participants: t.participants,
          roles: t.roles,
          waiting: rc.missing,
          waiting_for_me: isInitiator ? rc.complete : rc.missing.includes(myId),  // 发起方：等总结；参与方：等回复
          initiator_action: isInitiator && rc.complete ? 'summarize' : undefined
        };
      })
    };
  })();
  
  // 已ACK未RESULT概要（我欠别人的RESULT）
  const myAckedSummary = (() => {
    const tasks = cfg.getMyAckedTasks();
    if (tasks.length === 0) return { count: 0 };
    const timeoutMin = appConfig.polling.result_timeout_min || 120;
    return {
      count: tasks.length,
      tasks: tasks.map(t => ({
        task_id: t.task_id,
        from: t.from,
        action: t.action,
        elapsed_min: Math.round((Date.now() - new Date(t.acked_at || t.ack_at).getTime()) / 60000),
        timeout_min: timeoutMin
      }))
    };
  })();
  
  // 待回复讨论概要（我欠别人的讨论回复）
  const myDiscussPendingSummary = (() => {
    const items = cfg.getMyPendingDiscussReplies();
    if (items.length === 0) return { count: 0 };
    const timeoutMin = appConfig.polling.discuss_timeout_min || 120;
    return {
      count: items.length,
      items: items.map(d => ({
        thread_id: d.thread_id,
        round: d.round,
        topic: d.topic,
        from: d.from,
        elapsed_min: Math.round((Date.now() - new Date(d.created_at).getTime()) / 60000),
        timeout_min: timeoutMin
      }))
    };
  })();
  
  // 离线龙虾概要
  const offlineSummary = Object.keys(fullState.offline_lobsters || {});
  
  // errors只返回前3条
  const slimErrors = result.errors.slice(0, 3);
  
  if (args.json || !process.stdout.isTTY) {
    // JSON输出
    if (isActionOnly) {
      // action-only模式：只输出需要本龙虾行动的事项
      const actionMessages = slimMessages.filter(m => {
        // 收到的CMD（需要回ACK+执行）
        if (m.type === 'CMD' && m.to === myId) return true;
        // DISCUSS/CONCLUDE 且自己是参与者（需要回复）
        if ((m.type === 'DISCUSS' || m.type === 'CONCLUDE') && m.to === myId) return true;
        // 发给自己的ERROR（需要处理）
        if (m.type === 'ERROR' && m.to === myId) return true;
        return false;
      });
      // 需要行动的讨论线程
      const actionDiscuss = (() => {
        const threads = cfg.getActiveThreads();
        const active = Object.entries(threads).filter(([_, t]) => !t.concluded);
        const myThreads = active.filter(([id, t]) => {
          const rc = cfg.checkRoundComplete(id, t.current_round);
          const isInitiator = t.initiator === myId;
          // 发起方：参与方全部回复后需要总结
          if (isInitiator) return rc.complete;
          // 参与方：还没回复需要回复
          return rc.missing.includes(myId);
        });
        if (myThreads.length === 0) return { count: 0 };
        return {
          count: myThreads.length,
          threads: myThreads.map(([id, t]) => {
            const isInitiator = t.initiator === myId;
            const rc = cfg.checkRoundComplete(id, t.current_round);
            return {
              thread_id: id,
              topic: t.topic,
              round: t.current_round,
              max_rounds: t.max_rounds,
              roles: t.roles,
              waiting_for_me: true,
              action_type: isInitiator ? 'summarize_discussion' : 'reply_discussion'
            };
          })
        };
      })();
      const actionNotifications = pollNotifications.filter(n => {
        // 超时/离线通知（需要告知用户）
        if (['ACK_TIMEOUT', 'RESULT_TIMEOUT', 'OFFLINE_DETECTED'].includes(n.type)) return true;
        return false;
      });
      const output = {
        actions: actionMessages,
        my_acked_tasks: myAckedSummary.count > 0 ? myAckedSummary : undefined,
        my_discuss_pending: myDiscussPendingSummary.count > 0 ? myDiscussPendingSummary : undefined,
        discuss_actions: actionDiscuss,
        timeout_notifications: actionNotifications.length > 0 ? actionNotifications : undefined
      };
      println(JSON.stringify(output, null, 2));
    } else if (isCompact) {
      // compact模式：极简输出
      const compact = {
        msgs: slimMessages.map(m => ({
          id: m.task_id,
          t: m.type,
          f: m.from,
          body: m.body,
          tid: m.thread_id || undefined,
          act: m.action_required || undefined  // action_required简写
        })),
        ack_n: ackSummary.count,
        result_n: resultSummary.count,
        my_acked_n: myAckedSummary.count,
        my_discuss_n: myDiscussPendingSummary.count,
        discuss_n: discussSummary.count,
        offline: offlineSummary.length > 0 ? offlineSummary : undefined,
        notify: pollNotifications.length > 0 ? pollNotifications.map(n => ({ t: n.type, m: n.message })) : undefined
      };
      println(JSON.stringify(compact));
    } else {
      const output = {
        new_messages: slimMessages,
        ack_summary: ackSummary,
        result_summary: resultSummary,
        my_acked_summary: myAckedSummary,
        my_discuss_pending_summary: myDiscussPendingSummary,
        discuss_summary: discussSummary,
        offline_lobsters: offlineSummary.length > 0 ? offlineSummary : undefined,
        poll_notifications: pollNotifications,
        errors: slimErrors,
        warnings: result.warnings && result.warnings.length > 0 ? result.warnings : undefined
      };
      println(JSON.stringify(output, null, 2));
    }
  } else {
    // 人类可读输出
    if (result.new_messages.length > 0) {
      println(`📬 收到 ${result.new_messages.length} 条新消息:`);
      for (const msg of result.new_messages) {
        println('');
        println(`  类型: ${msg.type}`);
        println(`  来自: ${msg.from}`);
        println(`  任务ID: ${msg.task_id}`);
        if (msg.thread_id) println(`  线程ID: ${msg.thread_id}`);
        if (msg.reply_to_task_id) println(`  回复: ${msg.reply_to_task_id}`);
        if (msg.priority) println(`  优先级: ${msg.priority}`);
        if (msg.body) println(`  内容: ${JSON.stringify(msg.body)}`);
        if (msg.timeout_min) println(`  超时: ${msg.timeout_min}分钟`);
      }
    } else {
      println('📭 没有新消息');
    }
    
    if (pollNotifications.length > 0) {
      println('');
      println('📋 轮询状态通知:');
      for (const n of pollNotifications) {
        println(`  ${n.message}`);
      }
    }
    
    // 已ACK未RESULT展示
    const myAckedTasks = cfg.getMyAckedTasks();
    if (myAckedTasks.length > 0) {
      println('');
      println(`📝 待交付RESULT (${myAckedTasks.length}):`);
      for (const t of myAckedTasks) {
        const elapsed = Math.round((Date.now() - new Date(t.ack_at).getTime()) / 60000);
        println(`     → 来自${t.from} | ${t.action || t.task_id} | 已等${elapsed}分钟 | 提醒${t.no_result_remind_count || 0}/3次`);
      }
    }
    
    // 待回复讨论展示
    const myDiscussPending = cfg.getMyPendingDiscussReplies();
    if (myDiscussPending.length > 0) {
      println('');
      println(`💬 待回复讨论 (${myDiscussPending.length}):`);
      for (const d of myDiscussPending) {
        const elapsed = Math.round((Date.now() - new Date(d.created_at).getTime()) / 60000);
        println(`     → [${d.topic}] 第${d.round}轮 | 来自${d.from} | 已等${elapsed}分钟 | 提醒${d.remind_count || 0}/3次`);
      }
    }
    
    if (offlineSummary.length > 0) {
      println('');
      println('🔴 离线龙虾:');
      for (const lid of offlineSummary) {
        const info = fullState.offline_lobsters[lid];
        const since = info ? new Date(info.since).toLocaleString() : '未知';
        println(`  - ${lid}（离线自 ${since}）`);
      }
    }
    
    if (slimErrors.length > 0) {
      println('');
      println('⚠️  处理异常:');
      for (const e of slimErrors) {
        println(`  - ${e.error}`);
      }
      if (result.errors.length > 3) {
        println(`  ... 共${result.errors.length}条异常，仅显示前3条`);
      }
    }
    
    if (result.warnings && result.warnings.length > 0) {
      println('');
      println('⚠️  告警:');
      for (const w of result.warnings) {
        println(`  - ${w}`);
      }
    }
  }
}

// ============================================================
// status 命令 - 查看状态
// ============================================================

async function cmdStatus(args) {
  if (!cfg.isConfigured()) {
    println('❌ 未配置，请先运行: node scripts/lobster-comm.js setup');
    process.exit(1);
  }
  
  const appConfig = cfg.getConfig();
  const state = cfg.getState();
  
  printSeparator();
  println('  🦞 龙虾通信状态');
  printSeparator();
  println('');
  println(`  龙虾ID:     ${appConfig.identity.id}`);
  println(`  工作模式:   ${appConfig.identity.work_mode === 'receive_only' ? '仅接收' : appConfig.identity.work_mode === 'interactive' ? '交互' : '中枢'}`);
  println(`  邮箱账号:   ${appConfig.email.account}`);
  println(`  轮询间隔:   ${appConfig.polling.interval_min} 分钟`);
  println(`  信任白名单: ${appConfig.interaction.trust_whitelist.join(', ') || '（空=接收所有）'}`);
  println(`  上次轮询:   ${state.last_poll_time || '从未轮询'}`);
  println('');
  
  // 待ACK列表
  if (state.pending_acks.length > 0) {
    println(`  📤 等待ACK (${state.pending_acks.length}):`);
    for (const p of state.pending_acks) {
      const elapsed = Math.round((Date.now() - new Date(p.sent_at).getTime()) / 60000);
      println(`     → ${p.to} | ${p.task_id} | 已等待${elapsed}分钟 | 超时${appConfig.polling.ack_timeout_min || 60}分钟`);
    }
  } else {
    println('  📤 等待ACK: 无');
  }
  
  println('');
  
  // 待RESULT列表
  const pendingResults = state.pending_results || [];
  if (pendingResults.length > 0) {
    println(`  🔄 等待RESULT (${pendingResults.length}):`);
    for (const p of pendingResults) {
      const elapsed = Math.round((Date.now() - new Date(p.ack_at).getTime()) / 60000);
      println(`     → ${p.to} | ${p.task_id} | 已等待${elapsed}分钟 | 超时${appConfig.polling.result_timeout_min || 120}分钟`);
    }
  } else {
    println('  🔄 等待RESULT: 无');
  }
  
  println('');
  
  // 我欠别人的RESULT
  const myAckedTasks = cfg.getMyAckedTasks();
  if (myAckedTasks.length > 0) {
    println(`  📝 待交付RESULT (${myAckedTasks.length}):`);
    for (const t of myAckedTasks) {
      const elapsed = Math.round((Date.now() - new Date(t.acked_at || t.ack_at).getTime()) / 60000);
      println(`     ← 来自${t.from} | ${t.action || t.task_id} | 已等${elapsed}分钟 | 超时${appConfig.polling.result_timeout_min || 120}分钟`);
    }
  } else {
    println('  📝 待交付RESULT: 无');
  }
  
  println('');
  
  // 我欠别人的讨论回复
  const myDiscussPending = cfg.getMyPendingDiscussReplies();
  if (myDiscussPending.length > 0) {
    println(`  💬 待回复讨论 (${myDiscussPending.length}):`);
    for (const d of myDiscussPending) {
      const elapsed = Math.round((Date.now() - new Date(d.created_at).getTime()) / 60000);
      const discussTimeoutMin = appConfig.polling.discuss_timeout_min || 120;
      println(`     ← [${d.topic}] 第${d.round}轮 | 来自${d.from} | 已等${elapsed}分钟 | 超时${discussTimeoutMin}分钟`);
    }
  } else {
    println('  💬 待回复讨论: 无');
  }
  
  println('');
  
  // 离线龙虾
  const offlineKeys = Object.keys(state.offline_lobsters || {});
  if (offlineKeys.length > 0) {
    println(`  🔴 离线龙虾 (${offlineKeys.length}):`);
    for (const lid of offlineKeys) {
      const info = state.offline_lobsters[lid];
      const since = new Date(info.since).toLocaleString();
      println(`     - ${lid}（离线自 ${since}，失败任务${info.failed_tasks.length}个）`);
    }
  } else {
    println('  🔴 离线龙虾: 无');
  }
  
  println('');
  
  // 团队列表（所有龙虾可见）
  const knownLobsters = cfg.getKnownLobsters();
  const knownIds = Object.keys(knownLobsters);
  if (knownIds.length > 0) {
    // 同步离线状态
    const offlineSet = new Set(offlineKeys);
    println(`  👥 团队成员 (${knownIds.length}):`);
    println('     ┌──────────────────┬────────┬─────────┬──────────┬──────────────────┐');
    println('     │ ID               │ 角色   │ 状态    │ 最后活跃  │ 部署位置          │');
    println('     ├──────────────────┼────────┼─────────┼──────────┼──────────────────┤');
    for (const lid of knownIds) {
      const info = knownLobsters[lid];
      const roleLabel = info.role === 'hub' ? '🧠 中枢' : '🔧 干活';
      const statusLabel = offlineSet.has(lid) ? '⚫ 离线' : '🟢 在线';
      const lastActive = info.last_active ? timeAgo(info.last_active) : '未知';
      const hostLabel = info.host || '未知';
      const idPadded = lid.padEnd(16);
      println(`     │ ${idPadded} │ ${roleLabel} │ ${statusLabel} │ ${lastActive.padEnd(8)} │ ${hostLabel.padEnd(16)} │`);
    }
    println('     └──────────────────┴────────┴─────────┴──────────┴──────────────────┘');
  } else {
    println('  👥 团队成员: 尚未发现其他龙虾（轮询后将自动识别）');
  }
  
  println('');
  
  // 过期任务
  if (state.expired_task_ids && state.expired_task_ids.length > 0) {
    println(`  ⏰ 已过期任务 (${state.expired_task_ids.length}):`);
    const recent = state.expired_task_ids.slice(-5);
    for (const tid of recent) {
      println(`     - ${tid}`);
    }
    if (state.expired_task_ids.length > 5) {
      println(`     ... 共${state.expired_task_ids.length}个`);
    }
  }
  
  println('');
  
  // 最近已处理
  const recent = state.processed_task_ids.slice(-5);
  if (recent.length > 0) {
    println(`  📋 最近已处理 (最近5条):`);
    for (const tid of recent) {
      println(`     - ${tid}`);
    }
  }
  
  println('');
  
  // 连接测试（可选）
  if (args.testConn) {
    println('  🔌 连接测试:');
    const imapResult = await mail.testImapConnection(appConfig.email);
    const smtpResult = await mail.testSmtpConnection(appConfig.email);
    println(`     IMAP: ${imapResult.success ? '✅' : '❌'} ${imapResult.message}`);
    println(`     SMTP: ${smtpResult.success ? '✅' : '❌'} ${smtpResult.message}`);
  }
  
  printSeparator();
}

// ============================================================
// cleanup 命令 - 清理过期邮件
// ============================================================

async function cmdCleanup() {
  if (!cfg.isConfigured()) {
    println('❌ 未配置，请先运行: node scripts/lobster-comm.js setup');
    process.exit(1);
  }
  
  const appConfig = cfg.getConfig();
  const result = await mail.cleanupExpiredMails(appConfig);
  
  if (result.success) {
    println('✅ 清理完成');
    println(`   已处理邮件删除: ${result.done_deleted} 封`);
    println(`   异常邮件删除: ${result.error_deleted} 封`);
  } else {
    println(`❌ 清理失败: ${result.message}`);
  }
}

// ============================================================
// test-conn 命令 - 测试邮箱连接
// ============================================================

async function cmdTestConn() {
  if (!cfg.isConfigured()) {
    println('❌ 未配置，请先运行: node scripts/lobster-comm.js setup');
    process.exit(1);
  }
  
  const appConfig = cfg.getConfig();
  
  println('正在测试邮箱连接...');
  println('');
  
  const imapResult = await mail.testImapConnection(appConfig.email);
  const smtpResult = await mail.testSmtpConnection(appConfig.email);
  
  println(`IMAP (${appConfig.email.imap_host}:${appConfig.email.imap_port}): ${imapResult.success ? '✅' : '❌'} ${imapResult.message}`);
  println(`SMTP (${appConfig.email.smtp_host}:${appConfig.email.smtp_port}): ${smtpResult.success ? '✅' : '❌'} ${smtpResult.message}`);
  
  if (imapResult.success && smtpResult.success) {
    println('');
    println('✅ 连接正常，龙虾通信可用！');
  } else {
    println('');
    println('❌ 连接异常，请检查：');
    println('   1. 邮箱账号是否正确');
    println('   2. 授权码是否正确（非登录密码）');
    println('   3. 163邮箱IMAP/SMTP是否已开启');
    println('   4. 网络是否正常');
  }
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  const args = parseArgs(process.argv);
  const command = args._command || 'help';
  
  switch (command) {
    case 'setup':
      await cmdSetup(args);
      break;
    case 'send':
      await cmdSend(args);
      break;
    case 'poll':
      await cmdPoll(args);
      break;
    case 'status':
      await cmdStatus(args);
      break;
    case 'cleanup':
      await cmdCleanup();
      break;
    case 'test-conn':
      await cmdTestConn();
      break;
    case 'hello':
      await cmdHello();
      break;
    case 'forget':
      await cmdForget(args);
      break;
    case 'discuss':
      await cmdDiscuss(args);
      break;
    case 'conclude':
      await cmdConclude(args);
      break;
    case 'threads':
      await cmdThreads(args);
      break;
    case 'help':
    default:
      println('');
      println('🦞 LobsterComm - 龙虾跨平台通信 v3');
      println('');
      println('用法: node lobster-comm.js <命令> [选项]');
      println('');
      println('命令:');
      println('  setup       交互式配置向导（首次部署必须执行）');
      println('  send        发送邮件');
      println('  poll        轮询邮箱，检查新消息');
      println('  status      查看通信状态');
      println('  hello       发送HELLO宣告存在（setup后自动执行）');
      println('  forget <ID> 从团队列表中移除指定龙虾');
      println('  discuss     发起或参与讨论');
      println('  conclude    结束讨论');
      println('  threads     查看讨论线程状态');
      println('  cleanup     清理过期邮件');
      println('  test-conn   测试邮箱连接');
      println('');
      println('send 选项:');
      println('  --type <CMD|ACK|RESULT|ERROR|EXPIRED|HELLO|GOODBYE|DISCUSS|CONCLUDE>  邮件类型');
      println('  --to <龙虾ID>                  目标龙虾ID（HELLO可用ALL）');
      println('  --action <动作>                 CMD的动作标识');
      println('  --params <JSON>                 参数（JSON字符串）');
      println('  --description <文本>            任务描述');
      println('  --content <文本>                内容（支持\\n转义为换行符）');
      println('  --content-file <路径>           从文件读取内容（多行内容推荐，彻底避免shell截断）');
      println('  --topic <话题>                  讨论话题（DISCUSS类型）');
      println('  --conclusion <结论>             讨论结论（CONCLUDE类型）');
      println('  --thread <线程ID>               讨论线程ID（DISCUSS/CONCLUDE类型）');
      println('  --timeout <分钟>                超时时间');
      println('  --priority <HIGH|NORMAL|LOW>    优先级');
      println('  --reply-to <任务ID>             回复的原任务ID');
      println('  --retry-count <数字>            重试次数');
      println('  --json                          以JSON格式输出结果');
      println('');
      println('poll 选项:');
      println('  --json          以JSON格式输出结果');
      println('  --compact       极简JSON输出（省token）');
      println('  --action-only   只输出需要本龙虾行动的事项（收到的CMD、待回复讨论、超时通知）');
      println('');
      println('status 选项:');
      println('  --test-conn    同时测试邮箱连接');
      println('');
      println('discuss 选项:');
      println('  --topic <话题>                讨论话题（发起时必填）');
      println('  --to <龙虾ID,>              参与者，逗号分隔（发起时必填）');
      println('  --roles <角色分配>           简写格式: 龙二:challenger,龙三:researcher');
      println('                              JSON格式: \'{"龙二":"challenger"}\'（PowerShell下中文易损坏，不推荐）');
      println('  --timeout <分钟>             每轮超时（默认10）');
      println('  --max-rounds <数字>          最大轮次（默认5）');
      println('  --content <内容>             内容（支持\\n转义为换行符）');
      println('  --content-file <路径>        从文件读取内容（多行内容推荐，避免shell截断）');
      println('  --thread <线程ID>            参与讨论时指定线程');
      println('  --json                       JSON格式输出');
      println('');
      println('conclude 选项:');
      println('  --thread <线程ID>            要结束的线程（必填）');
      println('  --conclusion <结论>          讨论结论');
      println('  --votes <JSON>               投票结果');
      println('');
      println('可用讨论角色: challenger(找茬者) researcher(搜索者) detailer(细节控)');
      println('              divergent(发散者) pragmatist(务实者) synthesizer(归纳者) observer(旁观者)');
      println('');
      break;
  }
}

main().catch(e => {
  println(`❌ 执行异常: ${e.message}`);
  process.exit(1);
});
