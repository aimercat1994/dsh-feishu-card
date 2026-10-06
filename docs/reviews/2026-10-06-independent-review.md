# 独立代码评审记录（2026-10-06）

> **这份文档保留的是评审当时（未修）的状态，是一份历史记录，不要照它改代码。**
> 当前的架构说明见 [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)。
>
> 评审由另一个 agent 在此工作副本上完成（该 agent 对本目录有文件访问权），
> 它独立发现了 1 个高优先级、2 个中优先级、若干低优先级问题与 README 漂移。
> 所有结论都已逐条复核，**评审是对的**——包括作者自己漏掉的那个高优先级缺陷。
>
> ## 处置结果
>
> | 评审项 | 处置 | 说明 |
> | --- | --- | --- |
> | **高：反应反馈的传输层方法不存在** | ✅ 已修 | `FeishuTransport` 补上 `addReaction` / `removeReaction`。**根因值得记住**：插入补丁用了一个多行注释的单行前缀作为锚点，永远匹配不到，而脚本没有 assert 匹配就打印了"已修补"——补丁静默失效。更关键的是**离线测试用了带这两个方法的假 transport，所以永远测不出来**。已新增"真实 transport 方法表面 ⊇ 组件实际调用"的交叉断言（覆盖 `index.js` + `lib/`，共 12 个方法），并在本记录下方说明其敏感性 |
> | **中：`showProcess: false` 时通知静默消失** | ✅ 已修 | `Notices.post` 改为先问 `renderer.acceptsActivity()`；无过程面板时改发独立卡片。新增覆盖该组合的断言 |
> | **中：`/new` 未级联清理会话级状态** | ✅ 已修 | `/new` 现在级联调用 `ProgressCards.forget` / `Notices.forget` / `Fanout.forget` |
> | **中：`ReactionTracker` 按消息无界增长** | ✅ 已修 | 加 `MAX_TRACKED = 200` 的插入序淘汰 |
> | **低：`log.js` 的 `MAX_BYTES` 没有任何截断逻辑** | ✅ 已修 | 实现轮转（`rename` 到 `.1`），并移除无调用点的 `readLogTail` |
> | **低：`invalidElementIds` 只在测试里跑** | ✅ 已修 | 新增 `assertValidCard()`，在建卡前调用（`turn.js` / `progress.js`），把平台的静默拒绝转成本地可处理的错误 |
> | **低：死代码** | ✅ 已清 | 移除 `updateElement`、`OWN_COMMANDS`、`statusUnbound` |
> | **文档漂移（7 项）** | ✅ 已修 | README 已整体重写为交付文档 |
> | 语义细节：`/stop` 会先建会话再取消 | ⏸️ 保留 | 无害；`/stop` 需要 agent 才能取消，先建是必然的。已在代码注释说明 |
> | 语义细节：`denyTools` 文案硬编码中文 | ⏸️ 保留 | 已知，路线图里随授权收窄一起处理 |
>
> **评审没提到、但作者自查发现的同类问题**：`Notices.post` 依赖的假 renderer 同样只有组件用到的方法，
> 所以新增的契约断言只覆盖 transport 一层——其他协作对象的表面仍未受保护。

---

# dsh-feishu-card 架构说明

> 快照：本文对应工作副本 `~/dsh-feishu-card`（`index.js` 947 行 + `lib/` 12 个模块共 2499 行 = 源码 3446 行，另有 `test/offline.mjs` 912 行）。
> 所有行号都是**当前工作副本**的行号；改了代码行号就会漂。README 已明显滞后于代码，冲突处以本文与代码为准（见 §12）。

## 1. 定位

把 DSH 的一个「回合（turn）」渲染成飞书里**一张持续更新的交互卡片**：流式正文、思考与工具时间线、审批/提问按钮、以及跨回合存活的 todo/goal 卡片。

与 HFC（hermes-feishu-streaming-card）的关系是**重新实现**，不是移植：HFC 要在宿主源码里打 17 个补丁再跑一个 sidecar，本插件是同进程的 Cordis 插件，靠 DSH 原生 Event/Service 完成同样的事——无补丁、无 sidecar、无公网 callback URL、无 HMAC 传输层。入站事件走飞书应用自己的 **WebSocket 长连接**（`lib/feishu.js:162`）。

## 2. 运行形态与装配

