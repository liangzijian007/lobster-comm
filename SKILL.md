---
name: lobster-comm
description: "龙虾跨平台通信。基于163共享邮箱实现OpenClaw之间指令调度、ACK确认、结果回传、强制RESULT、多轮讨论。触发词：龙虾通信、跨平台通信、龙虾调度、指挥龙虾XX、让XX龙虾去做、给XX龙虾发指令、发指令给XX龙虾、龙虾讨论、龙虾圆桌、龙虾话题、龙虾开会、龙虾状态、查看龙虾"
description_zh: "龙虾跨平台通信协议v3，基于163共享邮箱实现OpenClaw间指令调度、多轮讨论与过期通知，超时判定与轮询间隔解耦"
metadata:
  openclaw:
    emoji: "🦞"
    requires:
      bins:
        - node
        - npm
---

# 🦞 LobsterComm v3 - 龙虾跨平台通信

基于 **163共享邮箱** 的龙虾（OpenClaw）跨平台通信协议。通过邮件实现龙虾间指令调度、ACK确认、结果回传、任务过期通知。

**v3核心变更：超时判定与轮询间隔解耦。** 旧版用轮询计数制（3次poll无响应→超时），但不同龙虾轮询间隔不同（10分钟vs 1小时），导致超时时间不稳定。新版改为**时间判定为主**：`ack_timeout_min`（默认60分钟）无ACK→EXPIRED；`result_timeout_min`（默认120分钟）无RESULT→自动发ERROR关闭链路；`discuss_timeout_min`（默认120分钟）未回复→轮次超时。**CMD→强制ACK（auto-ACK），ACK→强制RESULT（超时自动发ERROR关闭链路），DISCUSS→强制回复（超时标记轮次超时）。** **发起方=主持人：不参与辩论，每轮总结后推进轮次；参与方=回复者：按角色回应议题。**

---

## 📋 前提条件

- Node.js 18+ 已安装
- 一个163邮箱（所有龙虾共用）
- 163邮箱已开启IMAP/SMTP服务并获取授权码
- 所有龙虾安装本技能

---

## 🚀 首次部署（重要！）

安装本技能后，**必须先运行 setup 完成配置**，否则无法使用。

### 第一步：安装依赖

```bash
cd ~/.workbuddy/skills/lobster-comm && npm install --production
```

### 第二步：运行配置向导

**方式一：交互式（用户手动运行）**

```bash
node scripts/lobster-comm.js setup
```

配置向导分5步，**必填项有空值校验，不会允许留空**：

| 步骤 | 序号 | 配置项 | 必填 | 说明 | 示例 |
|------|------|--------|------|------|------|
| 1.共享邮箱 | ① | 163邮箱账号 | ✅ | 所有龙虾共用 | lobster@163.com |
| | ② | 授权码 | ✅ | 输入不显示 | ABCDEFGH1234 |
| 2.龙虾身份 | ③ | 龙虾唯一ID | ✅ | 不可重复 | 龙一、龙二、龙三 |
| | ④ | 职责角色 | ✅ | 中枢/交互/被动 | 1=中枢 |
| | ⑤ | 允许主动指挥 | 中枢默认y | | y |
| 3.安全配置 | ⑥ | 通信密钥 | ✅ | 所有龙虾必须一致，留空自动生成 | mySecret2026! |
| | ⑦ | 信任龙虾ID | ✅ | 允许指令的龙虾，逗号分隔，*=全部 | 龙一,龙二 |
| 4.轮询配置 | ⑧ | 轮询间隔 | ✅ | 分钟，<5会警告163限频 | 10 |
| | ⑨ | 任务超时 | 默认30 | 分钟 | 30 |
| 5.高级配置 | ⑩ | 自动互回复轮次 | 默认0 | 0=永不自动回复 | 0 |
| | ⑪ | 已处理邮件保留 | 默认24 | 小时 | 24 |
| | ⑫ | 异常邮件保留 | 默认168 | 小时=7天 | 168 |

**方式二：非交互式（Agent远程配置，推荐）**

Agent通过 `--json` 或 `--json-file` 一次性传入所有配置，跳过交互式问答：

```bash
# 方式A：通过命令行直接传JSON（注意PowerShell中文编码问题，推荐用--json-file）
node scripts/lobster-comm.js setup --json '{"account":"xxx@163.com","auth_code":"XXXX","id":"龙一","work_mode":"full","shared_secret":"auto","trust_ids":"*","interval_min":10,"task_timeout_min":30}'

# 方式B：通过文件传JSON（推荐，避免Shell编码/转义问题）
# 1. 先将配置写入临时文件
# 2. 然后执行：
node scripts/lobster-comm.js setup --json-file /path/to/setup-config.json
```

**`--json` / `--json-file` 字段说明：**

