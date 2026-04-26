# 🦞 龙虾跨平台通信

> 让不同电脑上的 openclaw（龙虾）互发消息、分工协作。
> 靠163邮箱中转，不需要服务器，天然适配所有形态的龙虾（本地 / 沙盒 / 封闭云服务器 / 魔改阉割版）。
>
> **独有优势：**
>
> **1. 零部署、零服务器成本**
> - 不用买云服务器、不用搭 EMQX、不用维护中枢服务
> - 直接用现成 163 邮箱，开箱即用
>
> **2. 极端封闭环境全能穿透**
> - Minimax 封闭云、workbuddy 魔改、企业沙盒、内网隔离机
> - 只要能上网发收邮件就能通
> - 几乎没有任何防火墙会封 SMTP/IMAP/POP3
> - 不用长连接、不用端口映射、不用内网穿透
>
> **3. 天然离线消息、持久化、永不丢消息**
> - 龙虾离线关机，邮件一直在邮箱服务器
> - 上线自动拉取，天然消息队列、天然持久化
> - 比你自己搭 MQTT 还要稳的离线保活

---

## 两种通信模式

一只龙虾当「中枢」，通过163邮箱指挥其他龙虾。两种模式，覆盖所有协作场景：

### 📋 指令式 —— 派活、等结果

```
中枢 ──CMD──→ 龙虾：去干这个活
     ←──ACK─── 龙虾：收到了！
     ←──RESULT─ 龙虾：干完了，结果在这
                  └ 或 ←──ERROR─── 龙虾：出错了

超时保护（不用你管，系统自动处理）：
  60分钟没ACK  → 对方离线，自动通知你
  120分钟没RESULT → 自动关链路，不会卡死
```

### 💬 讨论式 —— 多轮辩论、出结论

```
中枢 ──DISCUSS──→ 龙二(找茬者)、龙三(搜索者)：讨论这个话题
  龙二 ──DISCUSS──→ 全员：按角色发言
  龙三 ──DISCUSS──→ 全员：按角色发言
中枢 ──DISCUSS──→ 全员：总结本轮，推进下一轮
  ┊（重复N轮）
中枢 ──CONCLUDE─→ 全员：最终结论

超时保护：
  120分钟没人回复 → 自动标记轮次超时，推进下一轮
  讨论不会因任何一方不行动而卡死
```

**讨论角色：**

| 角色 | 思维方式 |
|------|----------|
| 找茬者 challenger | 专门挑毛病、找漏洞 |
| 搜索者 researcher | 必须搜索网络找证据 |
| 细节控 detailer | 纠细节、算数字 |
| 发散者 divergent | 天马行空、提可能性 |
| 务实者 pragmatist | 只关心能不能落地 |
| 归纳者 summarizer | 梳理各方观点、找共识 |

---

## 部署（3步）

**第一步：装依赖**
```bash
cd ~/.workbuddy/skills/lobster-comm
npm install --production
```

**第二步：配置**
```bash
node scripts/lobster-comm.js setup
```
回答向导问题：邮箱地址、授权码、通信密钥、本龙虾名字、工作模式

**第三步：验证**
```bash
node scripts/lobster-comm.js test-conn
node scripts/lobster-comm.js status
```

---

## 常用命令

**指令式：**
```bash
# 派活
node scripts/lobster-comm.js send --to "龙二" --action "开票" --description "给张三开票"

# 查收消息
node scripts/lobster-comm.js poll

# 查看龙虾状态
node scripts/lobster-comm.js status
```

**讨论式：**
```bash
# 发起讨论
node scripts/lobster-comm.js discuss \
  --topic "选哪个方案" \
  --to "龙二,龙三" \
  --roles "龙二:challenger,龙三:researcher" \
  --max-rounds 5 \
  --content "方案A还是方案B，请从各自角度分析"

# 结束讨论（手动提前结束用）
node scripts/lobster-comm.js conclude --thread "线程ID" --conclusion "最终采用方案B"
```

- `--roles` 格式：`参与者:角色`，多个逗号分隔
- Windows 用户必须用简写格式（`龙二:challenger`），不能用 JSON 格式

---

## 常见问题

| 问题 | 怎么办 |
|------|--------|
| 发了活没回应 | 超过60分钟没回就说明对方离线了 |
| 活发出去了但对方说没收到 | 对方可能离线，检查 status 里的在线状态 |
| 新龙虾不被发现 | 运行 `hello` 命令重新宣告上线 |
| 旧龙虾还在列表里 | 运行 `forget 龙虾ID` 移除 |
| 收到活之后怎么做 | 干完执行任务，然后发 RESULT 或 ERROR 回报即可 |

---

## 注意

- **轮询间隔**不要太短，5分钟以上比较稳
- **邮件有延迟**，秒级实时不适合这个方案
- **通信密钥**所有龙虾必须一致
- **Windows 用户**：讨论角色用简写格式 `--roles "龙二:challenger"`，不要用JSON格式
