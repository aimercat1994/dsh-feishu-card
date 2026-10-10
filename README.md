# dsh-feishu-card

> 把 DeepSeek Harness 的每个回合，变成飞书 / Lark 里一张持续更新的交互卡片。

这是 [hermes-feishu-streaming-card](https://github.com/baileyh8/hermes-feishu-streaming-card)（下称 **HFC**）的卡片体验在 **DSH 上的独立重写**：不是移植代码，而是把 HFC 的卡片信息架构重新实现为一个 DSH Host 插件。

**关键差别是架构。** HFC 需要在 Hermes 源码里打 17 个补丁并跑一个独立 sidecar 进程（约 64k 行基建：安装器、源码补丁、HMAC 事件鉴权、pidfile、systemd/s6/Docker 管理）。DSH 把同样的事件与交互都做成了原生 Event/Service，所以本插件是一个**同进程 Host 插件**：

- 不打补丁、不改宿主源码
- 没有 sidecar 进程、没有 IPC、没有 HMAC 传输层
- 不需要公网 callback URL（入站事件走应用的 WebSocket 长连接）
- 不需要进程 / 服务管理

| | HFC | dsh-feishu-card |
| --- | --- | --- |
| 形态 | Python sidecar + 源码补丁 | 同进程 JS Host 插件 |
| 事件来源 | 补丁进 Hermes 的 hook | `session/event` 等原生事件 |
| 审批 / 提问 | hook 轮询 `/interactions/{id}` | 原生 waterfall，直接返回结果 |
| 会话持久化 | sidecar 自己的检查点 | 宿主 session store（id 确定性派生） |
| 代码量 | 75,092 行 Python | 约 3,600 行 JS |

## 功能

**卡片**

- 一个回合一张卡片：头部（状态 + 实时动作一行）→ 正文 → 可折叠过程面板 → 页脚统计
- 思考与工具动作在**可折叠面板**里；正文永远在上（读者要的是答案）
- 工具动作按族分类带图标（📖 读取 / ✏️ 编辑 / 🔍 搜索 / ⚡ 执行 / 🌐 网络…）并带上目标文件
- 编辑类工具直接渲染 ```diff 块
- 四种阅读预设：`classic` / `focused` / `detailed` / `task`
- 页脚：耗时 · 工具次数 · 模型 · ↑输入 ↓输出 tokens
- `widthMode`（default/compact/fill）与逐区域 `textSizes`

**交互**

- 审批与提问**内嵌在同一张回合卡里**（正文下方、页脚上方），点选后原位留回执
- 提问三条件作答路径：选项按钮 / 直接回复文字 / 卡片内输入框（opt-in）
- 审批只认按钮

**状态**

- 用户消息上的反应反馈：`OK` → `THINKING` → `DONE` / `ERROR`
- 通知：模型重试、上下文用量、压缩失败、后台任务结束
- todo 与 goal **各占一张独立卡片、跨回合存活**；goal 按钮真正调用 `ctx.goals`
- 工作流 / 子代理扇出叙述

**图片输入**（`images`，默认开启）

- 直接发图片、或带图的多图文（`post`）都会被读取，最多 `maxImagesPerMessage` 张（默认 4，部署策略更小则以部署为准）
- 飞书返回的图片资源**不带 content type**，所以类型由字节头嗅探得出；猜错会被附件服务按"声明的类型不符"拒掉，等于每张图都失败
- 单张失败只损失那张图：下载失败、格式不支持、超出部署策略都会**单独说明**，用户输入的文字照常送达
- 发送前用 `attachments.validateImage` 预校验，避免策略拒绝把整条 prompt（含文字）一起打回
- 暂不支持的入站类型（文件/音频/表情包）会**回一句话**，而不是让消息无声消失

**出站文件**（`fileOutput`，默认开启；`send_file` 工具）

- agent 可以用 `send_file` 把**工作区里已有的文件**作为附件发到当前会话，用于交付产物
- **工作区始终可发**——这不增加任何文件访问权限（agent 本来就能读那里），只是让它能把读到的东西交出来
- 其他目录需显式配 `allowedFileDirs`（默认空）
- 路径检查是**先 realpath 再比较**：工作区里一个指向外部的符号链接会被拒绝。只比对未解析路径的前缀是这个功能最典型的漏洞

> ⚠️ **`allowedFileDirs` 不是安全边界，别把它当边界用。** 实测（2026-10-06）：让 agent 发 `/etc/hostname`，它**没有**被拒绝——它先把文件复制进工作区，再发那个副本。原因是它本来就有文件工具，在本部署的 `danger-full-access` 下能读任意路径，于是"能读什么"就等于"能发什么"。它甚至可以直接把内容打在聊天里。
>
> 所以这条白名单的作用是**约束 `send_file` 自己的参数**、避免误发莫名其妙的路径；真正决定 agent 能碰到什么的是**部署的文件策略**与**审批**。只有在文件策略本身受限（例如 workspace-write）时，这条白名单才真正收紧了口子。
- 逐条拒绝并说明原因：不存在、不是普通文件、空文件、超过上限、不在允许目录内
- 上限 `maxFileBytes` 默认 30 MB（平台硬限制，超过它平台也会拒）

**运维**

- 拒绝入站消息时写日志（`senderAllowlist` / `groupAllowlist` 命中会记录 chat 与 sender），
  被静默丢弃的消息不再是无迹可寻

- 二维码扫码建应用 + 自动订阅事件与回调（免手工配置开发者后台）
- **斜杠命令面板自动同步**：飞书输入 `/` 弹出的命令列表由应用级注册驱动，卸载插件**不会**清掉它注册过的命令。插件启动时把面板与**实际支持的命令**对齐（删掉不存在的、补上缺的、描述变了的就地更新），所以面板不会承诺已经失效的命令
- 本渠道自带 `/new`（含模式选择）、`/model`（含推理档位）、`/sessions`、`/switch`、`/permission`、`/status`、`/stop`、`/help`；其余 `/xxx` 整行**委派**给宿主 `commands` 注册表
- 选择一律用**抽屉式下拉**，卡片高度不随选项数量增长
- 日志落盘 `~/.dsh/dsh-feishu-card/dsh-feishu-card.log`
- 卡片路径失败时降级为纯文本，不会静默失败

## 前置条件

Node 18+、一个可用的 DSH profile。飞书侧**不需要手工配置**——首次启动走二维码注册流程。

若你更愿意手工建应用：

1. 启用**机器人**能力
2. **事件订阅**使用**长连接**（WebSocket）模式，不要填 HTTP 回调地址
3. 订阅事件 `im.message.receive_v1`
4. 订阅回调 `card.action.trigger`
5. 权限：`im:message`、`im:message:send_as_bot`、`im:message:readonly`、`im:resource`、`im:chat:read`、`im:message.reactions`
6. 把机器人加进目标群，或允许私聊

> ⚠️ **同一个飞书应用只能有一条长连接。** 如果同时启用了别的飞书渠道（例如 `@moyu-good/dsh-lark-bridge`），两者会争抢同一个应用的入站事件——**必须禁用其中一个**，或使用两个不同的应用。

## 安装

**一步装好，依赖会自动带上**（已实测：从 GitHub 安装会把本插件的三个依赖一并装好，插件能直接加载）：

在 Harness 的**插件管理界面**里，用安装规格：

```
github:aimercat1994/dsh-feishu-card
```

装完**重启一次 Harness**（模块在启动时加载）。

想锁定版本，用 release 标签（实测可用）：

```
github:aimercat1994/dsh-feishu-card#v0.3.3
```

当前版本 **v0.3.3** — [Release 说明](https://github.com/aimercat1994/dsh-feishu-card/releases/tag/v0.3.3) · [变更历史](CHANGELOG.md)

### 等价的命令行做法

在 profile 目录里执行：

```bash
pnpm add github:aimercat1994/dsh-feishu-card
```

`pnpm` 会把本插件的依赖（`@larksuiteoapi/node-sdk`、`@deepseek-ai/schemastery`、`qrcode-terminal`）一起装好，然后重启 Harness 即可。**不需要**先手动 `pnpm install`。

### 从本地目录安装（开发用）

改代码时要走这条，因为 `link:` 指向你的工作副本，改完重启就能生效：

```bash
cd dsh-feishu-card
pnpm install --prod          # ← 这一步只有 link: 安装才需要
# 然后在插件管理界面把该目录作为 link 装入，或写进 profile 的 package.json：
#   "dsh-feishu-card": "link:/绝对路径/dsh-feishu-card"
```

> ⚠️ **为什么 `link:` 需要单独装依赖**：以 `link:` 装入时，pnpm 不会安装该目录自己的依赖。缺 `node_modules` 的表现是插件 `failed to import` / 状态 `inactive`，而不是报缺哪个包——很容易误判成插件本身有问题。

### 关于 pnpm 的 protobufjs 告警

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs
```

这是 `@larksuiteoapi/node-sdk` 的传递依赖，它的 postinstall 只打印一句捐赠提示，**不影响使用**。想消掉告警：`pnpm approve-builds`。

### 首次启动：二维码建应用

没有凭据时插件会打印一条注册 URL，并写到 `~/.dsh/dsh-feishu-card/onboarding-url.txt`：

```
用飞书扫码（约 600s 内有效）：
https://open.feishu.cn/page/launcher?user_code=XXXX-XXXX&...
```

扫码确认后，凭据以 **0600** 权限写入 `~/.dsh/dsh-feishu-card/credentials.json`，插件自动连上。二维码过期会自动重发。日志出现 `connected to Feishu` 即成功。

### 改完代码必须重启 Harness

**禁用/启用插件不会重新加载代码。** Node 按路径缓存 ES module，toggle 之后仍跑旧模块（表现为改动毫无反应、配置项不生效）。这是本项目开发中踩过最久的坑，详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 配置

优先级：**行 config** > 进程环境变量。两者都没有且本地也无凭据时进入二维码流程。

环境变量：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=              # 国际版 Lark 填 https://open.larksuite.com
```

或在 profile 的 `cordis.patch.yml` 覆盖该行 config：

```yaml
- id: feishu-card
  config:
    appId: cli_xxx
    appSecret: xxx
    cwd: /absolute/workspace             # 新会话的工作目录
    sessionScope: chat                   # chat | chat-thread | chat-sender
    locale: auto                         # auto | zh | en
    requireMention: true                 # 群里是否需要 @机器人

    # 授权收窄
    senderAllowlist: []                  # 私聊白名单（open_id）
    groupAllowlist: []                   # 群白名单（chat_id）
    approvers: []                        # 谁可以点审批按钮；留空=按上面两条规则
    denyTools: []                        # 在飞书渠道禁用的工具名

    # 渲染
    readingPreset: classic               # classic | focused | detailed | task
    showProcess: true                    # 是否显示过程面板
    hideProcessWhenDone: false           # 回合结束后强制折叠过程面板
    widthMode: default                   # default | compact | fill（仅 JSON 2.0 卡片）
    flushIntervalMs: 400                 # 流式写入合并间隔
    reasoningTail: 2000                  # 过程面板只显示思考的最后 N 字（0=不截断）
    textSizes:
      reasoning: notation
      activity: notation
      answer: normal
      footer: notation

    # 交互
    approvalTimeoutSec: 300              # 审批/提问等待上限，超时按取消处理
    approvalReminderMs: 0                # >0 时在卡片上追加"仍在等待"提示
    cardInput: false                     # 是否在卡片内放输入框（默认关闭，理由见下）

    # 通知与反馈
    notices: true
    pressureWarnTokens: 120000           # 上下文用量告警阈值
    reactionFeedback: true               # 在用户消息上打状态表情
    images: true                         # 图片随 prompt 送入（见下）
    fileOutput: true                     # 允许 agent 用 send_file 交付产物
    allowedFileDirs: []                  # 除工作区外还允许发送的目录
    maxFileBytes: 31457280               # 30 MB，平台硬限制

    # 生命周期
    autoResumeGoals: false               # 每条消息前尝试重新武装被 disarm 的 goal
    onboarding: true                     # 无凭据时是否允许二维码建应用
    stateDir: ~/.dsh/dsh-feishu-card
```

`cwd` 不配置时，插件会在**排除宿主自己的目录**（`$DSH_HOME`、profile 目录、运行中的 dsh 安装目录）后取第一个注册的工作区。这是刻意的：`process.cwd()` 是 harness 安装目录，把编码 agent 默认指向正在运行的 harness 是典型的自伤默认值。

`cardInput` 默认关闭：飞书客户端的 `input` 元素会弹一个原生编辑面板，各端体验不一致（移动端面板偏大、确认入口不统一）。对聊天场景来说，"直接在聊天框回复"更自然，所以默认走回复路径。

## 设置界面

配置项在 Harness **左侧边栏的「插件」面板**里（不是设置页）：找到 `dsh-feishu-card` 这张卡，点进去，配置表单就在该插件的页面上。

> 位置说明：harness 自己的文案写着「在这里配置官方插件，安装和管理其他插件。内置插件列表及运行状态可在『设置 → 内置插件』中查看」——**「设置 → 内置插件」是只读清单**，配置在「插件」面板。

表单按语义分组，而不是把校验用的 schema 直接铺开：

| 分组 | 内容 |
| --- | --- |
| 飞书连接 | App ID / App Secret / API 域名 |
| 工作区与会话 | **默认工作区**（`cwd`）、会话划分、回复语言、群里是否要 @ |
| 输入与输出 | 接收图片、图片数量上限、是否允许发文件、额外可发送目录 |
| 卡片外观 | 过程面板、版式预设、宽度、字号、状态表情、流式间隔 |
| 交互 | 卡片内输入框、审批超时、催促间隔 |
| 授权 | 私聊/群白名单、审批人、禁用工具 |
| 通知与生命周期 | 通知开关、用量阈值、自动重新武装 goal、扫码建应用、状态目录 |

**这些设置是实时生效的**，不需要重启：设置页只接受"可实时应用"的字段（见下），插件在 `loader/volatile-update` 里重新读取；凭据变更会**重建飞书长连接**，工作区变更会让**新会话**用新目录。

只有 `stateDir`（状态目录）和 `onboarding`（扫码建应用）**不在设置页里**——它们在插件挂载时读取一次（日志文件、凭据存储、二维码流程都在那之前定好），把它们做成"实时设置"等于承诺一个做不到的效果。这两项请改配置文件或环境变量。

几点行为：

- 改动**收集起来一次性提交**（带 revision 栅栏），底部按钮显示待保存项数
- **App Secret 显示为「已设置」**：宿主只回传 `{path, set}` 而不回传明文，留空即表示不修改
- 保存后**实时生效**（除了上面说的两个字段）
- 每个字段都有一句说明它做什么——设置页是 schema 驱动的，没有 `description` 的字段会渲染成一个没有标签的输入框

## 使用

私聊直接发消息；群里需要 @机器人（受 `requireMention` 控制）。

**本渠道自己实现的命令：**

| 命令 | 作用 |
| --- | --- |
| `/new` | 开新会话，**并在返回的卡片里选择模式**（默认标准模式；不选直接发消息也行） |
| `/model` | 查看与切换本会话的模型；**当前模型有推理档位时，档位选择就搭在同一张卡片上** |
| `/sessions` | 列出可切换的会话，选一个把这个群切过去 |
| `/switch <id 或前缀>` | 直接切换会话；歧义时拒绝而不是猜 |
| `/permission` | 选择沙箱模式与审批策略（随时可改） |
| `/status` | 查看绑定的会话与卡片状态 |
| `/stop` | 停止当前回合（在命令处理之前拦截，所以回合跑着时也有效） |
| `/help` | **可点卡片**：列出本渠道与宿主的全部命令，带用法形式；**点一下即执行**（破坏性命令除外，见下） |

其余 `/xxx` **整行委派**给宿主的 `commands.execute`——宿主注册了什么就能用什么。

**选择一律用抽屉式下拉**（飞书渲染成底部列表），卡片高度不随选项数量增长。选择后卡片就地收敛成结果，不再挂着可选项；想再改就重新发那条命令。

**两条值得知道的边界：**

- **模式只能在会话开始前选**（宿主限制）。所以模式选择并进了 `/new`——那是唯一可用的时刻。会话已经跑过回合时，`/new` 是唯一出路。
- **会话可以切到非本渠道的会话**（例如 Web UI 里开的）。切过去后这个群就在驱动那个会话；Web GUI 里发起的回合**不会**被广播进群，只有群里的消息会开卡。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块地图、事件/服务清单、数据流、关键不变量与设计取舍 |
| [docs/PLATFORM-NOTES.md](docs/PLATFORM-NOTES.md) | 飞书卡片 JSON 2.0 硬约束（逐条实测）、API 清单、反应语义 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地迭代、离线测试、如何对真实 API 验证卡片、如何加功能 |
| [CHANGELOG.md](CHANGELOG.md) | 变更历史 |

## 测试

```bash
node test/offline.mjs
```

259 项断言，**不连飞书**，覆盖：卡片结构与 `element_id` 平台规则、四种阅读预设版式、流式合并与去重、已提交正文不与实时 delta 重复计、**流式会话过期（200850/300309）的分类与续期**、**过期后降级为整卡重写**、**同一卡片的写入串行化（300317）**、连续失败预算、卡片创建幂等与竞态、会话键单射性、session ladder 三档阶梯、`/new` 轮换与重启持久化、命令委派与降级、工具分类与 diff 提取、反应换挡序列与终态一次性、通知阈值跨越、进度卡原位更新与过期恢复、扇出计数与畸形载荷降级、命令面板的增删改计划、模型与档位解析、会话选择与切换（含 `use()` 持久化）、模式锁判断与中文名映射、`/help` 卡片的按钮与破坏性判定、命令用法提示、附件透传。

其中若干条是**结构断言**，针对的是"语法合法但语义已坏"的情形——例如命令分支不得重复、不得为空块、每条命令都必须有分支。这类 bug 不抛错、不打日志，普通单元测试发现不了（一次真实事故：`/status` 分支被重复一行成了空块，命令静默什么都不做）。

**另有真实飞书 API 验证**（需要凭据）：全部卡片形状（回合卡 ×4 预设、决策卡 ×4 形态、通知卡、进度卡 ×7）逐一建卡成功，以及"往折叠面板内部元素流式写入"这条高风险路径。验证脚本模式见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 入站只支持文字与图片 | 文件/音频/表情包会回一句"暂不支持"，不会处理 |
| `allowedFileDirs` 不是安全边界 | 实测可被"先复制进工作区再发"绕过；真正的边界是部署文件策略与审批。详见上文说明 |
| 拒绝路径未在真实链路触发过 | 离线覆盖（含符号链接逃逸），但真实测试里 agent 走了复制路线，`refused to send` 从未出现 |
| 命令附件路径未在真实链路验证 | `input.attachments` 的透传已实现并有离线行为断言，但**本部署唯一声明该能力的 `/goal` 未安装**（profile 里没有 `dsh-command-goal`），所以这条路径没有真实链路验证过 |
| 流式卡片不可转发 | 这是平台约束（`streaming_mode` 开启时卡片无法被转发）。本插件的回合卡在运行中开启、完成后关闭 |
| `denyTools` 的运行时效果未验证 | 逻辑已抽出并离线覆盖，注册点覆盖两条会话路径，但默认名单为空（与 GUI 同权限），因此**该路径从未被真实触发过**。要依赖它之前请先按 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 的验证清单实测一次 |
| 多问题逐张追问 | 一次多问按顺序发多张卡片，未合并为一张表单 |
| 斜杠命令面板需应用级权限 | 面板同步走 `application/v7/app_slash_commands`，应用没有该权限时会失败并记日志；命令本身照常可用 |
| 无设备名册 / 跨机迁移 | 依赖 `ctx.cloud`，本部署无该服务；单机场景也无意义 |

## 路线图

1. **`denyTools` 守卫与 `approvers` 的运行时实测** — 两处都需要一个能真实触发它们的场景
2. **`output: cot` 模式**（飞书原生思考消息）— 需要客户端版本门槛
3. **多问题合并表单**

## 许可证与致谢

MIT，见 [LICENSE](LICENSE)。

卡片信息架构、阅读预设分类、"运行中展开 / 完成折叠"的过程面板策略，以及若干**已验证的卡片元素形状**（`collapsible_panel`、`column_set` 按钮换行、`form` 提交语义）来自 MIT 许可的 [hermes-feishu-streaming-card](https://github.com/baileyh8/hermes-feishu-streaming-card)。本项目与 HFC **无代码共享**，是独立实现。