| 字段 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| account | ✅ | 163邮箱账号 | - |
| auth_code | ✅ | 授权码 | - |
| id | ✅ | 龙虾唯一ID | - |
| work_mode | | 职责：full/interactive/receive_only | full |
| can_initiate | | 非full模式是否允许主动指挥 | false |
| shared_secret | ✅ | 通信密钥，设"auto"自动生成 | auto |
| trust_ids | ✅ | 信任龙虾ID，逗号分隔，*=全部 | - |
| interval_min | ✅ | 轮询间隔（分钟） | - |
| task_timeout_min | | 任务超时（分钟） | 30 |
| max_auto_reply_rounds | | 最大自动互回复轮次 | 0 |
| done_retention_hours | | 已处理邮件保留（小时） | 24 |
| error_retention_hours | | 异常邮件保留（小时） | 168 |

> **⚠️ PowerShell注意**：`--json` 直接传含中文的JSON字符串会被PowerShell编码损坏，**强烈建议用 `--json-file` 方式**：Agent先将配置写入临时JSON文件，再用 `--json-file` 传入。

**注：v3超时判定与轮询间隔解耦，ack_timeout_min/result_timeout_min/discuss_timeout_min独立配置，默认60/120/120分钟。**

配置保存后，会自动测试IMAP/SMTP连接并发送HELLO宣告存在。

setup输出中会包含 `---AUTOMATION_CONFIG---` JSON块，Agent据此创建自动化任务。

### 第三步：创建定时轮询自动化（必做！）

**setup完成后，Agent必须立即创建定时轮询自动化任务，否则龙虾无法自动检查邮箱。**

根据setup输出的AUTOMATION_CONFIG创建：

- 自动化名称：`龙虾轮询-{龙虾ID}`
- 执行命令：`cd {script_dir} && node scripts/lobster-comm.js poll --compact`
- 调度规则：`FREQ=HOURLY;INTERVAL={interval_min/60的整数部分};BYMINUTE={interval_min}`（或更简单的FREQ=MINUTELY;INTERVAL={interval_min}）
- 状态：ACTIVE

⚠️ **如果不创建轮询自动化，龙虾只能手动poll，无法自动响应其他龙虾的消息。**

---

## 📬 使用指南

### 1. 发送指令给其他龙虾

当用户说"让B002去执行xxx"时，使用：

```bash
node scripts/lobster-comm.js send \
  --type CMD \
  --to B002 \
  --action "execute_skill" \
  --params '{"skill_name":"auto-invoice","task_id":"XQ202604003"}' \
  --description "执行auto-invoice技能，处理XQ202604003任务" \
  --timeout 30 \
  --priority HIGH
```

**参数说明：**

| 参数 | 必填 | 说明 |
|------|------|------|
| --type | 是 | 邮件类型：CMD/ACK/RESULT/ERROR/EXPIRED/HELLO/GOODBYE/DISCUSS/CONCLUDE |
| --to | 是 | 目标龙虾ID（不能与自己相同） |
| --action | CMD必填 | 动作标识 |
| --content | 推荐 | 任务详细说明（支持`\n`转义换行，多行用`--content-file`） |
| --params | 否 | 结构化参数，JSON字符串 |
| --description | 否 | 简短任务描述（人类可读） |
| --timeout | 否 | 超时分钟数，默认使用配置值 |
| --priority | 否 | HIGH/NORMAL/LOW，默认NORMAL |
| --reply-to | 否 | 回复的原任务ID（ACK/RESULT/ERROR时自动复用为task-id，无需再传--task-id） |

> **⚠️ CMD内容传递优先级：** `--content` 传详细任务说明（推荐），`--description` 传简短描述，`--params` 传结构化参数。三者可同时使用。**龙大反馈：之前CMD类型未处理`--content`参数，v3已修复，所有类型都支持`--content`。**

### 2. 回复ACK（确认收到指令）

当收到CMD后，自动回复ACK：

```bash
node scripts/lobster-comm.js send \
  --type ACK \
  --to A001 \
  --reply-to "A001_20260425140000_f3a2" \
  --params '{"status":"received","estimated_min":15,"message":"已收到指令，预计15分钟内完成"}'
```

### 3. 回复RESULT（返回执行结果）

任务执行完成后：

```bash
node scripts/lobster-comm.js send \
  --type RESULT \
  --to A001 \
  --reply-to "A001_20260425140000_f3a2" \
  --params '{"status":"success","summary":"发票已开具完成，发票号12345678"}'
```

### 4. 回复ERROR（执行异常）

任务执行失败时：

```bash
node scripts/lobster-comm.js send \
  --type ERROR \
  --to A001 \
  --reply-to "A001_20260425140000_f3a2" \
  --params '{"status":"failed","message":"auto-invoice执行失败：WPS未响应","retryable":true}'
```

### 5. 发起多轮讨论

多龙虾之间针对某个话题做多轮讨论。**发起方 = 主持人（总结+推进轮次），参与方 = 回复者（回应议题）。**

