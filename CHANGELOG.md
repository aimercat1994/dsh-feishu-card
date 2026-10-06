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

断言 147 → 157。

### 出站文件的真实首测：功能通过，但我对它的安全描述是错的

**功能通过**：agent 用 `send_file` 把 README.md（13593 字节）作为附件发到了聊天里。上传与发送两段真实 API 都跑通了。

**但拒绝测试暴露了一个我判断错的地方。** 我让 agent 发 `/etc/hostname`，预期它被拒绝。实际它**没有被拒绝**：它先把文件复制进工作区（`hostname.txt`，12 字节，与 `/etc/hostname` 逐字节一致），然后发那个副本。日志里 `refused to send` 一次都没出现。

原因很直白：agent 本来就有文件工具，本部署又是 `danger-full-access`，所以"能读什么"就等于"能发什么"。它甚至可以直接把文件内容打在聊天里——`send_file` 并没有新增任何*访问*能力，只是多了一种交付形式。

所以我在实现说明和给用户的报告里写的"`allowedFileDirs` 把 egress 限制在工作区内"**是错的**：那条白名单只约束 `send_file` 自己的参数，不约束 agent。真正的边界是**部署的文件策略**与**审批**。只有在文件策略本身受限（如 workspace-write）时，这条白名单才真正收紧口子。

已按事实改写 README（含一段显式警告）、docs/DEVELOPMENT.md 的限制表与 docs/ARCHITECTURE.md 的模块说明。功能本身保持默认开启——它没有引入新的暴露面。

**另一处仍未验证**：拒绝路径从未在真实链路触发过（agent 走了复制路线），目前只有离线断言。

### 安装说明修正：把开发步骤当成了安装步骤

用户反馈"GitHub 上的安装方式太复杂"。查下来是我文档写错了，而且错得具体：

1. README 把 **`pnpm install --prod` 当成安装的必要步骤**——那一步其实**只对 `link:` 本地开发路径才需要**。
2. 文档里的 `dsh plugin --profile web add …` **在这个部署里根本跑不了**：`/usr/local/bin/dsh` 这个 shim 指向不存在的 `src/deepseek-harness/apps/cli/lib/bin.js`。
3. 这个部署真正的安装通道是**插件管理界面**（profile 里已装 `dshmarket`，一个可视化插件市场）。

实测了 `github:` 规格（在隔离的临时目录里，不动现有 profile）：

```
pnpm add github:aimercat1994/dsh-feishu-card
→ 57 个包一并装好
→ @larksuiteoapi/node-sdk / @deepseek-ai/schemastery / qrcode-terminal 全部就位
→ FeishuTransport 构造成功，方法齐全
```

所以**一步就能装好**，不需要先手动装依赖。README 已改为：插件管理界面填 `github:aimercat1994/dsh-feishu-card` → 重启；开发路径单列，并说明为什么只有它需要 `pnpm install`。

**过程中的一个测量陷阱值得记**：我先用 `createRequire(<符号链接路径>)` 探测依赖，三个全报 `MODULE_NOT_FOUND`，差点得出"git 安装不带依赖"的错误结论。实际上 pnpm 把包放进 `.pnpm/` 虚拟存储、依赖只放在**真实路径**旁边，而 Node 解析会先 realpath——用符号链接路径做 CJS 探测是假阴性。改成直接 `import()` 一次就对了：模块加载成功，`FeishuTransport` 构造成功。

### 发布 v0.1.0

首个 release：https://github.com/aimercat1994/dsh-feishu-card/releases/tag/v0.1.0

发布后逐项核对，而不是只看创建接口的返回：

- tag `v0.1.0` → commit `a364752`，与本地 HEAD 一致
- release tarball **匿名**可取（HTTP 200）——证明它确实公开
- **锁定版本的安装规格实测可用**：`pnpm add github:aimercat1994/dsh-feishu-card#v0.1.0` 在隔离目录里装成功，`FeishuTransport` 构造正常

Release 说明里专门列了「**未验证**」那一节（`denyTools` 运行时、`approvers`、`send_file` 拒绝路径、群聊作用域），因为开发过程中被"看起来在工作、其实没有"坑过三次——把没验证的说成验证过的，正是那种坑的成因。

### 设置界面（插件管理页里的配置表单）

用户要求在内置插件界面里配置本插件（默认工作区、飞书连接等）。

**先搞清机制，再动手。** 调查结论：设置页渲染的是"由 Host 插件注册的分区"，而插件管理页的 `plugins.row.config` 是一个 **keyed slot**，key 为 `<包名>#<rowId>`；管理页只**声明**这个 slot，配置页必须由插件自己的客户端一半注册。所以这不是"填个 schema 就有了"，而是需要写浏览器一半。

**宿主侧**：27 个配置项全部补上 `.description()`。设置页是 schema 驱动的，**没有 description 的字段会渲染成一个没有标签的输入框**——这是之前完全没有的东西。

