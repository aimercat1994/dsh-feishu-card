# 架构

面向维护者。读完之后你应该能回答：**某个现象该去哪个文件找**，以及**为什么当初这么写**。

## 1. 设计前提

HFC 的形态由一个约束决定：**Hermes 没有插件事件系统**。所以它必须用安装器往宿主源码里打补丁、起一个 sidecar 进程、再用签名 HTTP + 重放保护把事件送过去。

DSH 没有这个约束。它把 agent 生命周期、工具执行、审批、提问、会话日志全部做成了一等公民的 **Cordis Event / Service**。于是本插件可以直接：

| HFC 必须做的事 | 本插件对应 |
| --- | --- |
| 打补丁拿 `thinking.delta` | 订阅 `agent/assistant-stream` |
| sidecar + HMAC + nonce + loopback 互信 | 同进程，无传输层 |
| hook 轮询 `/interactions/{id}` 拿审批结果 | 在 `approval/request` waterfall 里**直接返回**结果 |
| sidecar 检查点恢复卡片 | session id 由会话派生 → 宿主 session store 天然恢复 |
| pidfile / systemd / s6 / Docker | 不需要，插件生命周期归 Cordis fiber |

**这条前提决定了全部代码结构**：本插件没有"安装器""恢复器""诊断器""CLI"这些子系统——不是因为偷懒，而是因为对应的宿主能力已经存在。HFC 那 64k 行里绝大部分在弥补宿主缺失。

## 2. 模块地图

```
index.js              入口：配置解析、事件/waterfall 接线、生命周期
lib/
  config.js           Config schema（schemastery）+ resolveConfig（合并环境变量）
  feishu.js           传输层：CardKit / im / 反应 / WS 长连接 / 原始事件解析
  card.js             卡片 JSON 构造器 + ELEMENTS + PRESETS + element_id 校验
  turn.js             回合渲染器：单卡状态、节流、整卡 vs 元素更新
  session.js          会话身份：会话键派生 + 三档阶梯 + /new 轮换
  onboarding.js       凭据存储 + 二维码注册流程
  commands.js         斜杠命令解析与委派
  present.js          工具展示：分类、图标、短语、diff、token 格式化
  notice.js           通知：格式化 + 投递（回合内进面板，回合外发卡）
  react.js            反应反馈：换挡与终态一次性
  progress.js         todo / goal / 子代理卡片：独立实体、原位更新
  fanout.js           工作流 / 子代理叙述
  subagents.js        子代理名册：从委派调用 + 它的结果维护"这个聊天委派了什么"，
                      并用 subagent/catalog 与 subagent-settled 回收后台子代理的结局
  guard.js            工具守卫：按名称拒绝工具，纯判定 + 默认放行的容错
  media.js            入站媒体：类型嗅探、富文本解析、有界流收集
  images.js           图片流水线：逐张下载/校验/组装 prompt，失败只损失该张
  outbound.js         出站文件：realpath 路径安全 + send_file 工具定义

> **关于 `outbound.js` 的路径检查**：它做得对（先 realpath 再比较，符号链接逃逸被拦），但
> **它不构成安全边界**。实测：让 agent 发 `/etc/hostname`，它把文件复制进工作区再发副本，
> 完全绕过。原因是 agent 本身就有文件工具，"能读什么"决定"能发什么"。这条检查的价值是
> 约束工具自身参数、避免误发；真正的边界是部署文件策略与审批。详见 README 的说明。
  access.js           入站准入：谁可以开对话、为什么被丢弃（纯函数）
  log.js              控制台 + 落盘双写日志
client/client.js     浏览器一半：插件管理页里的配置表单（手写、免构建）
test/offline.mjs      283 项离线断言
```

**职责边界**（改动时请维持）：

- `feishu.js` **只做传输**：它不认识"回合""审批"这些概念，只认 `card_id`、`element_id`、`sequence`。任何业务判断都不该出现在这里。
- `card.js` **只做纯构造**：进去的是数据，出来的是卡片 JSON。没有网络、没有状态、没有副作用。这让它 100% 可离线测试。
- `turn.js` **只做单回合状态**：累积文本、节流、决定"这次该发元素写入还是整卡重写"。
- `index.js` 是唯一的**接线层**：事件进、渲染调用出。