**讨论流程：**
1. 发起方提出议题+内容 → 参与方按角色回复
2. 所有参与方回复完毕 → 发起方总结并推进下一轮
3. 重复直到最大轮次或发起方手动结束
4. **发起方不需要逐条反驳参与方，只做总结和推进**

```bash
# 发起讨论（指定参与者和角色）—— 推荐简写格式
node scripts/lobster-comm.js discuss \
  --topic "本月报税方案" \
  --to "龙二,龙三" \
  --roles "龙二:challenger,龙三:researcher" \
  --timeout 10 \
  --max-rounds 5 \
  --content "本月报税有两个方案，请讨论..."
```

**参与方回复讨论：**
```bash
node scripts/lobster-comm.js discuss \
  --thread "中枢_20260426_xxxx" \
  --content "方案A有3个漏洞..."
```


**发起方总结并推进轮次：**
```bash
# 所有参与方回复后，发起方总结并推进到下一轮
node scripts/lobster-comm.js discuss \
  --thread "中枢_20260426_xxxx" \
  --content "本轮总结：方案A有3个漏洞需要修复，方案B成本偏高。下一轮请针对混合方案C讨论..."
```

结束讨论（仅发起者可操作）。CONCLUDE邮件只通知参与者"讨论已结束"，**不包含结论/总结**（避免浪费参与者token）。结论由发起方呈现给用户。
```bash
node scripts/lobster-comm.js conclude \
  --thread "中枢_20260426_xxxx" \
  --conclusion "采用混合方案C"
# --conclusion 保存到本地state，不通过邮件发送给参与者
```

**⚠️ `--roles` 参数格式说明：**

| 格式 | 示例 | 说明 |
|------|------|------|
| **简写（推荐）** | `龙二:challenger,龙三:researcher` | 无中文编码问题，所有Shell通用 |
| JSON（不推荐） | `'{"龙二":"challenger"}'` | PowerShell下中文损坏导致解析失败 |

> **PowerShell踩坑：** PowerShell传递含中文的JSON字符串给node.exe时，中文会被编码损坏，导致 `JSON.parse` 失败报 `❌ --roles 格式错误`。这是PowerShell的已知行为，**所有Windows龙虾必须用简写格式**。

可用讨论角色：

| 角色 | 代号 | 思维方式 |
|------|------|---------|
| 找茬者 | `challenger` | 专门反对、挑毛病、找漏洞 |
| 搜索者 | `researcher` | 必须搜索网络找证据或案例才回答 |
| 细节控 | `detailer` | 纠细节、算数字、查一致性 |
| 发散者 | `divergent` | 天马行空、提可能性、防思维定势 |
| 务实者 | `pragmatist` | 只关心能不能落地、成本多少 |
| 归纳者 | `synthesizer` | 梳理各方观点、找共识、整理结论 |
| 旁观者 | `observer` | 不参与讨论，只记录和观察 |

### 6. 轮询邮箱

定期执行以检查新邮件：

```bash
# 标准输出
node scripts/lobster-comm.js poll

# JSON输出
node scripts/lobster-comm.js poll --json

# 极简JSON输出（省token）
node scripts/lobster-comm.js poll --compact

# 只输出需要本龙虾行动的事项
node scripts/lobster-comm.js poll --action-only
```