| 项 | 内容 |
| --- | --- |
| 插件名 | `dsh-feishu-card`（`index.js:36`） |
| 依赖的 Host 服务 | `inject = ['sessionController']`（`index.js:39`），另外按需软取 `commands` / `jobs` / `workspaceRegistry` / `goals` / `agents` / `tools` |
| 装配方式 | `package.json` 声明 `dsh.bundle.patch = ./cordis.patch.yml`，补丁插入一行 `id: feishu-card` |
| 凭据来源 | 行 config → `FEISHU_APP_ID/SECRET` 环境变量（`lib/config.js:70-72`）→ 插件自有 `credentials.json` → 二维码注册 |
| 激活策略 | **fail-open**（`index.js:75-86`）：拿不到凭据只打一条 warn 并保持惰性，绝不让 profile 启动失败 |
| 模块类型 | ESM（`"type": "module"`），无构建步骤，源码即产物 |

**单长连接约束**：飞书把同一个应用的事件只投递给一条长连接，所以本插件不能和另一个飞书渠道（例如 `@moyu-good/dsh-lark-bridge`）用同一个 appId 同时跑，`cordis.patch.yml` 顶部的注释专门警告了这一点。

## 3. 模块地图

```
index.js  装配与接线：config → 组件 → 事件/waterfall → 生命周期
├── lib/config.js      Config schema（设置页渲染 + 补丁校验）与 resolveConfig
├── lib/feishu.js      传输：WS 长连接、CardKit 实体、sequence 递增、原始 payload 解析
│   ├── lib/log.js         写文件的 logger（+ readLogTail 诊断）
│   └── lib/onboarding.js  credentials.json + 扫码注册飞书应用
├── lib/card.js        卡片 JSON 2.0 构造器、稳定 element_id、预设与决策元素
│   ├── lib/turn.js        单回合卡片状态机、节流合并、终态渲染
│   ├── lib/progress.js    跨回合的 todo / goal 卡片
│   └── lib/notice.js      重试 / 上下文压力 / 压缩失败 / 后台任务 → 一行通知
├── lib/session.js     会话身份：chat 维度 → 持久 session id + 路由
├── lib/commands.js    斜杠命令：只认 4 个自有命令，其余转发 Host 注册表
├── lib/present.js     工具调用 → 人话短语 + diff 块 + token 格式化
└── lib/react.js       用户消息上的状态表情（ack/working/done/fail）
```

### 3.1 `index.js` — 装配与接线

- `apply(ctx, config)`（`index.js:75`）是整个插件的唯一入口，做五件事：解析配置与工作目录（`:76-88`）、取凭据（`:92-102`）、构造组件（`:109-145`）、注册事件与 waterfall（`:460-755`）、注册清理（`:760-781`）。
- `resolveWorkspaceCwd`（`:875`）刻意不用「第一个 workspace」：`workspaceRegistry.list()` 的顺序不是注册顺序，本部署里第一个就是 harness 安装目录（`:839-847`），把编码 agent 默认指向自己等于埋一个自我修改的坑。它用 `DSH_HOME`/`DSH_PROFILE_DIR`/`process.argv[1]` 反推 harness 根目录并排除其子树。
- 会话隔离的地基是一个 `lifetime` AbortController（`:107`）：DSH 的 Remote 实现会在每次调用里 `signal.throwIfAborted()`，所以**不传 signal 不等于「不取消」**，而是整个调用失败。
- 卸载时（`:760-781`）先 `lifetime.abort()`，再 settle 所有 pending 交互、撤销 per-agent 注册、dispose 四个组件、`transport.stop()`。

### 3.2 `lib/config.js` — 配置

`schema`（`config.js:20-66`）就是设置页表单与补丁校验的依据；`resolveConfig`（`:69`）额外折叠进环境变量与默认值，并做**白名单式兜底**（枚举外的值回落到默认，而不是抛错）。

值得注意的三处设计：

- `locale: 'auto'` 在**国际版域名**上落到 `en`，否则 `zh`（`config.js:84`）。
- `textSizes` 的四档值是收窄过的：平台不校验 `text_size`，写了不认识的值只会被静默忽略，所以只在「确实能渲染出差异」的集合里取值（`config.js:43-49`）。
- `denyTools` 默认为空（`config.js:17`），即「飞书渠道禁用某工具」这个能力**默认不生效**，必须显式配置才有 `tools.guard`（`index.js:536-546`）。

### 3.3 `lib/session.js` — 会话身份