## 3. 事件与服务清单

### 订阅的 Cordis 事件

| 事件 | 模式 | 用途 |
| --- | --- | --- |
| `session/event` | emit | **主干**：回合渲染、进度卡、扇出，全部从这里来 |
| `agent/assistant-stream` | emit | 实时 delta（打字机效果）。缺席时功能降级但不错 |
| `agent/created` | serial | 取 `agent.ctx`，注册该 agent 的 `denyTools` guard |
| `approval/request` | waterfall | 审批卡片。**`{prepend:true}`**，只认领自己服务的会话，其余 `next()` |
| `user-questions/request` | waterfall | 提问卡片，同上 |
| `agent/request-error` | waterfall | 纯观察者：报告重试后**必须** `next()` |
| `compaction/summary-error` | waterfall | 纯观察者，同上。**同步** waterfall，不能 await |

### 消费的 Service

| 服务 | 必需 | 用途 |
| --- | --- | --- |
| `sessionController` | ✅ `inject` | `resolveAgent` / `create` / `prompt` |
| `commands` | 可选 `ctx.get` | 斜杠命令委派 |
| `goals` | 可选 | goal 卡片的暂停/继续/清除 |
| `agents` | 可选 | 从 sessionId 找 agent（goal 操作需要） |
| `jobs` | 可选 | `jobs.events.subscribe` 后台任务完成 |
| `tools` | 可选 | 在 agent ctx 上注册 `denyTools` guard |
| `workspaceRegistry` | 可选 | 解析默认 `cwd` |

### 处理的 `session/event` 类型

`turn/start` · `turn/end` · `step/start` · `tool/call` · `tool/result` · `assistant/message` · `request/context` · `todo/write` · `goal/change` · `tool-workflow/run-start|agent-start|agent-end|run-end` · `subagent/descriptor`

> ⚠️ **发现陷阱（踩过两次）**：`todo/write`、`tool-workflow/*`、`subagent/*`、`goal/change` **不在 `dsh-session` 自己的 `SessionEventMap` 里**——它们由各自的工具包通过 **module augmentation** 声明。只 grep 宿主包一定会漏。要枚举完整事件集，必须搜所有 `*/lib/types/*.d.ts` 里的 `interface SessionEventMap`。

> ⚠️ **`subagent/descriptor` 到不了这里**：它由 `dsh-subagent` 写在**子会话**里（`child.session.append(...)`），而本插件只服务自己绑定的飞书会话（`ConversationSessions.serves()`），所以这条事件一律在门口被丢。即便放行，它的载荷（`version/mode/provider/label`）也**没有终态字段**，只能报"开始了"。子代理的痕迹因此改由**被服务会话自己的事件**建立（`tool/call` + `tool/result`，再用 `subagent/catalog` 与子代理结束时发到本会话的 `subagent-settled` 通知回收结局），见 4.6。

## 4. 数据流

### 4.1 入站消息

```
飞书 WS 长连接
  → FeishuTransport 的 EventDispatcher 'im.message.receive_v1'
  → readInboundMessage()  解析 chatId/messageId/text/mentions/senderType
  → 过滤：非 user 发送者（含机器人自身回声）/ 白名单 / 群内是否需要 @
  → conversationKey(scope, inbound) → sessionId = 'feishu-' + key
  → ConversationSessions.reach(key)   三档阶梯（见 4.2）
  → 若命中"等待中的提问"：作为答案 settle，返回，不开新回合
  → 斜杠命令分支（/stop 最先，其余委派宿主）
  → renderer.begin()  仅在无活跃卡片时
  → reactions.show(msgId, 'ack')
  → sessionController.prompt(request, lifetime.signal)
```

### 4.2 会话阶梯

```
resolveAgent(sessionId)
  ├─ 命中 → 用它（可能是别的进程恢复出来的活 agent）
  ├─ 'session/not-found' → create({sessionId, cwd}) → 再 resolve 一次
  │                        （create 只返回 id，不返回 agent）
  └─ 其他错误码（agent-busy / writer-held）→ 抛出，由调用方报告
```

**为什么 id 是派生的**：`feishu-<会话键>` 是纯函数，所以重启后能推出同一个 id，宿主 session store 直接给出历史——**不需要插件自己维护绑定文件**。唯一的例外是 `/new`：它必须指向一个*不同*的会话，所以只有这条路径会被持久化到 `bindings.json`（一个覆盖映射）。