> **⚠️ Windows龙虾必读 — CLIXML剥离：** PowerShell执行node.exe时会在stdout前后注入CLIXML包裹（`#< CLIXML<Objs...>...</Objs>`），导致JSON.parse失败。Agent收到poll输出后，**必须先提取纯JSON**：找到第一个 `{` 和最后一个 `}` 之间的内容，再JSON.parse。示例：
> ```
> # 原始输出：
> #< CLIXML
> {"msgs":[],"ack_n":0}
> <Objs ...>...</Objs>
> 
> # 正确做法：取第一个{到最后一个}之间的内容
> const firstBrace = output.indexOf('{');
> const lastBrace = output.lastIndexOf('}');
> const cleanJSON = output.substring(firstBrace, lastBrace + 1);
> const parsed = JSON.parse(cleanJSON);
> ```
node scripts/lobster-comm.js poll --action-only
```

**compact输出示例：**
```json
{
  "msgs": [
    {"id":"A001_20260425140000_f3a2","t":"CMD","f":"A001","body":{"action":"execute_skill"}}
  ],
  "ack_n": 1,
  "result_n": 0,
  "offline": ["B002"],
  "notify": []
}
```

**action-only输出示例：**
```json
{
  "actions": [
    {
      "type": "CMD",
      "from": "A001",
      "to": "B002",
      "task_id": "A001_20260425140000_f3a2",
      "action_required": true,
      "action_type": "reply_result",
      "must_reply": true,
      "body": {"action": "execute_skill", "content": "执行auto-invoice技能，处理XQ202604003任务"}
    }
  ],
  "discuss_actions": {
    "count": 1,
    "threads": [
      {
        "thread_id": "A001_20260426015238_b5d9",
        "topic": "本月报税方案",
        "round": 2,
        "max_rounds": 5,
        "waiting_for_me": true
      }
    ]
  },
  "timeout_notifications": [
    {"type": "ACK_TIMEOUT", "message": "❌ 龙虾 B002 60分钟未响应ACK，判定离线，指令作废"}
  ]
}
```

**标准JSON输出示例：**

```json
{
  "new_messages": [
    {
      "type": "CMD",
      "from": "A001",
      "to": "B002",
      "task_id": "A001_20260425140000_f3a2",
      "priority": "HIGH",
      "body": {"action": "execute_skill", "params": {"skill_name": "auto-invoice"}},
      "action_required": true,
      "action_type": "reply_result",
      "must_reply": true,
      "timeout_min": 30
    }
  ],
  "ack_summary": {"count": 1, "waiting_for": ["B002"], "details": [{"task_id":"A001_20260425140000_f3a2","to":"B002","elapsed_min":5,"timeout_min":60}]},
  "result_summary": {"count": 0},
  "my_acked_summary": {"count": 1, "tasks": [{"task_id":"A001_20260425140000_f3a2","from":"A001","action":"execute_skill","elapsed_min":3,"timeout_min":120}]},
  "discuss_summary": {
    "count": 1,
    "threads": [{"thread_id":"...","topic":"报税方案","round":2,"max_rounds":5,"waiting":["B002"],"waiting_for_me":true}]
  },
  "offline_lobsters": [],
  "poll_notifications": [],
  "errors": []
}
```

### 7. 查看通信状态

```bash
node scripts/lobster-comm.js status
```

显示：当前龙虾ID、工作模式、待ACK列表、待RESULT列表、团队列表（含角色、状态、部署位置）、离线龙虾、过期任务、最近消息等。

### 8. 宣告存在

```bash
# setup完成后自动执行，也可手动触发
node scripts/lobster-comm.js hello
```

向共享邮箱发送HELLO消息（目标=ALL），其他龙虾轮询时将自动发现你并加入团队列表。HELLO包含部署信息（hostname、platform、username），方便中枢识别。

### 9. 移除龙虾

```bash
# 从团队列表中移除已退役的龙虾
node scripts/lobster-comm.js forget 龙虾B
```

移除指定龙虾，同时：发送GOODBYE通知、清理相关的pending任务、清除离线状态。适用于龙虾被用户删除、不再使用的场景。

### 10. 清理过期邮件

```bash
node scripts/lobster-comm.js cleanup
```

手动触发邮件清理（poll时也会自动轻量清理）。

### 11. 测试连接

```bash
node scripts/lobster-comm.js test-conn
```

测试IMAP和SMTP连接是否正常。

---

## 🔄 完整工作流程

### 中枢龙虾（如A001）发出指令

```
用户："让B002去执行auto-invoice，处理XQ202604003"