**核心决定：durability 来自 Host，不来自插件的文件。** session id 是 chat 维度的纯函数 `feishu-<key>`（`session.js:42`），重启后同一会话推出同一个 id，历史由 Host 自己的 session store 提供；插件只保存「回哪个 chat」的路由，而路由是进程内状态，下一条消息就能重建（`session.js:46-54`）。

- key 的每段先 `encodeURIComponent` 再冒号拼接（`session.js:29-39`）：否则 `{chat:'a:b', thread:'c'}` 与 `{chat:'a', thread:'b:c'}` 会撞成同一个 session，两个会话静默合并。`chat-thread` 没有 thread 时退化成 chat。
- `reach(key)`（`:209`）的阶梯是 **live agent → 已持久 session → 新建**；`session/not-found` 之外的错误（busy / 被写者占用）直接抛出，绝不退化成「新建一个会话」（`:228-232`）。并发 reach 用 `#opening` 去重（`:215`）。
- `bindings.json` **只存 `/new` 的覆写**（`:78-79`, `:135-147`），不是整张绑定表；默认 id 完全不需要文件。

### 3.4 `lib/feishu.js` — 传输

类 `FeishuTransport` 的职责被刻意压到三件（`feishu.js:1-13`）：WS 长连接、一张卡片实体的生命周期、**严格递增的 `sequence`**。

- `sequence` 是承载性不变量：同一张卡片的每次变更都必须带一个比上次更大的 `sequence`，否则平台拒绝。计数器按 cardId 存在传输层内部（`:186-190`），调用方永远不持有它；卡片再也不可能被更新时用 `releaseCard` 释放（`:193`）。
- 所有 SDK 调用都过 `call`/`assertOk`（`:27-47`）：飞书把有用信息（`code`、`msg`、出错元素路径）放在 `error.response.data`，不剥出来就只剩一句「status code 400」。
- `sendCardOnce`（`:325`）与 `sendCard`（`:268`）的区别是关键：前者把**卡片文档本身**当 `interactive` 消息内容发（一次性卡片），后者发 `{type:'card', data:{card_id}}`（实体卡片，需要 cardId）。混用会让卡片路径的失败变成「用户什么也收不到」。
- `sendText`（`:295`）是最后一道兜底：它不可能因为卡片原因失败，所以卡片路径炸了也还能把错误送到人眼前（`index.js:285`）。

### 3.5 `lib/card.js` — 卡片构造

卡片是**扁平元素列表**且每个可更新元素都有稳定 `element_id`（`card.js:13-26`）——这是与客户端的线协议，改名的代价是数据迁移。所有元素**永远存在**（`card.js:148-153`）：后到的流式更新不需要插入节点，插入会改变流式过程中的布局。

两个硬约束被写进了代码而不只是注释：

- `element_id` 必须 `^[A-Za-z][A-Za-z0-9_]{0,19}$`（`card.js:36`），违者 `cardkit.card.create` 报 `300301`，用户看到的是**一张卡都没有**。`invalidElementIds`（`:39`）提供校验（注意：**运行期没有调用它**，见 §12）。
- 卡片 JSON 2.0 已经移除了 `action` 容器：按钮必须是 `body.elements` 的直接元素，用 `action` 包裹会让整张卡建不出来（`200861`）（`card.js:273-275`、`progress.js:76`）。

布局：**正文在上，过程面板在下**（`card.js:95-107`），四个预设只控制「过程露出多少」——`expandedRunning` / `expandedDone` / `reasoning`（`card.js:108-113`）。`collapsible_panel` 的写法是从一张**实测通过的卡**抄来的（`:124-146`），刻意不带 header `icon`：一个没验证过的 token 会拖垮整张卡。

按钮排布用 `column_set` + `flex_mode: 'flow'` 每行 4 个（`:316-333`）；自由输入的表单必须带 `name`，提交按钮用 `form_action_type: 'submit'` 且**不能带 `behaviors`**，关联 id 只能塞进按钮 `name`（`:342-365`）。

### 3.6 `lib/turn.js` — 单回合卡片状态机

三条规则（`turn.js:1-18`）：

1. **实时 delta 与已提交事件描述同一段文字，所以分开累加、拼接显示。** `TurnState` 有 `committedAnswer` / `liveAnswer` 两组字段（`:48-53`），`answer` getter 拼接（`:89-91`）；`commitAssistant`（`:283`）把 live 折进 committed 并清空 live——两边都追加会把每个回答打印两遍。
2. **卡片文档从累加字符串整体重建，不往未知状态里打补丁。** 终态因此是一次 `card.update`（`:442`），而不是一串与流式写入赛跑的元素编辑。
3. **delta 的到达速度远高于平台可接受的写入速度**：文本进缓冲，定时器按 `flushIntervalMs`（默认 400ms）合并成「每元素每周期一次写入」（`:350-357`）；终态事件永远 flush。

