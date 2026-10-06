# 变更历史

本项目在一次连续开发中从零建成，以下按**功能落地顺序**记录，含当时踩到的平台问题和修正。写成这个粒度是因为每一条都对应一个真实的失败模式——维护时值得知道"为什么这里有个奇怪的判断"。

## 0.1.0

### 骨架

- 建立 DSH bundle 结构：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入 `feishu-card` 行
- 卡片 JSON 2.0 构造器与稳定 `element_id`
- CardKit 实体传输：建实体、流式写入、整卡重写，`sequence` 严格递增
- 回合渲染器：实时 delta 与已提交正文**分开累加**，400ms 合并写入

### 修：`element_id` 带连字符导致整卡被拒（300301）

用了 `process-sep` / `footer-sep` / `custom-form` / `custom-input`。平台只允许 `[A-Za-z0-9_]`、首字符字母、≤20 字符，**违反时整卡建不出来**。

同时发现兜底路径也是坏的：`sendCardOnce` 把内联卡片拼成了实体格式（`{type:'card', data:<卡片JSON>}`，那是需要 `card_id` 的实体形式），所以主路径失败后兜底也失败，两次都被吞掉——**用户那边一点动静都没有**。

修正：ID 全部下划线化；内联卡片发正确形状；新增 `invalidElementIds()` 与"禁止 `action` 标签"之外的规则断言，逐张校验全部构造器。

### 修：卡片路径失败被静默吞掉

原本的 catch 只是再发一张卡片（同样会失败）并 `.catch(()=>{})`。改为：**降级发纯文本 + 落盘日志**。

把"日志"列为功能而非调试辅助的原因：本部署的 harness 控制台是监管进程持有的管道，stdout 拿不到。只写 stdout 的插件的失败无法事后诊断。

### 修：`sessionController.prompt` 缺 signal

`prompt(request, signal)` 的第二个参数是 `AbortSignal`，实现里会调 `signal.throwIfAborted()`。不传等于传 `undefined` → 立即抛 `Cannot read properties of undefined (reading 'throwIfAborted')`。

症状很有迷惑性：卡片建成功了（`begin` 已通过），但回合从不启动，兜底卡片显示这条错误。同一个坑在 `commands.execute(agent, line, [], signal)` 上也存在，一并修。

### 会话身份改为确定性派生

原本用插件自己的 `bindings.json` 存 chat → session 映射。改为 `feishu-<会话键>` 纯函数派生：

- 重启后能推出同一个 id → 宿主 session store 直接给出历史 → **不需要绑定文件**
- 键的各段做 percent-encoding。裸拼 `chatId + ':' + threadId` 不单射，`{chatId:'a:b',threadId:'c'}` 与 `{chatId:'a',threadId:'b:c'}` 会撞成同一会话（HFC 有这个问题）
- `/new` 的"换一个 id"意图无法派生，所以**只有它**落盘

### 修：`/new` 是空操作

它当时只清了内存映射；由于 id 是派生的，`reach()` 会再次解析到**同一个**已持久化会话。改为真正轮换 id 并持久化覆盖映射。

### 修：`cwd` 默认指向 harness 安装目录

`process.cwd()` 是 harness 自己的安装目录。静默把编码 agent 指向正在运行的 harness 是典型的自伤默认值。

先改成"取第一个注册工作区"，但 `workspaceRegistry.list()` 的顺序不是注册顺序（该部署第一项恰好是 runtime 目录）。最终改为**排除宿主目录**（`$DSH_HOME`、profile 目录、运行中的 dsh 安装目录）后取第一个，并在日志里说明选了哪个。

### 修：头部状态从不推送到飞书

`setSubtitle` / `setStatus` 只改内存，从没发出——因为**头部不是可寻址元素**，元素写入够不到它，只有整卡 `card.update` 能改。而那时整卡更新只在 `finish()` 发生。

叠加"过程面板默认折叠"，症状是**整个回合卡片上什么都不动，直到结束才一次性刷出来**。

修正：`fullDirty` 标记触发整卡重写（带去重，重复值不重发）；面板在**运行中默认展开**。

### 版式：正文优先

过程面板从"正文之前"改到"正文之后"，四个预设全部遵循。同时删掉因此变成死代码的 `process_sep` 分隔条。

### 修：决策卡用了 V2 已移除的 `action` 标签（200861）

```
cards of schema V2 no longer support this capability; unsupported tag action
```

审批卡与提问卡共用构造器，**两种卡片从来就建不出来**。建卡失败后走"交给其他 answerer"降级，请求被 Web UI 接走，飞书端完全没反应。

同时修 `<form>` 缺 `name`（11310），并纠正表单提交语义：提交按钮用 `form_action_type: submit`、**不能带 `behaviors`**，关联 id 只能放按钮 `name` 里，输入值从 `action.form_value` 取。

### 修：空内容写入被拒（HTTP 400）

`cardElement.content` 不接受空串。而 SDK 的 axios 层直接抛错，`assertOk` 看不到细节——日志里只剩 `status code 400`。修正：跳过空内容与未变化内容；把 `error.response.data` 提取进错误信息。

### 交互：决策内嵌进回合卡

审批/提问原本另发一张卡，读者要在两条消息间来回对。改为按钮进入**正在流式的那张卡**（正文下方、页脚上方），点选后原位留回执。仅当该会话无活跃卡时才回退成独立卡片。

### 交互：自由作答改为回复聊天