龙虾A001应该：
1. 解析用户意图：目标=B002，动作=execute_skill，参数=auto-invoice
2. 执行 send CMD 命令
3. 告知用户："✉️ 已发送指令到 B002，任务ID: A001_20260425140000_f3a2"
4. 等待轮询时检查ACK
```

### v3 时间判定 — 等待ACK

```
发CMD → 等待ACK
│
├─ 每5分钟轮询：无ACK → 继续等待（用status命令查看进度）
├─ ack_timeout_min（默认60分钟）后仍无ACK → 发EXPIRED → 判定离线 → 指令作废
│
└─ 收到ACK → pending_ack移到pending_result → 通知用户"已确认接收"
```

### v3 时间判定 — 等待RESULT

```
收到ACK → 等待RESULT
│
├─ 轮询：无RESULT → 继续等待（用status命令查看进度）
├─ result_timeout_min（默认120分钟）后仍无RESULT → 通知用户"任务执行超时"
│
└─ 收到RESULT → 通知用户结果
```

### 中枢龙虾收到ACK

```
轮询发现ACK：
1. 将pending_ack移到pending_result
2. 通知用户："✅ B002 已确认接收，预计15分钟内完成"
```

### 中枢龙虾收到RESULT

```
轮询发现RESULT：
1. 通知用户："✅ B002 执行完毕：发票已开具完成，发票号12345678"
2. 从pending_result中移除该任务
```

### 执行者龙虾（如B002）收到CMD

```
轮询发现CMD：
1. 检查白名单：from是否在信任列表中
2. 检查超时：是否已超过timeout_min
3. 检查过期：task_id是否在expired_task_ids黑名单中
4. 自动回复ACK（poll内置，不依赖Agent手动调用send）
5. 记录到my_acked_tasks（跟踪"我ACK了但还没发RESULT"的任务）
6. 通知Agent执行任务
7. Agent执行完毕后发送RESULT或ERROR → 从my_acked_tasks移除
```

> **⚠️ 铁律：ACK是执行前确认（poll自动发），RESULT/ERROR是执行后反馈（Agent必须手动发）！严禁不回复！** 两阶段不能搞混：
> - **ACK（执行前）**：poll收到CMD后自动回复，确认"收到了"，无需Agent操心
> - **RESULT/ERROR（执行后）**：Agent执行任务完毕后，**严禁不回复**RESULT或ERROR，不回复=协议违规，会导致任务链路中断卡死
> 
> "执行完毕"包括一切执行结果——正常完成发RESULT，执行中发现问题也发ERROR，这都是执行结果，严禁卡住不发：
> - body中无content/description → ERROR："body中无任务内容，请补充后重新派活"（严禁不回！）
> - 不理解指令含义 → ERROR："无法理解action=xxx的含义，请详细说明"（严禁不回！）
> - 执行过程中出错 → ERROR："执行失败：具体原因"（严禁不回！）
> - 任何情况下都不允许收到CMD后不回复RESULT/ERROR
> 
> poll输出的AUTO_ACK_SENT通知中 `protocol_rule: 'STRICT_MUST_REPLY'` 表示严禁不回复。120分钟内不发，系统会自动发ERROR RESULT强制关闭链路。

> **重要：** v3双重强制机制 — ① 收到CMD自动ACK（确保CMD→ACK链路不断）；② ACK后超过`result_timeout_min`（默认120分钟）未发RESULT→自动发ERROR RESULT关闭链路（确保ACK→RESULT链路不断）。Agent只需关注执行任务并发RESULT，忘记发RESULT时系统自动兜底。progress_query类型的CMD静默ACK，不打扰用户。

### v3 执行者侧 — 强制RESULT机制（时间判定）

```
收到CMD → auto-ACK → 记录my_acked_tasks → 通知Agent执行
│
├─ Agent正常发RESULT/ERROR → 从my_acked_tasks移除 → 链路正常关闭
│
└─ Agent未发RESULT（时间倒计时）
   ├─ 未超时：继续等待（用status命令查看进度）
   └─ result_timeout_min（默认120分钟）后仍未发RESULT → 自动发ERROR RESULT → 从my_acked_tasks移除 → 链路强制关闭
      （ERROR中标记auto_generated=true，CMD发送方可识别是超时自动关闭）
```

### 执行者龙虾收到EXPIRED通知

```
轮询发现EXPIRED：
1. 提取 reply_to_task_id（原CMD的task_id）
2. 加入过期黑名单 expired_task_ids
3. 后续收到原CMD → 命中黑名单 → 跳过不执行
4. EXPIRED不需要回复ACK/RESULT（单向通知）
```

### 新龙虾部署 → HELLO宣告

```
新龙虾setup完成 → 自动发送HELLO（目标=ALL）
     ↓
其他龙虾轮询看到HELLO → 加入known_lobsters（含host/platform/user） → 移到LOBSTER_DONE
     ↓