**键必须单射**：各段做 percent-encoding 后拼接。裸拼 `chatId + ':' + threadId` 会让 `{chatId:'a:b', threadId:'c'}` 和 `{chatId:'a', threadId:'b:c'}` 撞成同一个会话——静默合并两个对话。（HFC 有这个问题，飞书 id 目前不含冒号所以没暴露。）

### 4.3 回合渲染

```
renderer.begin(sessionId, routing)
  → transport.createCard(document)     CardKit 实体
  → transport.setStreaming(cardId, on) 失败只警告
  → transport.sendCard(cardId, routing) 回复用户那条消息

delta 到达（agent/assistant-stream）
  → addLiveAnswer / addLiveReasoning  只进内存缓冲，标脏
  → #schedule()  → 默认 400ms 后 flush

flush() → #write()  逐轮挂在 chain 上串行，同一张卡不会有两笔写并发（否则 300317）
  ├─ 距上次续期 ≥ 8 分钟 → setStreaming(on) 先续期
  │                       （平台 10 分钟后关流式模式，且写不会顺延）
  ├─ !streaming 或 fullDirty → 一次 transport.updateCard(整卡)
  └─ 否则逐元素 transport.streamElement(cardId, elementId, content)
        ├─ 200850 / 300309 → 会话已被平台关闭 → 续期并重试
        └─ 连续失败到达预算 → 降级为整卡重写；整卡也连续失败 → 本轮不再实时更新

提交到达（session/event: assistant/message）
  → commitAssistant()  把实时缓冲折进"已提交"区并清空实时区

turn/end
  → finish()  先等 chain 排空（免得流式写落在关流式之后）
             → 一次 transport.updateCard(整卡) + 关闭流式 + 释放 sequence 计数
```

### 4.4 交互往返

```
approval/request（waterfall，prepend）
  → 只认领 sessions.serves(sessionId) 的请求，否则 next()
  → askViaCard()
      ├─ renderer.setInteraction() 成功 → 按钮进**正在流式的那张卡**
      └─ 失败（回合之间无活跃卡）→ 另建一张决策卡实体
  → 返回 Promise，等点击 / 超时（approvalTimeoutSec）/ 中止（req.signal）
  → resolve → 返回 'allowed-once' | 'rejected' | 'cancelled' 给 waterfall
  → 原位把按钮换成回执
```

点击入口是 WS 的 `card.action.trigger` → `onCardAction()`，校验：卡片所属 chat 必须匹配、配置了 `approvers` 时必须是其中之一。表单提交走按钮 `name` 里的关联 id（见 PLATFORM-NOTES）。

超时前的提醒走**整卡重写**（`updateCard` + `buildDecisionCard`）。决策卡没有 `streaming_mode`，不是流式卡，对它做元素写入只会拿到 300309——那是一条注定失败的路径，原来还被 `.catch(() => {})` 吞掉，日志里什么都不留。

### 4.5 进度卡片

todo 与 goal **跨回合存活**，所以是独立卡片实体，不是回合卡的一部分：

```
session/event: todo/write → ProgressCards.showTodos() → 首次 createCard+sendCard，之后 updateCard 同一个实体
session/event: goal/change → showGoal()  同上；clear 墓碑（无 goal 快照）直接忽略，留最后一张卡当历史
```

goal 卡片按钮 → `onCardAction` → `applyGoalOperation()` → **真正调用 `ctx.goals.pause/resume/clear`**，再用返回的新快照重绘（不是本地改数字）。

### 4.6 子代理名册

子代理的**会话**不在这里服务（见 §3 的告警），所以名册只能从委派方自己的事件建立：