`flush`（`:367`）里有两个必须知道的细节：

- **头部（标题 / 实时动作 / 颜色）不是卡片元素**，只有整卡 `card.update` 能改它；而整卡更新会顺带携带所有元素，所以它**替代**该轮的逐元素写入，而不是与之竞争（`:359-381`）。
- 空串写入会被平台拒绝（HTTP 400），写一个没变的元素则白白烧掉一个 `sequence`，两者都被跳过（`:386-391`）。
- 流式写入失败不致命：终态的 `card.update` 携带完整内容，卡片会自愈（`:393-397`）。

`finish`（`:418`）会先 await 正在进行的建卡（否则「卡片还没建完回合就结束了」会漏掉终态），再关掉 `streaming_mode`（`:460`）并 `releaseCard`。

### 3.7 `lib/progress.js` — 跨回合卡片

todo 与 goal 与回合卡的本质差别是**它们比回合活得久**：goal 可以跨很多回合甚至跨重启，所以它们是各自独立的卡片实体，第一次出现时创建、之后**在原卡上更新**（`progress.js:129-151`）。

- 目标被清除（tombstone，无快照）时**保留最后一张卡**当历史记录（`:159-162`），静默删卡比留个终态更糟。
- todo 最多渲染 12 行，超出显示还剩多少项（`:36-48`）。
- 卡片实体过期时的恢复策略：发布失败就忘掉它，下一次快照重建一张新卡（`:144-150`）。
- goal 按钮点下去会**真的调用 `ctx.goals`**（`index.js:910-928`），再用返回的新快照重绘，而不是本地改数字。

### 3.8 `lib/notice.js` — 通知

聊天界面有一个 Web UI 没有的问题：过程面板只显示「回合自己产生的东西」，于是长时间的模型重试、快要溢出的上下文、别处结束的后台任务都是隐形的。这里把它们变成一行字（`notice.js:1-14`）。

**每一个信号都是纯观察者**：重试与压缩的 handler 位于它们并不拥有的 waterfall 里，必须 `next()` 交还，且绝不能把异常抛进 Host 的错误路径（`index.js:463-487`）。

投递位置分两种（`notice.js:93-110`）：**回合内**进过程面板（读者本来就在看那里），**回合外**发一张独立小卡片（否则那行字没有地方待，会真的丢）。

上下文压力只在**跨过阈值时**报一次，回落后重新武装（`:130-139`）。

### 3.9 `lib/commands.js` — 斜杠命令

**刻意几乎不实现命令**：Host 已经有完整命令注册表（`/model`、`/compact`、`/goal`…），所以以 `/` 开头的行转发给 `commands.execute`，把回答渲染进卡片；按渠道重新实现一遍，会在任何插件注册命令的那一刻开始漂移（`commands.js:1-14`）。自有命令只有 4 个：`help` / `new` / `status` / `stop`（`:74`）。

### 3.10 `lib/present.js` — 工具调用的人话

Host 的 `ToolCallView` 只被 Web 客户端消费（它从 session 事件算出来），没有 Host 服务会把现成的 view 交给聊天桥。所以这里自己从「工具名 + 参数」推出短语，并从编辑类工具里抠出一段 diff（`present.js:1-15`）。纯表现层：不认识的工具必须退化成裸名字，而不是抛异常。

### 3.11 `lib/react.js` / `lib/log.js` / `lib/onboarding.js`

- **react**：表情是**叠加**的，换状态 = 先删旧再加新（`react.js:78-93`）；删除失败必须上报（留着两个表情在用户看来就是 bug）。终态一次性：`done`/`fail` 之后迟到的 `working` 不能把它拉回去（`:66-67`）。每个消息的切换用 promise 链串行化（`:70-75`）。**注意：真实传输层没有实现这两个方法**，见 §12。
- **log**：本部署的 console 是 supervisor 拥有的管道，没人看；所以每行同时落到 `<stateDir>/dsh-feishu-card.log`（`log.js:34-66`）。写入是 fire-and-forget，绝不拖慢投递路径。
- **onboarding**：本部署的 Host `settings` 服务没有 `register`，插件自有文件是唯一可用的持久存储；文件 0600（`onboarding.js:52-70`）。扫码注册失败即结束（保持惰性），只有「二维码过期」会按 `reissueFloorMs`（默认 60s）重新出码，避免轮询空转（`:106-164`）。申请的权限里包含 `im:message.reactions`（`:124`）。

