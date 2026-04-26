# LobsterMail 协议规范 v1.1

> 龙虾（OpenClaw）跨平台通信协议，基于共享163邮箱

---

## 1. 概述

LobsterMail 协议通过共享邮箱实现多个 OpenClaw 实例之间的指令调度与结果回传。每只龙虾既是消息的生产者也是消费者。

### 核心设计原则

- **邮箱 = 消息队列**：共享163邮箱作为消息中转站
- **邮件主题 = 路由信息**：从主题即可判断消息类型、来源、目标
- **邮件正文 = JSON负载**：结构化、可解析、可签名
- **ACK确认机制**：确保指令投递可靠性
- **EXPIRED过期通知**：超时任务通知对方不再执行
- **HMAC签名**：防伪造、防篡改
- **两阶段fetch**：先取envelope过滤，再按需取source，省流量

---

## 2. 邮件主题格式

```
[LOBSTER] <TYPE>:<FROM>→<TO> | <TASK_ID> | <PRIORITY>
```

### 字段说明

| 字段 | 必填 | 说明 | 示例 |
|------|------|------|------|
| TYPE | 是 | 消息类型 | CMD / ACK / RESULT / ERROR / EXPIRED |
| FROM | 是 | 发送方龙虾ID | A001 |
| TO | 是 | 接收方龙虾ID，广播用 ALL | B002 |
| TASK_ID | 是 | 全局唯一任务ID | A001_20260425140000_f3a2 |
| PRIORITY | 是 | 优先级 | HIGH / NORMAL / LOW |

### 主题示例

```
[LOBSTER] CMD:A001→B002 | A001_20260425140000_f3a2 | HIGH
[LOBSTER] ACK:B002→A001 | A001_20260425140000_f3a2 | NORMAL
[LOBSTER] RESULT:B002→A001 | A001_20260425140000_f3a2 | NORMAL
[LOBSTER] ERROR:B002→A001 | A001_20260425140000_f3a2 | NORMAL
[LOBSTER] EXPIRED:A001→B002 | A001_20260425153000_e5f6 | NORMAL
[LOBSTER] CMD:A001→ALL | A001_20260425150000_c4d5 | LOW
```

---

## 3. 邮件正文格式

邮件正文为 JSON 格式，编码为 UTF-8。

### 完整结构