```
session/event: tool/call   （name 是 subagent 时）
  → SubagentRoster.note(sessionId, data.callId, name, data.arguments)
      行的标签取 description → label → prompt 里第一个非空者，状态 running
  → ProgressCards.showSubagents()   每个聊天一张卡，首次 createCard+sendCard，之后 updateCard

session/event: tool/result （data.message.toolCallId 回指那次调用）
  → SubagentRoster.settle(sessionId, toolCallId, { text, failed })
      failed                 → failed
      text 以 "started" 开头  → 仍是 running，加注"后台运行中"，
                               并从 `started subagent <id>` 里记下 childId
      否则                   → completed
  → ProgressCards.showSubagents()

session/event: subagent/catalog （父会话自己持有的持久事实，形如
                                  {childId, childCreatedAt, mode, label}）
  → SubagentRoster.linkChild(sessionId, childId, label)
      给还没有 childId 的 running 行点名：先按 label 匹配，再退回最新的等待行
  （卡片内容不变，不重写）

session/event: user/message  （source.kind === 'subagent-settled'）
  → SubagentRoster.finishChild(sessionId, source.senderSessionId, source.summary)
      senderSessionId 就是 childId，只结算等待该 id 的那一行
  → ProgressCards.showSubagents()
```

卡片形态：`🤖 子代理 已完成数/总数`，每行 `⏳/✅/❌ **任务** · 进行中/完成/失败（· 原因）`，最多 8 行 + `…还有 N 个`；全部落定才转绿，其中有失败则转红。

**为什么用 `callId` 关联而不是"最后一个 running 的行"**：一个回合可以同时委派多个子代理，结果到达的顺序不保证；只有回指的 `toolCallId` 能让每个结果只结算它自己那一行。

**后台子代理的结局由平台自己的通知结算**：`started …` 那一行不会被判完成，但也不能永远挂着。父会话里有两件事可以接上——`subagent/catalog` 按 id 点名刚建出来的子代理，子代理结束时平台又以 `user/message` 的形式发来一条通知，其 `source.senderSessionId` 就是同一个 id。`finishChild()` 只认这条通知，并按它 `summary` 的句式判成功或失败（`settlementSummary()` 在 `@deepseek-ai/dsh-subagent` 里只有一句是成功；读不懂的句式一律判失败）。**没有任何"猜一个完成"的路径**：名册宁可不更新，也不写一个自己纠正不了的结论。

**每张进度卡一条写入链**：`ProgressCards` 把 `${sessionId}\0${kind}` 映射到链尾 Promise，同一张卡的写入按到达顺序排队，所以"建卡"只发生在队列的第一个写入里，后面排队的快照落地成 `updateCard`。名册天然会踩这个竞态——`tool/call` 刚建好卡，"后台运行中"的改写就在 48 毫秒后到了。

## 5. 关键不变量

改动代码时这些必须继续成立，`test/offline.mjs` 里有对应断言：

| 不变量 | 为什么 |
| --- | --- |
| **`element_id` 必须匹配 `^[A-Za-z][A-Za-z0-9_]{0,19}$`** | 违反时平台**整卡拒绝**（300301），用户看到的是"什么都没有"。断言覆盖全部构造器 |
| **卡片 JSON 里绝不能出现 `action` 标签** | V2 已移除该容器（200861），按钮必须是 `body.elements` 的直接元素 |
| **实时 delta 与已提交正文分开累加** | 两者描述同一段文本；相加会让每句答案印两遍 |
| **`begin()` 幂等且并发安全** | 入站消息与 `turn/start` 几乎同时触发，否则会开两张卡 |
| **`sequence` 严格递增，每个 `card_id` 一个计数器** | 平台强制；计数器归 `feishu.js` 独有 |
| **同一张卡的写入必须串行** | 两笔并发写按"到达顺序"比 `sequence`，乱序到达就是 300317 |
| **流式会话会过期，必须能识别 200850 / 300309 并续期** | 平台在开启 10 分钟后关闭流式模式，写不会顺延；不续期就静默停更 |
| **元素写入失败必须降级，不能放弃整张卡** | `card.update` 不依赖流式模式；放弃等于让用户盯着不动的卡 |
| **不写空内容、不写未变化的内容** | 空内容写入被平台拒绝（HTTP 400）；重复写浪费 sequence |
| **一行叙述必须读出"这一笔在做什么"** | `targetOf()` 的键表漏了工具真正传的键（`url`/`name`）时，用户看到的就是一个光秃秃的工具名 |
| **过程面板里的两股内容必须靠编号或标题分开** | 思考与工具相邻堆放时，多段思考读起来是连续一段，分不清哪句属于哪一步 |
| **一张进度卡在同一时刻只能有一个写入在飞** | 建卡要一次往返，而喂卡的事件常常比它更快（`tool/call` 建卡、48 毫秒后 `started …` 的结果就要改写它）；没有这条，第二份快照会在第一张卡还没拿到 id 时再建一张，双胞胎里那张永远停在第一帧 |
| **子代理名册只由被服务会话自己的事件建立** | 子代理自己的会话不在这里服务（`subagent/descriptor` 一律被 `serves()` 挡掉），host 的 `subagent/start\|end` 又不带委派会话；可用的是本会话的 `tool/call` + `tool/result`、父会话持有的 `subagent/catalog`，以及子代理结束时发到这里的 `subagent-settled` 通知 |
| **结果以 `started` 开头的委派不算完成** | 后台/可续跑的子代理在子代理仍在跑时就返回；标成完成是这张卡永远无法纠正的谎 |
| **子代理的结局只由平台的结算通知判定，读不懂的句式判失败** | 只有 `finished and will do no further work` 是成功；把"没读懂的结尾"当成功，等于让卡片替平台宣布一件它并不知道的事 |
| **头部/决策块变化必须走整卡 `card.update`** | 它们不是可寻址元素，元素写入够不到 |
| **waterfall 里的纯观察者必须 `next()`** | 不交还会吞掉宿主或其他插件的处理 |
| **叙述/通知的格式化失败不能抛** | 叙述出错不该毁掉一个正在跑的回合（都包了 try/catch） |
| **反应换挡必须先删后加** | 飞书反应是**叠加**的，不删就会堆一串表情 |
| **反应终态一次性** | `DONE` 之后不能被迟到事件拉回 `THINKING` |

