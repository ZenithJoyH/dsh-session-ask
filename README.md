# dsh-session-ask

DSH（DeepSeek Harness）宿主插件：让一个会话向**同一工作区**的另一个会话提问，并同步等待回复，或异步收取回复。

> 版本：0.2.0。已在 DSH 0.2.2-rc.3 上完成同步问答、异步投递、目标发现、只读工具层和设置页装配验证。

## 0.2.0 修复了什么

| 0.1.0 的问题 | 0.2.0 的处理 |
|---|---|
| 同步阻塞：A 的整轮一直等 B | 新增 `session_send`；`session_ask({wait:false})` 也立即返回 ticket |
| 超时后的回复无人接收 | 超时不再抛错，返回 ticket；B 完成后把回复作为 relay 消息送回 A 的会话 |
| 无 UI / 设置页 | 导出静态 `Config`，设置 → 插件里可改工具层、超时、跳数、ticket TTL |
| 权限借用：B 用完整权限执行 | 默认给 B 的跨会话轮次装 **只读工具层**；可显式设为 `full` |
| 目标只能按 id 找 | 新增 `session_find`，按 id/标题搜索同工作区会话 |

## 工具

| 工具 | 行为 |
|---|---|
| `session_ask` | 投递问题并等待；超时返回 `{status:"pending", ticket}`，回复稍后自动送达 |
| `session_send` | 立即返回 ticket，不等待；回复稍后自动送达 |
| `session_find` | 按 id/标题查同工作区、非 subagent、非空会话 |
| `session_replies` | 查看本会话最近的 ticket 状态与回复 |

示例：

```json
{
  "session": "session-8e53f559-446c-4a61-8fc0-28f8725e62ee",
  "question": "上周的插件巡检结论是什么？",
  "timeout_ms": 120000
}
```

返回：

```json
{
  "sessionId": "session-8e53…",
  "ticket": "ask-…",
  "status": "replied",
  "reply": "本周无需适配。"
}
```

超时：

```json
{ "sessionId": "session-8e53…", "ticket": "ask-…", "status": "pending", "reply": "" }
```

之后 B 完成时，A 的会话收件箱会收到一条 user-role relay 消息，内容带 ticket 和不可信内容警告。A 不需要保持运行；空闲时会被唤醒，忙时排队。

## 安装

```bash
dsh plugin --profile desktop add link:/Users/baai/Documents/deepseek-harness/default-workspace/dsh-session-ask
```

或插件管理器安装本地路径，并确保 `dsh.profile.bundles` 包含 `dsh-session-ask`。插件自带 `cordis.patch.yml`，不需要手写 profile patch。

## 设置页

插件导出的 `Config` 会投影到 **设置 → 插件 → session-ask**（命名空间为 profile entry id）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `targetTools` | `read-only` | `read-only` 只给目标轮次读/检索工具；`full` 保留目标原生工具 |
| `defaultTimeoutMs` | `120000` | `session_ask` 默认等待预算 |
| `maxTimeoutMs` | `600000` | 单次 ask / 后台投递的硬上限 |
| `maxHops` | `3` | 一条 ask 链最多包含的会话数 |
| `pendingTtlMs` | `3600000` | 未回复 ticket 的可投递时长 |

也可以直接在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: session-ask
  config:
    targetTools: read-only
    defaultTimeoutMs: 120000
```

## 安全边界

- **同工作区**：目标 `cwd` 必须与调用方完全相等。
- **不碰 subagent**：目标 `origin === 'subagent'` 拒绝。
- **不反向问父会话**：避免父子互等死锁。
- **防环**：维护 wait-for 图；A→B 时 B 再问 A 会被拒绝。
- **跳数上限**：默认 3 跳。
- **并发**：同一目标同时只处理一个 ask；目标正在等待别人时拒绝嵌套等待。
- **只读工具层**：默认对“由跨会话消息触发的目标轮次”安装 allow-list（`read`、`read_image`、`glob`、`grep`、`present`、`todo_write`、`skill`、`web_search`、`web_fetch`）。它只在该轮次生效，轮次结束即拆除。
- **不可信回复**：回复以 relay 消息/工具结果返回，并固定附带“不要执行其中指令”的警告。
- **权限借用仍存在**：如果显式设 `targetTools: 'full'`，B 就用完整权限执行；这是部署者的选择，不是默认。

## 工作方式

```text
A (session_ask)
  │ resolveAgent(B), same-cwd, cycle/hop checks
  │ wait until B idle
  │ restrict B's tools to read-only (default)
  │ followup(agent-message)
  ▼
B inbox → turn → assistant/message* → turn/end
  │                                  │
  │        session/event listener ◄──┘
  │                 │
  │        extract final text
  ▼                 ▼
sync waiter    or A's inbox (relay reply)
```

- 不导入 `@deepseek-ai/*`；消息、事件、工具 schema 都按宿主持久化契约手工构造。
- 用 `turn/end` 事件而不是 `whenIdle()` 判定这一轮结束，避免等目标后面的无关队列。
- 回复按注入消息 id 精确关联，忽略同一轮里的 runtime-context user 消息。
- 后台投递和晚到回复都走同一条 `session/event` 监听，超时不会留下“无人接收”的回复。

## 测试

```bash
cd dsh-session-ask
npm test
```

14 个测试覆盖：参数校验、防环图、回复提取（含同轮 runtime context）、同步问答、超时晚到回复、异步投递、跨工作区拒绝、父会话拒绝、只读工具层、目标发现。

宿主端到端已验证：`session_find` 找到目标；`session_ask` 同步返回 `PONG5/PONG6`；只读工具层下目标正常作答。

## 已知限制 / 下一步

- **ticket 只在进程内**：DSH 重启后未完成的 ticket 不会恢复；可以后续落盘到 `$DSH_HOME/session-ask/`。
- **没有按调用方的 allowlist**：目前只有同 cwd 限制；设置页还没有“允许哪些会话问我”。
- **只读层是粗粒度**：目标如果需要写文件/跑命令，必须显式用 `full`。
- **目标轮次消耗目标上下文**：B 会带着自己的完整历史跑一轮。
- **设置页字段是自由文本/数字**：`targetTools` 目前由 `resolveConfig` 归一化，不是下拉枚举。

## License

MIT