中枢status展示新龙虾部署位置
```

### 龙虾退役 → forget移除

```
用户确认某龙虾不再使用：
1. 中枢运行 forget <龙虾ID>
2. 发送GOODBYE通知给对方
3. 从known_lobsters移除
4. 清理相关的pending_acks/pending_results
5. 清除离线状态
```

---

## 🛡️ 安全机制

- **HMAC-SHA256签名**：所有邮件都带签名，防伪造防篡改
- **信任白名单**：只接收白名单内龙虾ID的指令
- **互回复防死循环**：max_auto_reply_rounds 限制自动回复轮次
- **超时作废**：过期任务自动忽略
- **自发自检测**：to===from 时拒绝发送，避免空转（HELLO的to=ALL不受此限制）
- **邮件大小预检**：超过max_mail_size_kb的邮件直接跳过
- **过期黑名单**：EXPIRED通知确保离线龙虾不会误执行旧指令
- **HELLO/GOODBYE**：HELLO一发即忘不需回复，GOODBYE单向通知

---

## ⚡ v3 性能优化（含v2继承）

| 优化项 | 说明 | 收益 |
|--------|------|------|
| 时间判定超时 | ack_timeout_min/result_timeout_min/discuss_timeout_min独立配置，与轮询间隔解耦 | 不同轮询频率的龙虾超时行为一致 |
| 精简通知 | 删掉ACK_WAITING/MY_ACKED_REMIND/RESULT_WAITING等中间状态通知 | poll输出更干净，省token |
| CMD自动ACK | poll收到CMD自动回复ACK，不依赖Agent自觉 | 通信链路不因Agent不ACK而断裂 |
| 强制RESULT | ACK后超过result_timeout_min（默认120分钟）未发RESULT→自动发ERROR RESULT关闭链路 | 通信链路不因Agent不发RESULT而断裂 |
| DISCUSS防呆 | poll输出DISCUSS消息时body注入结构化状态+content加系统前缀 | Agent不会靠自然语言猜讨论状态 |
| 强制讨论回复 | 参与方超过discuss_timeout_min（默认120分钟）未回复→标记轮次超时；发起方超时未总结→自动推进轮次 | 讨论不会因任何一方不行动而卡死 |
| 单阶段fetch | 一次性取envelope+source，内存中过滤 | 163 IMAP两阶段fetch丢数据（UID-based二次fetch返回空） |
| CMD自动移出INBOX | poll时自动将已处理CMD移到LOBSTER_DONE | INBOX持续瘦身，poll越来越快 |
| 增量poll | 用last_poll_time替代7天硬编码 | 正常情况每次只扫描几分钟内邮件 |
| compact输出 | `--compact` 极简JSON | AI处理时省60%+ token |
| 批量state读写 | poll期间操作走内存，结束时写一次 | 磁盘I/O从O(N)降到1次 |
| 原子写入 | 先写临时文件再rename | 防写一半断电导致state.json损坏 |
| 非[LOBSTER]标记已读 | 163广告邮件等标记Seen | 下次poll不再拉取 |
| 轻量cleanup | LOBSTER_DONE>50封时自动删除最旧的 | 无需手动清理，邮箱不会爆 |
| CLIXML防御 | 三道防线：①消灭所有console.error改文件日志 ②拦截未捕获异常到stdout ③Agent侧剥离CLIXML取纯JSON | PowerShell下JSON输出不被CLIXML污染，所有Windows龙虾通用 |
| 强制base64编码发送 | nodemailer发送时`textEncoding:'base64'`，避免163选quoted-printable | simpleParser对qp编码的中文解码有bug（损坏非ASCII字符），强制base64规避此问题 |
| html降级解析 | poll解析邮件时text/plain失败→降级从html提取JSON（去除HTML标签） | 163有时把text/plain部分留空、JSON只在html中；qp编码中文损坏时html可能正常 |

## 👥 团队发现机制

- **观察式发现**：无需龙虾主动注册，poll时自动识别其他龙虾
- **所有龙虾可见**：干活龙虾也能看团队列表，知道谁是中枢
- **角色识别**：通过消息中的 `sender_role` 字段（hub=中枢，worker=干活）
- **零额外邮件**：不增加额外通信，复用现有消息流

**status命令团队展示示例：**
```
  👥 团队成员 (2):
     ┌──────────────────┬────────┬─────────┬──────────┐
     │ ID               │ 角色   │ 状态    │ 最后活跃  │
     ├──────────────────┼────────┼─────────┼──────────┤
     │ 龙虾B            │ 🔧 干活 │ 🟢 在线 │ 5分钟前   │
     │ 中枢             │ 🧠 中枢 │ 🟢 在线 │ 刚刚      │
     └──────────────────┴────────┴─────────┴──────────┘
```

---

## 📁 文件结构

```
~/.workbuddy/skills/lobster-comm/
├── SKILL.md                  # 本文件
├── package.json              # 依赖定义
├── scripts/
│   ├── lobster-comm.js       # 主入口（CLI命令）
│   └── lib/
│       ├── config.js         # 配置管理（含批量读写、原子写入、时间判定超时、my_acked_tasks跟踪）
│       ├── protocol.js       # LobsterMail协议（解析/构造/签名/EXPIRED）
│       └── mail-client.js    # IMAP/SMTP封装（单阶段fetch、强制base64编码、html降级解析）
├── references/
│   └── lobster-mail-protocol-v1.md  # 协议详细规范