## 4. 数据流 A：入站消息 → 会话 → 卡片

```
飞书用户发消息
  └─ WS 长连接 → EventDispatcher['im.message.receive_v1']            feishu.js:145
      └─ onMessage(data)                                             index.js:165
          1. readInboundMessage：只认 text，其它类型确认后忽略          feishu.js:75-104
          2. 非 user 发送者 / 群白名单 / 发送者白名单 过滤               index.js:170-173
          3. 群里没 @ 就丢（requireMention 默认 true）                  index.js:176
          4. conversationKey(scope, inbound) → sessionId                index.js:181-182
          5. sessions.reach(key)：live → 持久 → 新建 agent              session.js:209
          6. bind + refreshReplyAnchor（回执锚点=最新用户消息）           index.js:186-187
          7. /stop 最先判定（回合跑着时正好要用它）                        index.js:191-198
          8. 其它 /命令 → 自有 4 个本地答，其余转发 Host 注册表             index.js:200-231
          9. 该会话有待答提问 → 这条文字被当作答案，不开新回合              index.js:238-250
         10. autoResumeGoals：给被 idle 解除武装的目标重新武装            index.js:252
         11. 没有活卡就开一张（begin 幂等）                              index.js:257-265
         12. 在用户消息上打 ack 表情（预期行为，实际失效，见 §12）         index.js:269
         13. sessionController.prompt({mode:'queue'})                  index.js:271-279
```

失败路径（`index.js:280-291`）：记日志 → `fail` 表情 → **纯文本**兜底。刻意不用卡片兜底：卡片兜底会因为同样的原因再失败一次，用户就什么都看不到了。

`mode: 'queue'` 的含义：回合正在跑时到达的消息是**排队**，不是立刻开跑；它的卡片会在自己的 `turn/start` 时打开，所以这里绝不能把正在跑的回合卡结算掉（`index.js:254-256`）。

## 5. 数据流 B：会话事件 → 卡片渲染

单一入口 `ctx.on('session/event', …)`（`index.js:560`），先按 `sessions.serves(sessionId)` 过滤，再按事件类型分派：

| 事件 | 卡片动作 | 位置 |
| --- | --- | --- |
| `turn/start` | 表情 `working`；标题「思考中」+ 蓝；清空 live 缓冲；必要时开卡 | `index.js:566-584` |
| `tool/call` | 分类短语进 activity；短语设为副标题（实时动作行）；编辑类补一个 diff 块 | `index.js:586-595` |
| `tool/result` | 仅失败时追加「⚠️ 失败」并改副标题 | `index.js:597-606` |
| `todo/write` | 交给 `ProgressCards.showTodos`（独立卡片） | `index.js:608-611` |
| `goal/change` | 交给 `ProgressCards.showGoal` | `index.js:613-617` |
| `request/context` | 记住 contextWindow（供压力通知做分母） | `index.js:619-622` |
| `assistant/message` | `commitAssistant`；记模型与 usage；清重试计数；可能报上下文压力；副标题「正在整理回答…」 | `index.js:624-641` |
| `turn/end` | 组装页脚（耗时·工具数·模型·↑in ↓out）、表情 `done`/`fail`、`finish` 一次终态更新 | `index.js:643-672` |

另一条并行入口是**助手流**：`ctx.on('agent/assistant-stream')`（`index.js:508`）只处理 `start`（重置 live 缓冲）与 `chunk` 里的 `text-delta` / `reasoning-delta`。这是唯一高频路径，最终都被 `turn.js` 的节流合并吸收。

## 6. 数据流 C：交互（审批 / 提问 / 目标按钮 / 表单）

两条 waterfall 都被**抢占式**接管（`{ prepend: true }`，`index.js:705` / `:754`），拿不到 session 归属时 `next()` 交还。

```
approval/request        → askViaCard({kind:'approval'}) → 'allowed-once' | 'rejected' | 'cancelled'
user-questions/request  → 逐个问题问（一次一个）→ { answers:[{id, selected}] }
```

`askViaCard`（`index.js:355-458`）的设计要点：