```json
{
  "protocol": "lobster-mail-v1",
  "from": "A001",
  "to": "B002",
  "task_id": "A001_20260425140000_f3a2",
  "type": "CMD",
  "priority": "HIGH",
  "timestamp": "2026-04-25T14:00:00+08:00",
  "body": {},
  "timeout_min": 30,
  "reply_to_task_id": null,
  "retry_count": 0,
  "sender_role": "hub",
  "signature": "a1b2c3d4..."
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| protocol | string | 是 | 固定值 `lobster-mail-v1` |
| from | string | 是 | 发送方龙虾ID |
| to | string | 是 | 接收方龙虾ID，广播填 `ALL` |
| task_id | string | 是 | 全局唯一任务ID |
| type | string | 是 | CMD / ACK / RESULT / ERROR / EXPIRED |
| priority | string | 是 | HIGH / NORMAL / LOW |
| timestamp | string | 是 | ISO 8601格式，含时区 |
| body | object | 是 | 消息负载，结构由type决定 |
| timeout_min | number | 是 | 任务超时时间（分钟） |
| reply_to_task_id | string\|null | 是 | 回复的原任务ID，首次发指令填null |
| retry_count | number | 是 | 重试次数，首次为0 |
| sender_role | string\|null | 否 | 发送方角色: `hub`（中枢） / `worker`（干活），用于团队发现 |
| signature | string | 是 | HMAC-SHA256签名 |

---

## 4. 消息类型

### 4.1 CMD — 下发指令

中枢龙虾向执行者龙虾下发任务指令。

```json
{
  "type": "CMD",
  "body": {
    "action": "execute_skill",
    "params": {},
    "description": "人类可读的任务描述"
  }
}
```

body 字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| action | string | 是 | 动作标识 |
| params | object | 否 | 动作参数 |
| description | string | 否 | 人类可读的任务描述 |

### 4.2 ACK — 确认收到

执行者龙虾确认收到CMD指令。

```json
{
  "type": "ACK",
  "reply_to_task_id": "A001_20260425140000_f3a2",
  "body": {
    "status": "received",
    "estimated_min": 15,
    "message": "已收到指令，预计15分钟内完成"
  }
}
```

body 字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | string | 是 | 固定值 `received` |
| estimated_min | number | 否 | 预计完成时间（分钟） |
| message | string | 否 | 人类可读的确认消息 |

### 4.3 RESULT — 返回结果

执行者龙虾返回任务执行结果。

```json
{
  "type": "RESULT",
  "reply_to_task_id": "A001_20260425140000_f3a2",
  "body": {
    "status": "success",
    "summary": "任务完成摘要",
    "data": {},
    "attachments_info": []
  }
}
```

body 字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | string | 是 | success / partial |
| summary | string | 是 | 执行结果摘要 |
| data | object | 否 | 结构化结果数据 |
| attachments_info | string[] | 否 | 附件信息列表 |

### 4.4 ERROR — 执行异常

执行者龙虾报告任务执行失败。

```json
{
  "type": "ERROR",
  "reply_to_task_id": "A001_20260425140000_f3a2",
  "body": {
    "status": "failed",
    "error_code": "SKILL_EXEC_ERROR",
    "message": "错误详情描述",
    "retryable": true
  }
}
```

body 字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | string | 是 | 固定值 `failed` |
| error_code | string | 否 | 错误码 |
| message | string | 是 | 错误详情 |
| retryable | boolean | 是 | 是否可重试 |

### 4.5 EXPIRED — 任务过时通知（v1.1新增）

中枢龙虾在ACK超时3次后，向执行者龙虾发送过期通知。执行者龙虾恢复上线后收到此通知，应放弃执行原CMD。

```json
{
  "type": "EXPIRED",
  "task_id": "A001_20260425153000_e5f6",
  "reply_to_task_id": "A001_20260425140000_f3a2",
  "body": {
    "reason": "ack_timeout",
    "retry_count": 3,
    "message": "连续3次未响应ACK，任务已过时"
  }
}
```

body 字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| reason | string | 是 | 过期原因：`ack_timeout` |
| retry_count | number | 是 | ACK重试次数 |
| message | string | 否 | 人类可读的过期说明 |

**EXPIRED消息特性：**
- `reply_to_task_id` 指向原CMD的task_id
- `task_id` 是EXPIRED消息本身的ID（新生成）
- 不需要回复ACK/RESULT（单向通知）
- 执行者收到后，将原CMD的task_id加入过期黑名单

---

## 5. 签名机制

### 算法

HMAC-SHA256

### 签名内容

```
sign_content = from + to + task_id + type + timestamp + JSON.stringify(body)
```

### 签名生成

```
signature = HMAC-SHA256(sign_content, shared_secret)
```

### 签名验证

1. 收到邮件后，用本地存储的 shared_secret 重新计算签名
2. 使用时间安全比较（timingSafeEqual）比对签名
3. 不匹配 → 丢弃邮件 + 记录告警

---

## 6. 任务ID生成规则

```
格式：<龙虾ID>_<YYYYMMDDHHmmss>_<4位随机hex>
示例：A001_20260425140000_f3a2
```

- 龙虾ID前缀：天然区分不同龙虾
- 时间戳精确到秒：同一龙虾不会冲突
- 4位随机hex：极端并发场景兜底

---

## 7. 通信流程

### 7.1 标准流程

```
A001 发 CMD → B002 收 CMD → B002 发 ACK → B002 执行 → B002 发 RESULT → A001 收 RESULT
```

### 7.2 ACK超时 → 重发 → 判定离线 → 发EXPIRED（v1.1改进）

```
A001 发 CMD → 等待ACK → 超时 → retry_count+1 → 重发CMD
                                     │
                            retry_count >= 3?
                            ├── 是 → 判定B002离线
                            │        → 发 EXPIRED 给B002
                            │        → 标记B002离线状态
                            └── 否 → 继续等待

B002恢复上线 → poll发现EXPIRED(reply_to_task_id=X)
            → 将task_id=X加入过期黑名单
            → 后续收到原CMD(task_id=X) → 命中黑名单，跳过不执行