去掉卡片内 `input`：它弹的是客户端原生编辑面板，各端体验不一致（移动端面板偏大、确认入口不统一），且与表单提交不是一套交互。

改为三条件路径：选项按钮 / **直接回复文字**（该会话有提问等待时，下一条消息作为答案而不是新回合）/ 卡片内输入框（`cardInput: true` 才启用）。审批**只认按钮**——只有按钮能无歧义表达"允许一次"。

### 反应反馈

用户消息上的 `OK` → `THINKING` → `DONE` / `ERROR`。

发现：飞书反应是**叠加**的，换状态必须**先删后加**。（诊断时曾把 `reaction_id` 截断到 12 字符，误判成"一条消息只能挂一个"；列出实际反应才发现 6 个都在。）终态一次性：`DONE` 之后不被迟到事件拉回。

### 外观配置

`widthMode`（default/compact/fill）与逐区域 `textSizes`。

发现：平台**不校验** `text_size`——不存在的值也返回成功。所以"API 接受"≠"有效果"，配置项限定在已知能渲染出差异的集合内。

### 通知

四个 DSH 原生信号：`agent/request-error`（重试）、usage vs `request/context.contextWindow`（上下文用量，跨阈值只报一次、降回后重新武装）、`compaction/summary-error`（压缩失败）、`jobs.events.subscribe`（后台任务结束）。

HFC 的 `compaction/start|summary|prune|end` 是 **Hermes 自己的事件**，DSH 的 `SessionEventMap` 里没有对应项。

回合内的通知进过程面板；回合外的（后台任务）另发小卡片——否则那行字没有地方待。

### 进度卡片

todo 与 goal 各占一张**独立卡片实体、跨回合存活**。第一次出现时创建，之后原位更新（不是每次变化发新消息）。

- todo：`todo/write` 会话事件
- goal：`goal/change` 会话事件，按钮**真正调用 `ctx.goals`** 并用返回的新快照重绘
- 目标清除时留最后一张卡当历史

### 扇出叙述

工作流与子代理的叙述行。用**会话事件** `tool-workflow/*` 而不是 Cordis `workflow/*`：后者只带 run id、**完全不带会话**，收到的表层无法判断属于哪个聊天。

### 文档

README 重写为完整交付文档；新增 `docs/ARCHITECTURE.md`（模块地图、事件清单、不变量、设计取舍）、`docs/PLATFORM-NOTES.md`（逐条实测的平台约束）、`docs/DEVELOPMENT.md`（迭代与验证流程）。

### 独立评审与修复

另一个 agent 在此工作副本上做了独立代码评审（全文留在 [docs/reviews/2026-10-06-independent-review.md](docs/reviews/2026-10-06-independent-review.md)）。**它的结论全部成立**，逐条复核后修复：

**高：反应反馈从未生效。** `ReactionTracker` 调用 `transport.addReaction` / `removeReaction`，而这两个方法在 `FeishuTransport` 上**根本不存在**——每次 `show()` 都抛 `TypeError`，被跟踪器自己的 `.catch` 吞成一条 warn。功能静默失效，日志里每回合稳定多出几条 warn（很容易被误读成飞书限流）。

三个层面同时出错才让它溜过去：

1. **插入补丁静默失效**：锚点写成了多行注释的单行前缀，永远匹配不到；而脚本没有 assert 匹配就打印了"已修补"。
2. **离线测试用了带这两个方法的假 transport**，所以永远测不出来。
3. **我的验证验错了对象**：我用 raw fetch 打通了平台 API（换挡序列确实成功），却从没验证**自己的代码路径**会去调它。

修复：补上两个方法；新增**"真实 transport 方法表面 ⊇ 组件实际调用"的交叉断言**（扫描 `index.js` + `lib/`，当前收集到 12 个方法，含生命周期调用）；并用 SDK 客户端（不启 WS，避免干扰运行中的连接）实跑 `im.v1.messageReaction.create/delete` 验证。这类"假对象掩盖缺失方法"的问题，只有对着真实类做契约断言才抓得到。

**中：`showProcess: false` 时回合内通知静默消失。** `Notices.post` 一律走 `addActivity()`，而 `activity` 元素只存在于过程面板里；面板被关掉时写入的是一个不存在的元素 → 平台报错 → 被吞成 warn。两个都合法且默认开启的配置组合起来就是坑。修复：先问 `renderer.acceptsActivity()`，无面板则改发独立卡片。

**中：`/new` 未级联清理。** `forget()` 方法定义了但没有调用点，旧 sessionId 的进度卡/通知状态会留到插件卸载。`ReactionTracker` 还按消息无界增长。修复：`/new` 级联 forget；反应跟踪加 200 条插入序淘汰。

**低：死代码与失效的防护。** `log.js` 的 `MAX_BYTES` 有声明无实现（日志会无限增长，比没有上限更糟——读起来像已处理）；`invalidElementIds` 只在测试里跑；`updateElement` / `OWN_COMMANDS` / `statusUnbound` 无调用点。修复：实现日志轮转、新增 `assertValidCard()` 接到建卡前（把平台的静默拒绝转成本地错误）、删除死代码。

**文档漂移。** README 是 v0.1 写的，已整体重写为交付文档。


---

## 未完成

- 图片输入 / 文件输出
- `denyTools` 与授权收窄的实测
- `output: cot`（飞书原生思考消息）模式
- 多问题合并表单
- 契约断言目前只覆盖 transport 一层；其他协作对象（renderer 等）的假对象仍可能掩盖同类问题