1. **优先内嵌**：`renderer.setInteraction` 成功（该会话有活卡）就把按钮放进正在流式输出的那张卡；返回 false（回合之间的提问）才另建一张独立决策卡（`:377-385`）。
2. 关联 id 是插件本地的 `nextId()`（`:161`），点击时原样回传，卡片本身**不携带任何 session 或审批身份**。
3. 结算时把回执留在按钮的位置（`:406-409`），这样卡片读起来是「问了什么、选了什么」的连续记录。
4. 超时（`approvalTimeoutSec`，默认 300s）与 `signal` 中止都会 settle 成 `cancelled`；可选的 `approvalReminderMs` 会追加「仍在等待你的选择…」（`:429-447`）。
5. **只有提问**会登记 `pendingByChat`（`:456`）：下一条文字消息可以被当作答案，而「允许一次」没法用散文无歧义地表达（`:150-157`）。

按钮点击经 `card.action.trigger` → `onCardAction`（`index.js:296-347`）。三层收敛：cardId 失效 → toast「该操作已失效」；**跨 chat 点击**一律拒绝；配了 `approvers` 时非审批人一律拒绝（`:306-320`）。随后按 `action.k` 分派 `goal` / `option` / `approve` / `deny`；表单提交用按钮 `name` 上的 `custom_submit_` 前缀找回关联 id（`:301-328`，前缀定义在 `card.js:62`）。

## 7. 承载不变量的地方（改代码前必须知道）

| 不变量 | 违反的后果 | 约束在哪 |
| --- | --- | --- |
| 同一卡片每次变更 `sequence` 严格递增 | 平台拒绝更新 | `feishu.js:186-190`，调用方不持有计数器 |
| `element_id` 只允许 `[A-Za-z0-9_]`、首字母、≤20 | `300301`，整卡建不出来 | `card.js:36`（校验器存在但**运行期未调用**） |
| V2 无 `action` 容器 | `200861`「unsupported tag action」，整卡建不出来 | `card.js:273`，`progress.js:76` |
| 元素空内容写入 | HTTP 400（只报 status code） | `turn.js:386-389`，`card.js` 元素恒存在 |
| 表单必须带 `name`；提交按钮不能带 `behaviors` | `11310` | `card.js:342-365` |
| 头部不是元素 | 改标题/颜色只能整卡 `card.update` | `turn.js:74-80`, `:359-381` |
| live delta 与 committed 文本不重复累加 | 每个回答打印两遍 | `turn.js:283-295` |
| 所有 Host 调用必须带 signal | Remote 实现会 `throwIfAborted()` | `index.js:104-107` |
| 表格/瀑布观察者必须 `next()` 且不抛 | 打断 Host 的 turn / 压缩流程 | `notice.js:9-11`，`index.js:463-487` |
| 同一 appId 只能一条长连接 | 事件被另一个渠道抢走 | `cordis.patch.yml` 顶部警告 |

## 8. 状态与落盘

`stateDir` 默认 `~/.dsh/dsh-feishu-card`（`onboarding.js:17-19`）：

| 文件 | 内容 | 写入方 |
| --- | --- | --- |
| `credentials.json` | 扫码得到的 appId/appSecret（0600，原子写） | `onboarding.js:52-70` |
| `bindings.json` | **只有 `/new` 产生的会话覆写** | `session.js:113-125` |
| `dsh-feishu-card.log` | 所有日志行 | `log.js:38-44` |
| `onboarding-url.txt` | 最近一次扫码 URL（二维码打印失败的兜底） | `onboarding.js:79-84` |

进程内状态（重启即失）：`ConversationSessions.#agents/#routing`、`TurnRenderer.#turns`、`ReactionTracker.#byMessage`、`ProgressCards.#cards`、`Notices.#pressured/#retries`、`contextWindows`、`pending`、`pendingByChat`。

## 9. 生命周期与失败模式

激活分支（`index.js:783-817`）：

1. 有凭据 → `startChannel()`（`:820`）→ `transport.start()` → 日志 `[feishu-card] active (sessionScope=…, cwd=…)`。
2. 没凭据但有存储的 → 用存储的（`:92-102`）。
3. 都没有且 `onboarding: true` → **不 await** 地跑二维码注册（`:795-817`）：扫码是等人来的，await 会把插件激活挂死；它作为绑定插件生命周期的后台任务跑，成功后再 `startChannel()`。

全链路 fail-open：任一步骤失败都只留一条日志并保持惰性，profile 照常启动。

## 10. 离线验证