```

### 7.3 执行失败重试

```
A001 收 ERROR → retryable=true 且 retry_count < 3 → 重发CMD
```

---

## 8. 邮件生命周期

| 阶段 | IMAP操作 | 说明 |
|------|----------|------|
| 收到新邮件（Phase1匹配） | Phase2取source | 两阶段fetch，非LOBSTER邮件只标记已读 |
| 有效CMD处理完成 | 移动到 `LOBSTER_DONE` | v2：poll自动移出INBOX |
| CMD命中过期黑名单 | 移动到 `LOBSTER_ERROR` | 被EXPIRED标记的过期CMD |
| RESULT/ERROR/EXPIRED读取后 | 移动到 `LOBSTER_DONE` | 归档 |
| 非[LOBSTER]未读邮件 | 标记 `\Seen` | 避免每次poll重复拉取 |

### 清理策略

| 类别 | 保留时间 | 清理方式 |
|------|----------|----------|
| LOBSTER_DONE | 24小时 | 自动删除（poll轻量cleanup或手动cleanup） |
| LOBSTER_ERROR | 7天 | 手动cleanup删除 |
| LOBSTER_DONE超过50封 | 超出部分 | poll末尾自动删除最旧的 |

---

## 9. 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| email.account | string | - | 共享163邮箱账号 |
| email.auth_code | string | - | 163邮箱授权码 |
| email.imap_host | string | imap.163.com | IMAP服务器 |
| email.imap_port | number | 993 | IMAP端口 |
| email.smtp_host | string | smtp.163.com | SMTP服务器 |
| email.smtp_port | number | 465 | SMTP端口 |
| identity.id | string | - | 本龙虾唯一标识 |
| identity.work_mode | string | full | receive_only/interactive/full |
| identity.can_initiate | boolean | true | 是否可主动发指令 |
| polling.interval_min | number | 10 | 轮询间隔 |
| polling.task_timeout_min | number | 30 | 任务超时 |
| polling.ack_timeout_min | number | 10 | ACK超时 |
| interaction.max_auto_reply_rounds | number | 3 | 最大自动回复轮次 |
| interaction.trust_whitelist | string[] | [] | 信任白名单 |
| cleanup.done_retention_hours | number | 24 | 已处理保留时间 |
| cleanup.error_retention_hours | number | 168 | 异常保留时间 |
| security.shared_secret | string | - | 通信密钥 |
| protocol.max_mail_size_kb | number | 1024 | 邮件大小上限（超过跳过） |
| protocol.max_result_size_kb | number | 100 | 结果正文大小上限 |
| protocol.max_retry_count | number | 3 | 最大ACK重试次数 |

---

## 10. state.json 字段说明（v1.1新增）

| 字段 | 类型 | 说明 |
|------|------|------|
| pending_acks | array | 等待ACK的CMD列表 |
| processed_task_ids | array | 已处理的任务ID（上限100） |
| expired_task_ids | array | 被EXPIRED标记的过期任务ID（上限100） |
| offline_lobsters | object | 离线龙虾记录 { id: { since, failed_tasks } } |
| known_lobsters | object | 已知龙虾记录 { id: { first_seen, last_active, role, status } }（上限50） |
| last_poll_time | string\|null | 上次成功poll的ISO时间，用于增量poll |
| reply_chain_depth | object | 任务链回复深度追踪 |

---

## 12. 团队发现机制（v1.1新增）

### 设计原则

- **观察式发现**：无需龙虾主动注册，poll时自动识别
- **所有龙虾可见**：干活龙虾也能看团队列表，知道谁是中枢
- **零额外邮件**：通过消息中的 `sender_role` 字段传递角色信息

### 角色识别

| 场景 | 识别方式 |
|------|----------|
| 消息包含 sender_role 字段 | 直接使用（最准确） |
| 消息类型为 CMD/EXPIRED 且无 sender_role | 推断为 hub（中枢） |
| 消息类型为 ACK/RESULT/ERROR 且无 sender_role | 推断为 worker（干活） |

### known_lobsters 更新时机

| 时机 | 动作 |
|------|------|
| poll收到任何[LOBSTER]邮件 | 新龙虾→记录first_seen，已有→更新last_active |
| 收到ACK/RESULT | 标记发送方 online |
| ACK超时3次判定离线 | 标记 offline |
| 收到EXPIRED | 标记发送方 online（能发EXPIRED说明在线） |

### 角色升级规则

- worker 一旦被识别为 hub，不会降级回 worker
- 中枢龙虾可以发CMD也可以回复ACK/RESULT，但角色始终是 hub

---

## 11. 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.1 | 2026-04-25 | 新增EXPIRED消息类型；两阶段fetch；CMD自动移出INBOX；增量poll；compact输出；自发自检测；离线龙虾追踪；团队发现机制；sender_role字段 |
| v1 | 2026-04-25 | 初始版本 |