**客户端侧**（新增 `client/client.js`）：手写、免构建，宿主原样提供 `exports["./client"]`；直接用 `React.createElement`，避免存在一个会被忘记运行的转换步骤。注册 `plugins.row.config`，处理 owner 传入的两种视图（`summary` 卡片一行 / `page` 表单）。表单**按语义分组**而不是把校验用的 schema 直接铺开——那个 schema 是深层的 `anyOf` + loader 表达式，铺成表单没法用。密文字段按 `RedactedSecret`（`{path,set}`）处理，留空即不修改；改动收集成 ops 一次性 `form.mutate`，带 revision 栅栏。

**验证方式**（无浏览器）：宿主把客户端模块图注入首页的 `__DSH_BOOT__`。解析它 → 我的条目在 75 个条目里、url 为 `plugins/??dsh-feishu-card/client.js&rev=…` → 取该 URL 得 HTTP 200 且内容**逐字节等于**源文件（只多一行 sourcemap 引用）。链路成立。**渲染效果与写入行为仍未验证**——没有浏览器，这两项只能由人看。

**测试新增 5 项**：客户端声明、row key 与 patch 行 id 一致、slot 名、两种视图、module loader 形态。row key 不匹配的失败形式是"配置按钮永远不出现"，静默且其他断言都看不见。

断言 157 → 162。

### 修：配置页永远停在「正在读取配置…」

第一次实现挂在了**行级** slot（`plugins.row.config`，key `dsh-feishu-card#feishu-card`），并依赖 owner 传进来的 `form`。用户点进去后一直转圈。

排查出**三个**独立问题，都从宿主源码读出来，不是猜的：

**① 挂错了层级。** 本插件是单行 bundle，配置属于插件本身，该挂 `plugins.bundle.config`（按**包名**键控）。`plugins.row.config` 是给"多行 bundle 里的某一个组件"用的。参照实现 dsh-mnemon 正是两级都注册：bundle 级放插件设置，行级放各组件设置。

**② bundle 级根本不传 `form`。** 两级的渲染调用不同：

```js
renderSlot("plugins.row.config",    { view: "page", form }, …)   // 行级：owner 给值
renderSlot("plugins.bundle.config", { view: "page" }, …)         // bundle 级：只给 view
```

所以 bundle 级页面**必须自己取配置**——mnemon 用 `configurationServices()` / `ctx.configForms`；我之前依赖 `form` 就注定拿不到，而拿不到的表现恰好和"正在加载"一模一样。

**③ 命名空间是裸 patch id，不是 loader 目录键。** 这个也钉死了：

```js
// dsh-tool-cordis/lib/types/config.js
const { id, name } = entry.options;
const listed = { id: entry.id, patchId: id, name };   // patchId = entry.options.id
```

而 `settings.describe()` 用 `entry.options.id`。所以命名空间是 `feishu-card`，`include:feishu-card` 只是 loader 目录键——**用错形式会什么都找不到，且没有任何报错**。

**顺带把失败态拆开。** 原来三种完全不同的情况共用一句"正在读取配置…"：拿不到表单（命名空间没暴露）、`unavailable`（连接是 memory 模式）、`loading`（还没到）。现在各自有各自的文案——把"没有拿到表单"也显示成加载中，正是它让我第一轮没法从用户反馈里判断是哪种，白绕了一圈。

断言 162 → 164（新增：bundle 级 + 包名 key、命名空间必须是裸 patch id、必须自取表单）。

### 修：设置页的根因——只有 volatile 字段会出现在表单里

上一步改成 bundle 级、自取表单之后，用户看到的仍然是我的诊断文案：`没有拿到配置表单：客户端未暴露命名空间 "feishu-card"`。这条文案（把三种失败态拆开）直接把我引到了正确的地方。

**根因在 `dsh-settings` 的投影函数里：**

```js
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema);
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child);
      return field === void 0 ? [] : [[key, field]];   // 非 volatile 字段被丢弃
    }));
    return Object.keys(dict).length === 0 ? void 0 : z.object(dict);   // 空 → 整条被跳过
  }
}
```

宿主只投影**可实时应用的字段**。我的 schema 一个 `.volatile()` 都没有 → 投影返回 `undefined` → `describe()` 跳过该条目 → 命名空间永远到不了浏览器。**而且全程没有任何日志。**

**volatile 是字面意思**：loader 的 `_commitVolatile()` 把新值原地写进活 schema，然后发出 `loader/volatile-update`，**不重启插件**。参照实现 dsh-mnemon 正是这么做：把字段逐个 `.volatile()`，再监听该事件。

**修法**（照参照实现）：