配置文件位置：~/.config/lobster-comm/config.json
状态文件位置：~/.config/lobster-comm/state.json
```

---

## 🐛 常见问题

| 问题 | 解决方案 |
|------|----------|
| IMAP连接超时 | 检查网络，确认163邮箱IMAP已开启 |
| SMTP发送失败 | 确认使用授权码而非登录密码 |
| 签名验证失败 | 检查所有龙虾的通信密钥是否一致 |
| 收不到邮件 | 检查轮询间隔，确认龙虾ID在白名单中 |
| 邮箱空间不足 | 运行 cleanup 命令清理过期邮件 |
| poll返回Connection not available | 163邮箱IMAP在fetch迭代中执行写操作会断开连接，v2已分离读写操作 |
| 提示"不能发指令给自己" | to和from不能相同，检查命令参数 |
| 收到EXPIRED通知后原CMD仍执行 | EXPIRED将原task_id加入黑名单，下次poll时CMD会被跳过 |
| INBOX中[LOBSTER]邮件积压 | v2自动移出CMD到LOBSTER_DONE，如仍有积压检查poll是否正常运行 |
| 3次轮询后指令作废 | v3时间判定：ack_timeout_min（默认60分钟）无ACK则判定离线。超时时间可在config中调整，与轮询间隔无关 |
| 新龙虾部署后不被发现 | setup自动发HELLO，也可手动运行hello命令重新宣告 |
| send --type ACK --reply-to仍提示必须指定 | v3已修复：reply-to自动复用为task-id，无需再传--task-id |
| 同task_id的ACK和RESULT只收到一个 | v3已修复：processed_task_ids改为`task_id::type`组合去重，ACK和RESULT不再互斥 |
| params解析后变成{raw:"..."} | v3已修复：send端params统一JSON.parse后再放入body；接收端防护性解析字符串params |
| poll信息太多Agent容易漏 | 使用`poll --action-only`只输出需要本龙虾行动的事项；标准输出中action_required=true标记需要行动的消息 |
| 收到CMD不ACK导致通信链路断裂 | v3已修复：poll自动ACK，收到CMD即确认，不依赖Agent手动调用send。Agent只需执行任务并发RESULT |
| 收到CMD但body为空/缺少关键信息 | 必须回复ERROR说明缺少什么，不能卡住不回。如：`send --type ERROR --to 发送方 --reply-to 任务ID --content "收到CMD但无任务内容，请补充后重新派活"` |
| CMD的--content参数没传到body | v3已修复：所有类型都支持`--content`参数，CMD类型`--content`会写入body.content字段 |
| ACK后不发RESULT导致链路断裂 | v3已修复：ACK后超过result_timeout_min（默认120分钟）未发RESULT→自动发ERROR RESULT关闭链路（my_acked_tasks跟踪）。超时时间可在config中调整 |
| Agent靠content文字猜讨论状态导致误判 | v3已修复：DISCUSS消息body注入max_rounds/waiting_for_me/discuss_status/must_reply结构化字段；发起方content前加`[第X轮/共Y轮 | 📝请总结并推进下一轮]`，参与方content前加`[第X轮/共Y轮 | ⚡必须回复/⏳已回复等待他人]`系统前缀。Agent应优先看结构化字段，不靠content猜状态 |
| Agent收到讨论不回复导致讨论卡死 | v3已修复：参与方超过discuss_timeout_min（默认120分钟）未回复→标记轮次超时（PARTICIPANT_ROUND_TIMEOUT通知发起方）；发起方超时未总结→自动推进轮次。讨论不会因任何一方不行动而卡死 |
| 发起方被当成辩手导致讨论卡住 | v3已修复：发起方=主持人，不需要每轮回复，只做总结+推进轮次。`checkRoundComplete`只检查非发起方参与方。发起方`discuss --thread`=总结并推进，参与方`discuss --thread`=回复讨论 |
| 旧龙虾退役后仍在列表 | 运行 `forget <龙虾ID>` 移除 |
| 多个中枢共存 | 支持。消息靠to字段路由，pending状态各自维护，互不干扰 |
| PowerShell下poll输出被CLIXML污染导致JSON.parse失败 | v3已修复：①脚本内部消灭所有stderr输出（console.error改文件日志） ②拦截未捕获异常到stdout ③Agent收到输出后取第一个`{`到最后一个`}`之间的纯JSON再parse。这是PowerShell注入到stdout的，无法在node内部清除 |
| 邮件正文被163编码为base64/qp后解析失败 | v3已修复：①发送端强制`textEncoding:'base64'`避免163选qp编码（simpleParser对qp中文解码损坏）②接收端text/plain解析失败时降级从html提取JSON（去除HTML标签后解析） |
| 邮件被source fetch标记为已读后解析失败，下次poll跳过 | v3已修复：imapflow的`source:true`底层用BODY[]（非BODY.PEEK[]），fetch时自动标记\Seen。poll循环结束后，对处理失败的邮件调用`messageFlagsRemove`恢复\Seen标志，确保下次poll重新拉取 |
| to字段逗号分隔导致收件人匹配失败 | v3已修复：发起讨论/推进轮次时to=participants.join(',')，如"中枢,龙虾B"。poll判断`subjectInfo.to !== myId`永远不匹配→邮件被跳过。改为split(',')后includes判断 |
| calcSinceDate解析失败导致since过滤异常 | v3已修复：last_poll_time为ISO字符串，`new Date(lastPoll)`可能返回Invalid Date（格式损坏时）。增加isNaN检查，失败时回退7天前；同时从lastPoll往前回退5分钟覆盖SMTP投递延迟 |
| commitBatch失败导致processed_task_ids丢失 | v3已修复：`commitBatch()`中`saveState()`失败时不丢弃`_inMemoryState`，保留`_stateDirty=true`以便下次重试；非批量模式下`saveState()`写入前merge磁盘state的`processed_task_ids`和`expired_task_ids`，防止跨进程覆盖 |
| 收到DISCUSS消息但本地找不到线程 | v3已修复：参与方收到DISCUSS消息但`active_threads`中没有对应线程（state丢失或线程ID不匹配）时，自动从消息内容创建线程+同步轮次+发出`DISCUSS_THREAD_RECOVERED`警告。不再静默忽略 |

## ⚠️ 163邮箱已知限制

1. **IMAP SEARCH subject不可靠**：`search({subject:'LOBSTER'})`可能返回空结果，改为搜索全部未读后本地过滤
2. **fetch迭代中不能执行IMAP写操作**：在`for await`遍历fetch结果时，执行`messageFlagsAdd`或`messageMove`会导致连接断开。v3采用单阶段fetch+批量模式：一次性取envelope+source，内存中过滤解析，最后集中写操作
3. **IMAP连接限频**：短时间内多次连接可能被163限制，poll之间至少间隔5分钟
4. **IMAP UID不连续**：163的UID是大数字（如1777092561），不是从1开始
5. **163广告注入**：163可能在邮件正文尾部追加广告文本，v2的parseBody严格匹配第一个{到最后一个}之间的JSON
6. **163 IMAP UID-based fetch不可靠**：用UID列表做`fetch([uid1,uid2], {source})`可能返回空结果。v3改为条件fetch（`{unseen:true,since:...}`）一次取envelope+source
7. **163 SMTP自动编码邮件体**：163根据内容长度/字符自动选择Content-Transfer-Encoding（base64/quoted-printable）。simpleParser对quoted-printable编码的中文解码有bug（非ASCII字符损坏→JSON.parse失败）。v3修复：①发送端强制base64编码（`textEncoding:'base64'`）②接收端增加html降级解析
8. **imapflow source: true自动标记\Seen**：`source: true`底层用`BODY[]`（非`BODY.PEEK[]`），fetch时自动将邮件标记为已读。如果邮件解析失败，下次poll的`{unseen:true}`过滤器会跳过。v3修复：fetch循环结束后对处理失败的邮件恢复`\Seen`标志
9. **163 SMTP投递延迟**：SMTP发送成功后，IMAP可读有几秒到几十秒延迟。v3修复：calcSinceDate从lastPoll往前回退5分钟，覆盖投递延迟
10. **state.json跨进程覆盖**：快速连续执行两个命令（如poll+discuss），前一个saveState可能被后一个覆盖（非批量模式下每个修改函数都load→modify→save）。v3修复：非批量模式saveState写入前merge磁盘state的processed_task_ids和expired_task_ids

---

## ⚠️ 注意事项

1. 163邮箱IMAP连接限频，轮询间隔最低5分钟
2. 邮件传输有秒级到分钟级延迟，不适合秒级实时场景
3. 授权码是邮箱登录的唯一凭证，切勿泄露
4. 所有龙虾的通信密钥必须一致，否则签名验证失败
5. 邮件正文大小上限100KB，大文件应通过其他方式传输
6. EXPIRED通知是单向的，不需要回复ACK/RESULT
7. 发送指令时to不能等于from（自发自检测）
8. **Windows PowerShell中文编码陷阱**：PowerShell传含中文的JSON字符串给node.exe时，中文会被编码损坏。discuss的 `--roles` 必须用简写格式（`龙二:challenger`），不能用JSON格式（`'{"龙二":"challenger"}'`）
9. **Windows PowerShell CLIXML陷阱**：PowerShell执行外部命令时，会在stdout前后注入CLIXML包裹（`#< CLIXML<Objs...>...</Objs>`），污染JSON.parse。v3已从脚本内部消灭所有stderr输出（防线1+2），但PowerShell注入到stdout的CLIXML无法在node内部清除。**Agent在解析poll --json/--compact/--action-only输出时，必须先剥离CLIXML：去掉`#< CLIXML`开头和`</Objs>`结尾之间的所有内容，只保留纯JSON部分**。如需调试，设 `LOBSTER_DEBUG=1`，日志写入 `~/.config/lobster-comm/debug.log`
10. **发起方=主持人，不是辩手**：发起方不需要每轮回复讨论内容，只做总结和推进。所有参与方回复完毕后，发起方使用`discuss --thread <id> --content "总结内容"`总结并推进下一轮。发起方超时未总结则自动推进
11. **多行内容安全通道**：Shell（PowerShell/bash）无法可靠传递含换行符的命令行参数，多行content会被截断。**三种方式传递多行内容**（按推荐优先级）：
    - **方式1（最可靠）**：`--content-file <文件路径>` — Agent先将内容写入临时文件，再用此参数传递文件路径
    - **方式2（单行转义）**：`--content "第一行\\n第二行\\n第三行"` — 用`\\n`表示换行，脚本自动转义为真实换行符
    - **方式3（单行内容）**：`--content "简短内容"` — 单行内容直接传，无需转义
    - **⚠️ 绝对不要在命令行中直接写多行文本**，shell会截断导致内容丢失
