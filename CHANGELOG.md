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


### 修：飞书会话在工作区面板里显示为「未分组」

`sessionController.create({sessionId, cwd})` 只把 cwd 写进会话自己的 `meta.cwd`，**并不会把会话挂到工作区记录上**。UI 是按**工作区注册表**归组的，成员关系是另一层关联，必须调用 `Workspace.attachSession(sessionId)`。

核实过：`aimercat` 工作区有 17 个会话、`feishu-*` **一个都没有**，而飞书会话在磁盘上确实位于正确的 cwd 目录下——目录对了，成员关系缺失。

修复：

- 在会话阶梯的**两条路径**上都调用工作区归档（create 与 resume）。放在 resume 上是刻意的：这样**修复前就已存在的会话**在下一条消息时会被补挂，而不是永久滞留
- 启动时 `adoptExisting()` 归档已知的轮换会话（`/new` 产生的），不必等它下一条消息；会话已不存在则跳过，不重建
- 工作区解析结果缓存、每个会话每次进程只写一次；`resolveByPath` 未命中则 `create`
- 归档是纯展示关注点：任何失败只记日志并吞掉，绝不影响对话

顺带又一个 typo 级教训：新私有方法取名 `#file`，与已有的 `#file()`（bindings 路径）**撞名**，`node --check` 直接报重复声明。

### 授权收窄：抽出为可测模块，并让拒绝可见

这一项原本的状态是"代码写了但从没验证过"，而且两处判定都**内联在 `index.js` 里**（测不到），被丢弃的消息**不写任何日志**（无从诊断）。同一个"静默失败"模式在这个项目里已经出过两次，所以这次按它的反面来做：

**`lib/guard.js`** —— 工具守卫
- `denialReason()` 纯函数。关键取舍：**只有确实在拒绝名单里的具名工具被拒**，畸形/空执行一律放行——对垃圾输入返回拒绝会破坏进程内其他所有工具
- `installToolGuard()` 在注册表无法接受守卫时**明确告警**，而不是留一个"以为拦住了"的假象
- 用 `guard` 而不是 `restrict`：`restrict` 把工具从模型 schema 里抹掉，模型根本看不到；`guard` 能在调用时**带理由拒绝**，聊天渠道要的是后者
- 注册点从"仅 `agent/created`"扩到"`agent/created` + 会话阶梯的 post-reach 钩子"，且按 **agent 实例**（WeakSet）而非 sessionId 记账——会话可能比 agent 活得久

**`lib/access.js`** —— 入站准入
- `admit()` 纯函数，覆盖 5 种丢弃原因（非用户 / 群不在名单 / 发送者不在名单 / 未 @ / 空正文）
- 强调语义：**空名单 = 不限制**，不是"全拒"（这是最容易写反的地方）
- `isPolicyDrop()` 区分"策略拒绝"与"普通流量"：群里未被 @ 的消息不该刷日志
- 策略拒绝现在写日志（chat + sender），被丢弃的消息不再无迹可寻

**验证状态（诚实记录）**：逻辑与注册点已离线覆盖；`denyTools` 默认名单为空（用户决定：与 GUI 同权限），所以**守卫的运行时拒绝路径从未被真实触发**。要依赖它之前需实测一次。`approvers` 同理——本部署是 `danger-full-access`，审批从未被触发。README 与 docs/DEVELOPMENT.md 的限制表已按此更新，而不是含糊地说"未实测"。

断言 114 → 129。

### 图片输入（默认开启）

- 解析 `image` 与 `post`（多图文）两类消息；`post` 的嵌套节点递归取文字与图片
- **类型靠字节头嗅探**：飞书返回图片资源时不带 content type，猜错会被附件服务按"声明类型不符"拒绝，等于每张图都失败。支持 PNG/JPEG/GIF/WEBP 的 magic bytes
- 逐张处理，**失败只损失那张**：下载失败、格式不支持、超部署策略都会单独说明，用户文字照常送达；发送前 `attachments.validateImage` 预校验，避免策略拒绝把整条 prompt（含文字）一起打回
- 有界流收集（按附件策略的 `maxImageBytes`），避免一个错标资源把消息变成内存耗尽
- 图片没有配文也算消息——空正文判定补上了媒体条件
- 否则不支持的入站类型（文件/音频/表情包）会**回一句说明**，而不是像以前那样静默丢弃