## 6. 设计取舍记录

**为什么用会话事件而不是 Cordis `workflow/*` 事件**
后者只带 `runId` 和 `meta`，**完全不带会话**——收到的表层无法判断它属于哪个聊天。HFC 因此维护 `runId → chatId` 映射，而运行开始前到达的行只能丢弃。会话事件既持久又天然带会话归属。

**为什么过程面板运行中展开、完成后折叠**
折叠状态下内容写进去了但看不见——用户会以为"什么都没发生"。运行中展开才有实时感；完成后正文优先，面板折起来。

**为什么过程面板里要给思考编号、给工具时间线加标题**
面板里两股内容的语义完全不同：`reasoning` 是模型对**当前这一步**的想法，`activity` 是**这一步做了什么**。原先两者直接相邻堆放，一个回合里有几段思考就糊成连续一大段——读者分不清哪句话属于哪一步。现在每段思考带 `**思考N**`（`numberedReasoning()` 连续编号、空段跳过，**进行中的那段也带编号**，所以它落定时编号不会变），工具时间线整体带 `**工具调用**` 前缀，两者之间插一个恒存在的 `hr`（`ELEMENTS.processSep`）。刻意用**恒存在**的元素而不是按需插入：流式期间节点位置一变，客户端布局就跳。标题在 `#elementContent`（流式元素写）和 `document()`（终态整卡写）**两处都套**，否则面板会在"流式中"和"终态"之间换脸。

**为什么工具行必须自带内容，后台任务的 label 必须压缩**
一行叙述的价值全在"这一笔在做什么"：`🔧 \`compress\`` 与 `🗜️ \`compress\` 4 段 · m00001–m00004 会话背景` 差着一次点击。所以 `targetOf()` 的键表要覆盖各工具**真正传参**的键（`url`、`name`…），没有路径也没有命令的工具（`compress`）要有自己的分支 `compressedRanges()`。同理，`job.label` 是**整条 shell 命令**——它适合日志，不适合卡片；`jobLine()` 把它压成单行 ≤80 字符并前缀任务 id。

**为什么规划里正文永远在过程上面**
读者要的是答案。把过程堆在顶上会让每次回复都从滚动开始。

**为什么 `cwd` 不能用 `process.cwd()`**
宿主进程的 cwd 是 harness 安装目录。静默把编码 agent 指向正在运行的 harness，是典型的"意外自伤"默认值。所以配置缺失时会**排除宿主目录**后取第一个工作区，并在日志里说明选了哪个。

**为什么决策内嵌而不是另发一张卡**
审批/提问属于它打断的那个回合。另发一张卡会让读者在两条消息之间来回对，且上下文断裂。