- `lib/config.js`：除 `stateDir` 与 `onboarding` 外全部标记 volatile。这两项在挂载时读取一次（日志文件、凭据存储、二维码流程），做成"实时设置"是承诺一个做不到的效果——代价是它们不出现在设置页，这是有意取舍
- `index.js`：监听 `loader/volatile-update`，重新 `resolveConfig`。凭据变更**重建长连接**（`transport.stop()` → `updateCredentials` → `startChannel()`），`cwd` 变更重建 workspace filer 让**新会话**用新目录；其余字段本来就按次读取，自动生效

**顺带被新断言抓到一个真问题**：我的表单里放了 `stateDir` 和 `onboarding`，但它们在投影里不存在——控件会显示空白、保存的值永远读不回来。已从表单移除，并加了一条断言：**表单字段集合必须恰好等于 schema 的 volatile 字段集合**。这条断言当场又抓出 `maxFileBytes` 有 schema、无控件。

断言 164 → 168（新增：字段必须是 volatile 或已登记的挂载期字段、volatile 数量下限、每个字段必须有 description、表单与 volatile 集合一致、插件必须监听 volatile-update）。

**教训**：这个功能的失败方式是"页面能打开、只是永远在加载"，而且宿主一声不吭。我绕了两轮才想到去看投影函数——**应该先读宿主怎么决定"显示什么"，再写"显示什么"**。


### 修：volatile 字段是**引用**，不是值（`cwd=[object Object]`）

标记 volatile 之后立刻出现新回归：启动日志里 `cwd=[object Object]`，工作区归档报 `The "path" argument must be of type string. Received an instance of Object`。

原因：**volatile 字段校验后不是普通值，而是引用节点**。loader 为了让活 schema 可被原地改写，给 volatile 字段发的是 `{get, set}` 引用；所以读 `config.cwd` 拿到的是对象，不是路径。宿主的 `dsh-settings` 自己就用 `plainConfig()` 解包——插件跳过这一步就会到处看到引用。

`plainConfig` 的判定是 `write in value`，而那个 `write` 是 `Symbol.for("cosmokit.volatile.write")`——**全局注册符号**，注释写明用途是"Identify references across ESM/CJS copies"。所以本插件可以精确复刻这套判定，而不必依赖一个解析不到的包（`@deepseek-ai/cosmokit` 不在本插件的解析链上）。

修法：`resolveConfig` 入口处先 `plainConfig(rawConfig)`，之后所有消费者照旧拿普通值。新增 5 条断言，其中一条是端到端的：`resolveConfig(Config({}))` 的每个字段都必须是普通类型、且序列化后不含 `[object Object]`——正是这条本该在上一轮就拦住回归。

断言 168 → 173。

**这一轮的两个教训**：① 该先读宿主**怎么决定显示什么**，再写显示什么；② 宿主的"可实时应用"配置不是值而是引用——文档里没有，但 `dsh-settings` 的 `plainConfig` 就是答案，找现成实现比读文档快。


---

## 未完成


### 修：入口组件只转发了 `form`，把 `configForms` 服务丢了

volatile 修好之后仍然报"命名空间未暴露"。这次读了 `configForms` 的实现：

```js
get(entryId) {
  const existing = this.forms.get(entryId);
  if (existing !== void 0) return existing;
  const form = new ConfigFormController(this.owner, { namespace: entryId }, …);
  this.forms.set(entryId, form);
  this.mirror.ensure();
  return form;          // ← 永远返回一个表单，从不返回 undefined
}
```

**它从不返回 `undefined`**，所以"命名空间未暴露"这个诊断本身是错的——真相是 `props.configForms` 是 `undefined`，于是我的 `resolveForm` 退到 `props.form`（bundle 级页面没有），最终返回 `undefined`。

根因是我的入口组件：

```js
function FeishuCardConfig(props) {
  if (props.view === 'summary') return h('span', …)
  return h(ConfigPage, { form: props.form })   // ← 只手挑了一个字段转发
}
```

slot 注入的服务是作为 **props** 到达入口组件的，手挑子集转发就会**静默丢掉其余的**——丢掉 `configForms` 正是这一处。改成转发整个 props 对象。

**我那条断言也太弱**：它只断言源码里出现过 `configForms`（而它出现在 `resolveForm` 里，所以通过），没有断言这个服务真的流到了页面。现在断言入口必须是 `h(ConfigPage, props)`，且禁止手挑字段的写法。

**教训**：诊断文案是我自己写的，它把"服务没传进来"说成了"宿主没暴露命名空间"——**一个错误的诊断比没有诊断更贵**，它让我去查宿主，而问题在我这边。文案应当只陈述观察到的事实（"没拿到表单"），不要替我推断原因。


---

## 未完成

- `send_file` 拒绝路径的真实触发（实测时 agent 走了"复制进工作区再发"的路线）
- `denyTools` 守卫与 `approvers` 的运行时实测（两处都需要一个能真实触发它们的场景）
- `output: cot`（飞书原生思考消息）模式
- 多问题合并表单
- 契约断言目前只覆盖 transport 一层；其他协作对象（renderer 等）的假对象仍可能掩盖同类问题