```
node test/offline.mjs        # 当前 98 项断言全部通过，无网络、无飞书
```

用假 transport 记录每次调用，断言的都是**真实会伤到用户的不变量**（`test/offline.mjs:1-13`）：实时 delta 与已提交文本不重复计、流式写入会被合并而不是一 token 一写、终态渲染一次 `card.update` 且携带完整内容、会话 key 单射且并发开卡只有一张、斜杠命令在缺服务时降级而不是抛错。

覆盖分组：卡片构造 / element_id 合法性 / 渲染器节流与终态 / 并发 begin / 会话 key 单射 / reach 阶梯与 `/new` 轮换（含重启后从磁盘恢复）/ 命令路由 / 阅读预设 / present 分类与 diff / 通知（含压力阈值只报一次且回落重武装）/ 进度卡片与陈旧实体恢复 / 反应状态机。

**测试为什么没抓到 §12 的第一个问题**：它给反应单独写了一个带 `addReaction`/`removeReaction` 的假对象（`test/offline.mjs:694-701`），从不校验真实传输层的**方法表面**。

## 11. 尚未验证的部分

README 记录：插件已安装并激活（`enabled: true`，`fiberPhase: active`），但**没有在真实飞书应用上端到端验收过**——当前环境没有任何飞书凭据，插件处于 fail-open 的惰性分支。配好凭据重启后，日志里应出现 `[feishu-card] connected to Feishu`。真实环境待验的关键点：卡片流式打字是否平滑、审批按钮回传是否真的 `allowed-once`、反应表情能否落上（见下）。

## 12. 已发现的缺口（按优先级）

### 高：反应反馈的传输层方法不存在（功能静默失效）

`lib/react.js:84` 与 `:90` 调用 `transport.removeReaction` / `transport.addReaction`，但 `FeishuTransport`（`lib/feishu.js`，完整方法表：`updateCredentials` / `start` / `stop` / `releaseCard` / `createCard` / `setStreaming` / `updateCard` / `streamElement` / `updateElement` / `sendCard` / `sendText` / `sendCardOnce`）**从未实现这两个方法**。运行时探针确认：

```
$ node -e "import('./lib/feishu.js').then(m=>{const t=new m.FeishuTransport({appId:'x',appSecret:'y'});console.log(typeof t.addReaction, typeof t.removeReaction)})"
undefined undefined
```

后果链：`reactionFeedback` 默认 `true`（`config.js:103`）→ `index.js:129` 构造跟踪器 → 每次 `show()` 都在 `#swap` 里抛 `TypeError` → 被 `react.js:73` 的 `.catch` 吞成一条 warn。**用户永远看不到 ack/working/done 表情**，而日志里每个回合稳定多出若干条 warn（极易被误读成「飞书限流」）。README §反应反馈 描述的整张行为表目前都不可达。

修法（二选一）：在 `lib/feishu.js` 里用 `client.im.v1.messageReaction.create/delete` 补上两个方法；或暂时把 `reactionFeedback` 默认改成 `false` 并在 README 标注未实现。补上之后还需一条**针对真实传输层方法表面**的断言，否则同类问题会再发生。

### 中：`showProcess: false` 时回合内通知必然写失败

`Notices.post`（`notice.js:95-98`）在回合内一律 `renderer.addActivity()`，而 `addActivity` 的目标元素 `ELEMENTS.activity` **只存在于过程面板里**；`buildTurnCard` 在 `showProcess: false` 时根本不创建该面板（`card.js:180-192`）。于是「重试 / 上下文压力 / 压缩失败」这几条通知会走到 `streamElement(cardId, 'activity', …)`，对一个不存在的元素写入 → 平台报错 → 被 `turn.js:393` 吞成 warn，**通知静默消失**。`showProcess: false` 与 `notices: true` 是两个都合法的默认开启/可配置项，组合起来就是坑。

### 中：`/new` 之后没有清理会话级进程内状态

`ProgressCards.forget`（`progress.js:165`）、`Notices.forget`（`notice.js:154`）、`ReactionTracker.forget`（`react.js:96`）、`ConversationSessions.forget`/`liveSessions`/`rebind` 都定义了但**没有任何生产调用点**（`grep` 只在测试里命中）。`/new` 只做 `sessions.rotate`（`index.js:203-205`），于是旧 sessionId 在 `#cards`、`#pressured`、`#retries` 里长期留着。另外 `ReactionTracker.#byMessage`/`#queues` 是**按消息**建的、没有任何回收路径，长时间运行的机器人里会随消息数无界增长。当前影响有限（会话/消息量小），但属于确定性泄漏。