**过程中自己引入又修掉的一个真 bug**：把"不支持的类型"回执放在了发送者过滤**之前**——另一个机器人发的文件会让我的机器人回它一句，两个机器人可以这样永远对答下去；而且那时 `readInboundMessage` 对不支持类型只返回 `{chatId, unsupported}`，连 `messageId` 都没有，回执根本不会串到原消息上。现在策略门（发送者/白名单）先过，回执才有资格发出，并补了一条断言把顺序固定下来。

### 图片链路的真实首测：两个 bug

第一次在飞书里发真图就翻车了，两个都是真 bug：

**① `collectStream is not defined`。** 给 `lib/feishu.js` 加 media 导入的那段补丁，锚点写的是 `import { createLogger } from './log.js'`——**这个文件根本没有这行**（它的 logger 是构造参数，不 import）。`str.replace` 没匹配就原样返回，而脚本**没有 assert 就打印了"已修补"**。于是 `feishu.js` 引用了 `collectStream` / `parsePostContent` / `sniffImageMediaType` 三个符号却一个都没导入。

**这和当初反应反馈那个 bug 是同一个失败模式，连原因都一样**：编辑脚本静默匹配失败 + 没断言。我甚至刚写完"假 transport 掩盖问题"的反思就又犯了一次——因为这次掩盖它的是**另一个盲区**：我验证了 `typeof c.im.v1.messageResource.get === 'function'`（SDK 表面），却没验证**自己模块里的符号是否解析得到**。`node --check` 只做语法解析，看不见未导入的标识符。

**② `prompt content must include non-whitespace text or an attachment`。** 图片下载失败后，纯图片消息组装出的 `content` 是空数组，宿主直接拒绝。用户看到的是平台内部错误文案。修复：内容为空时不再发起 prompt，改用渠道自己的话说明。

**防复发**：新增静态交叉检查——扫描 `index.js` + `lib/*.js` 里对**其他模块导出符号**的裸引用，断言每处都有对应导入。它同时覆盖静态 `import {} from` 与动态 `const {} = await import()`，并排除注释、属性访问（`obj.x`）与对象键（`x:`）。

我验证过它**不是空转**：把 `feishu.js` 的 media 导入删掉 → 报出三个符号；把 `notice.js` 的动态导入注释掉 → 报出 `buildNoticeCard`。这条断言如果早存在，两个 bug 都进不了运行时。

断言 146 → 147（新增一条覆盖面很宽的检查）。

**仍未验证**：修好后的图片链路。等下一次真实发图确认。

断言 129 → 146。

### 出站文件（`send_file`）

agent 可以把工作区里的文件作为附件发到当前会话。

- **路径检查先 realpath 再比较**。只比对未解析路径的前缀是这个功能最典型的漏洞：工作区里一个指向外部的符号链接就能把文件带出去。测试里专门造了这个场景（链接文件 + 链接目录两条路径），两者都必须被拒
- `isInside()` 按**路径分段**比较，不是字符串前缀——否则 `/a/bc` 会被判为在 `/a/b` 内
- 工作区始终可发：这不增加文件访问（agent 本就能读），只增加"把读到的东西交出来"的能力；其他目录要显式配 `allowedFileDirs`
- 逐条拒绝并说明原因：不存在 / 不是普通文件 / 空文件（平台不收）/ 超上限 / 不在允许目录
- 空字符串路径会被拒绝，**不会**被 `resolve` 成 cwd（否则等于悄悄发送一个目录）

实现取舍：`defineTool` 来自插件解析不到的包（`@deepseek-ai/dsh-tools`），而它本身也只是把自己那套扁平 spec 转成 JSON Schema，所以直接传标准 JSON Schema。代价是参数校验要自己写——这也是为什么 `execute` 里的检查读起来像在跟模型说话。

顺带把 `agentRegistrations` 从 `sessionId → 单个 disposer` 改成 `sessionId → disposer 数组`：守卫和工具都是 per-agent 注册，单值会让后注册的覆盖掉前一个。

断言 147 → 158。

---

## 未完成

- 出站文件的真实链路验证（离线已覆盖含符号链接逃逸，但上传/发送两段只跑过假 transport）
- `denyTools` 守卫与 `approvers` 的运行时实测（两处都需要一个能真实触发它们的场景）
- `output: cot`（飞书原生思考消息）模式
- 多问题合并表单
- 契约断言目前只覆盖 transport 一层；其他协作对象（renderer 等）的假对象仍可能掩盖同类问题