**为什么二维码流程不能被 await**
它要轮询到有人扫码为止。在 `apply` 里 await 会把插件激活挂住不返回。所以它作为后台任务跑，通过 effect 与插件生命周期绑定。

**为什么 `/new` 需要落盘而其他绑定不需要**
派生 id 让重启恢复免费；但 `/new` 的语义就是"换一个 id"，这个意图无法从会话派生出来，只能记下来。

**为什么 `textSizes` 限定取值集合**
平台**不校验** `text_size`——包括不存在的值也返回成功。所以"API 接受"不等于"有效果"，配置项必须限定在已知能渲染出差异的集合内。

## 7. 扩展点

**加一个阅读预设**：在 `card.js` 的 `PRESETS` 加一项，键加进 `config.js` 的 `readingPreset` union，`test/offline.mjs` 的"每个预设把答案放在过程上方"断言会自动覆盖它。

**加一个卡片元素**：在 `ELEMENTS` 加 id（**只能用字母数字下划线、首字母、≤20**），在构造器里放进去，`invalidElementIds` 断言会自动校验。若需要流式写入，确保 `turn.js` 的 `#elementContent` 认识它。

**加一个通知源**：在 `notice.js` 加一个纯格式化函数（可离线测试），在 `Notices` 加一个方法，在 `index.js` 接线。注意区分"回合内进面板"与"回合外发卡"。

**改设置表单**：宿主侧只改 `lib/config.js`（`.description()` 就是表单里的说明）；表单本身在 `client/client.js` 的 `GROUPS` 里维护，**两处都要加**——schema 是校验契约，`GROUPS` 是给人看的。字段名两边必须一致。

**一个字段必须在 schema 里标记为 `.volatile()`，否则它在设置页里根本不存在。** 宿主把插件的 Config 投影成"可实时应用的字段"（`dsh-settings` 的 `volatileForm`），**其余字段一律丢弃**；如果没有任何 volatile 字段，投影返回 `undefined`，该条目被 `settings.describe()` 跳过，命名空间永远到不了浏览器，页面只能报"命名空间未暴露"——**而且不产生任何日志**。所以 `.volatile()` 不是可选修饰，它是设置页存在的前提。

volatile 同时也是字面意思：loader 把新值**原地写进活 schema** 并发出 `loader/volatile-update`，**不重启插件**。所以插件必须监听该事件重新读取配置，否则 UI 显示新值、行为还是旧值。

`lib/config.js` 里 `stateDir` 与 `onboarding` 刻意**不**标记 volatile：它们在挂载时读取一次，做成实时设置是撒谎。代价是它们不出现在设置页——这是有意的取舍，不是遗漏。

关于设置页挂在哪一级，三条约束都是从宿主源码读出来的，不是猜的：

| | 值 | 依据 |
| --- | --- | --- |
| slot | `plugins.bundle.config` | 本插件是单行 bundle，配置属于插件本身；`plugins.row.config` 是给"多行 bundle 里某一个组件"用的 |
| key | `dsh-feishu-card`（包名） | bundle 级 slot 按包名键控；行级才是 `<包名>#<rowId>` |
| 命名空间 | `feishu-card`（**裸 patch id**） | `settings.describe()` 用 `entry.options.id`，而 Config inspect 里 `patchId = entry.options.id`、`id = entry.id`（后者是 `include:feishu-card` 这个 loader 目录键） |

还有一个容易踩的差别：**bundle 级页面只收到 `view`，不收到 `form`**（行级才传 `form`）。所以 bundle 级必须自己从 `configForms` 服务按命名空间取表单并订阅它的快照。

**加一个 agent 级工具**：在会话阶梯的 post-reach 钩子里用 `agent.ctx.effect(() => tools.register(...))` 注册，并**按 agent 实例**（WeakSet）去重——会话可能比 agent 活得久。`defineTool` 来自插件解析不到的包，所以直接传标准 JSON Schema；代价是参数校验得自己写。

**加一个 `session/event` 处理**：在 `index.js` 的 switch 加 case。**先确认该事件真的存在**——见第 3 节的 module augmentation 陷阱。

**接一个新的瀑布**：确认模式（waterfall / emit / serial）与是否 async。纯观察者必须 `next()`。