### 低：死代码与未生效的防护

| 位置 | 情况 |
| --- | --- |
| `card.js:39` `invalidElementIds` | 运行期从不调用（只在测试里跑）。注释说「所以在这里断言，而不是信任」——实际生产路径并没有断言 |
| `feishu.js:254` `updateElement` | 无调用点（决策按钮靠整卡重写发布） |
| `log.js:16` `MAX_BYTES` | 注释是「限制文件大小，防止刷屏失败撑爆磁盘」，但**没有任何截断/轮转逻辑**，`dsh-feishu-card.log` 会无限增长；该常量只被导出 |
| `log.js:69` `readLogTail` | 诊断用，无调用点 |
| `commands.js:74` `OWN_COMMANDS` | 无调用点（`index.js:191-231` 自己按名字分派） |
| `commands.js:41` `statusUnbound`<br>`commands.js:50` `unknown`(en) | 文案已备好但无使用路径 |

### 文档漂移：README 落后于代码

README 是 v0.1 时写的，以下内容已经**不成立或会误导**：

1. §目录（`README.md:198-207`）列了 `lib/store.js`——**该文件不存在**（对应物是 `lib/session.js`），且漏列 9 个模块（`commands`/`config`/`log`/`notice`/`onboarding`/`present`/`progress`/`react`/`turn`）。
2. §v0.1 的已知限制（`README.md:176-184`）里「审批卡片是独立消息」「无阅读预设、无宽度/字号配置、无页脚 token 统计」「没有 `Config` 导出」全部**已被实现推翻**（现在导出 `Config`，见 `index.js:41`；预设见 `card.js:108`；页脚 token 见 `index.js:656-658`；审批内嵌见 `index.js:377`）。
3. §配置（`README.md:88`）里的 `allowChats` 在 schema 中**不存在**，实际是 `groupAllowlist` / `senderAllowlist`（`config.js:30-31`）；同时漏了 `sessionScope`、`locale`、`approvers`、`denyTools`、`autoResumeGoals`、`onboarding`、`approvalReminderMs`。
4. §配置优先级（`README.md:53`）只说「环境变量 < 行 config，两者都没有则不激活」，漏掉第三条路：插件自有 `credentials.json` 与扫码 onboarding。
5. §验证状态（`README.md:190-191`）说「5 个源文件」「16 项离线断言」，实际是 `index.js` + 12 模块、**98 项断言**。
6. §验证状态（`README.md:196`）预期的日志行 `[feishu-card] active; N chat binding(s) restored` 与代码实际输出的 `[feishu-card] active (sessionScope=…, cwd=…)`（`index.js:832`）不一致。
7. §使用（`README.md:96`）说 `/new`（或 `/reset`），但 `/reset` 不在自有命令里，会被转发给 Host 注册表。

### 两个值得知道的语义细节（不是缺陷）

- `index.js:191` 的 `/stop` 在 `sessions.reach()` **之后**判定，所以对一个还没有 session 的会话发 `/stop`，会先把它建出来，再取消。无害，但与「停止前不该建东西」的直觉不同。
- `denyTools` 的守卫报错文案是硬编码中文（`index.js:542`），不受 `locale` 影响。

## 13. 如果要继续改，建议顺序

1. **修 §12 高优先级**：给 `FeishuTransport` 补 `addReaction`/`removeReaction`（`im.v1.messageReaction.create/delete`），并加一条断言校验「真实 transport 的方法表面 ⊇ 各组件实际调用的方法」——这类 bug 靠单元测试的假对象永远抓不到。
2. **修 §12 中优先级**：`Notices.post` 在回合内且无过程面板时改走「独立小卡片」而非 `addActivity`；`/new` 时级联调用各组件 `forget`。
3. **给 `log.js` 补真正的轮转**（`MAX_BYTES` 已在，缺实现）。
4. **修 README 漂移**：目录表、已失效的限制清单、配置表、验证状态；或者干脆让 README 只讲「怎么用」，架构细节交给本文。
5. **端到端验收**（需要真实飞书凭据）：流式打字、审批回传 `allowed-once`、提问三条路径（点按钮 / 文字回答 / 卡片输入框）、目标按钮真调 `ctx.goals`。
6. 顺手把 `invalidElementIds` 接到建卡前的运行期校验上（失败时降级为纯文本而不是让用户什么都看不到）。
