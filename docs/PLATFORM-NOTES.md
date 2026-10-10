# 飞书平台笔记

**这里每一条都对真实 API 验证过。** 记录的是"文档不会告诉你、但会让你整张卡片建不出来"的东西。写新卡片代码前请先读这份。

验证方式：拿真实凭据直接打 Open API（脚本模式见 [DEVELOPMENT.md](DEVELOPMENT.md)），记录返回的 `code` / `msg` / `ErrPath`。

---

## 1. 卡片 JSON V2 的硬约束

### 1.1 `action` 容器标签已被移除 —— 报 200861

```
code: 200861
ErrMsg: cards of schema V2 no longer support this capability; unsupported tag action
```

卡片 JSON **2.0 删掉了 V1 用来包按钮的 `action` 容器**。按钮必须是 `body.elements` 的**直接元素**：

```jsonc
// ❌ V1 写法，V2 下整卡建不出来
{ "tag": "action", "element_id": "actions", "actions": [ /* 按钮 */ ] }

// ✅ V2 写法
{ "tag": "button", "text": { "tag": "plain_text", "content": "允许一次" },
  "type": "primary", "behaviors": [{ "type": "callback", "value": { ... } }] }
```

**这是本项目最严重的一次事故**：审批卡与提问卡共用同一个构造器，两端都用了 `action`，所以两种卡片**从来就建不出来**。建卡失败后代码走了"交给其他 answerer"的降级路径，请求被 Web UI 接走，飞书端表现为**完全没有任何反应**——既没有卡片也没有报错。

`test/offline.mjs` 现在有一条断言禁止任何构造器输出 `action`。

### 1.2 `element_id` 字符规则 —— 报 300301

```
code: 300301
ErrMsg: ElementID footer-sep: Code 1002: elementID format error.
        Only alphabets, numbers, and underscores are allowed.
        It must start with an alphabet and not exceed 20 characters.
```

规则：`^[A-Za-z][A-Za-z0-9_]{0,19}$`

- **不能用连字符**（`footer-sep`、`custom-form`、`custom-input` 都违规）
- 不能以数字开头
- 不能超过 20 字符

**违反时整卡被拒**，用户看到的是"没有卡片"，不是"卡片有点问题"。`invalidElementIds(card)` 会递归扫描（含 `collapsible_panel` 内部）并在测试里断言。

### 1.3 `form` 必须带 `name` —— 报 11310

```
code: 11310
ErrPath: ROOT -> elements -> [1](tag: form)
ErrMsg: form's name is required and can not be empty string
```

一个正确的单行文本表单（形状抄自 HFC 的线上验证代码）：

```jsonc
{
  "tag": "form",
  "name": "custom_form",                    // ← 必填
  "elements": [
    { "tag": "input", "element_id": "custom_input", "name": "custom",
      "input_type": "text",                 // ← 建议显式写
      "placeholder": { "tag": "plain_text", "content": "或输入…" },
      "width": "fill" },
    { "tag": "button", "name": "custom_submit_<id>",
      "text": { "tag": "plain_text", "content": "提交" },
      "type": "primary", "width": "default",
      "form_action_type": "submit" }        // ← 不是 action_type
  ]
}
```

**表单提交按钮不能带 `behaviors` 回调。** 提交时的回包形状完全不同：

| | 普通按钮回调 | 表单提交 |
| --- | --- | --- |
| 关联值 | `action.value` | **无** |
| 关联 id 载体 | `value` 对象 | **按钮的 `name`** |
| 用户输入 | 无 | `action.form_value[input 的 name]` |

所以关联 id 只能放在提交按钮的 `name` 里（本项目用 `custom_submit_` 前缀），输入框的值从 `action.form_value.custom` 取。

### 1.4 空内容写入被拒 —— HTTP 400

`cardkit.cardElement.content` 写空字符串会被拒。400 来自 SDK 的 axios 层，`assertOk` 看不到（它只看已解析的响应体），**信息在 `error.response.data` 里**。不把 `response.data` 提出来时，日志里只剩一句无用的 `status code 400`。

本项目的处理：`flush()` 跳过空内容与未变化的内容。

### 1.5 头部不是元素

标题、副标题、配色**都不是可寻址元素**，`cardElement.content` 够不到。改它们**只能整卡 `card.update`**。

这直接决定了架构：`turn.js` 里区分"元素写入"（便宜）与"整卡重写"（贵但必需），后者由 `fullDirty` 触发。

---

### `select_static`（下拉 / 底部抽屉）

**在 2.0 里是 `body.elements` 的直接元素**——卡片 1.0 用来包它的 `action` 标签已从 V2 移除（用了报 200861，整卡建不出来）。HFC 的 `_select` 仍是 1.0 写法，不能照抄。

```json
{ "tag": "select_static",
  "element_id": "mselect",
  "placeholder": { "tag": "plain_text", "content": "选择模型" },
  "options": [{ "text": { "tag": "plain_text", "content": "标签" }, "value": "值" }],
  "behaviors": [{ "type": "callback", "value": { "k": "model", "s": "…" } }],
  "initial_option": "值" }
```

- 带不带 `behaviors` 都能建卡（都实测过 `code=0`）
- **选择的回传字段是 `action.option`**，不是 `action.value`——后者是 `behaviors` 自己的常量载荷。所以"选了什么"只能放在 **option 的 `value`** 里（本插件放 JSON），behavior 只做常量标记
- `initial_option` 预选当前值；**必须精确匹配某个 option 的 `value`**，不匹配就等于没预选
- 选项的 `text.content` 与 `value` 都非空，否则平台拒绝
- 一张卡片的高度因此与选项数量无关——选项多时用它，而不是一行一个按钮

## 2. 已验证可用的元素形状

### 2.1 `collapsible_panel`（过程面板）

```jsonc
{
  "tag": "collapsible_panel",
  "element_id": "process_panel",
  "expanded": true,
  "header": {
    "title": { "tag": "plain_text", "content": "▸ 思考 + 3 个工具（点开查看）" },
    "vertical_align": "center"
  },
  "border": { "color": "grey", "corner_radius": "8px" },
  "padding": "8px 8px 8px 8px",
  "elements": [ /* 内部元素，可以带 element_id 并流式写入 */ ]
}
```

- **刻意不加 header `icon`**。HFC 源码注释写得很对："新元素类型会是未经线上验证的，而纯文本提示不会让整张卡挂掉。" 未验证的 icon token 会让整卡被拒。
- **面板内部的元素可以流式写入**——这条单独测过（`reasoning` / `activity` / `answer` / `footer` 四个 `content` 写入 + 终态整卡 `update` 全部成功）。
- 折叠状态下写入内容不会报错，只是看不见。这正是"运行中必须展开"的原因。

### 2.2 `column_set` 按钮换行

长选项列表用一行 run 会变成一堵长条。每 4 个一组：

```jsonc
{
  "tag": "column_set", "flex_mode": "flow",
  "horizontal_spacing": "8px", "horizontal_align": "left",
  "columns": [
    { "tag": "column", "width": "auto", "vertical_align": "top",
      "elements": [ { "tag": "button", "width": "default", /* … */ } ] }
  ]
}
```

### 2.3 卡片宽度

`config.width_mode` 接受 `default` / `compact` / `fill`（本项目三个值都建卡成功）。**仅对 JSON 2.0 卡片有意义**，最终尺寸仍由客户端决定。

---

## 3. `text_size` 平台不校验

这是最容易误判的一条：**包括不存在的值也返回成功**。

| 值 | 建卡结果 |
| --- | --- |
| `normal` / `notation` / `x-small` / `small` / `large` / `heading` | 全部 OK |

所以 **"API 接受" ≠ "有效果"**。配置项必须限定在已知能渲染出差异的集合内（本项目用 `normal` / `notation` / `x-small` / `small`），否则用户会以为自己配错了。

---

## 4. 反应（reaction）

### 4.1 接口

- 创建：`POST /open-apis/im/v1/messages/{message_id}/reactions`，body `{reaction_type:{emoji_type}}` → 返回 `reaction_id`
- 删除：`DELETE /open-apis/im/v1/messages/{message_id}/reactions/{reaction_id}`
- 列表：`GET  /open-apis/im/v1/messages/{message_id}/reactions`

需要 `im:message.reactions` 权限。

### 4.2 反应是**叠加**的，不是覆盖

同一条消息上可以同时挂多个不同表情。所以"显示当前状态"必须是**先删旧的再加新的**。不删会越堆越多。

> 诊断陷阱：创建接口返回的 `reaction_id` 有很长的共同前缀。第一次探测时我把 id 截断到 12 字符，误以为"6 个不同表情返回了同一个 id，所以一个消息只能挂一个"。**列一下实际反应**才发现 6 个都在。截断 id 做对比是会骗人的。

### 4.3 有效的 `emoji_type`

实测通过：`OK` · `THINKING` · `DONE` · `ERROR` · `OnIt` · `THUMBSUP`
实测拒绝：`DONE_TICK` → `"reaction type is invalid."`（说明平台**确实**校验这个字段，与其他字段不同）

只有机器人自己加的反应能被它自己删除。

---

## 4b. 更新已发送的卡片消息

两条路，**只靠一条都可能不生效**（内容相同、幂等，所以两条都带上没坏处）：

| 路径 | 做法 |
| --- | --- |
| 回调响应带卡 | `{"toast": {...}, "card": {"type": "raw", "data": <完整卡片 JSON>}}` —— 平台为按钮点击设计的就地更新 |
| 显式更新消息 | `PATCH /open-apis/im/v1/messages/{message_id}`，`data.content` 传卡片 JSON 字符串。SDK 里是 `im.v1.message.patch`，message_id 在回调的 `context.open_message_id` |

**只回 toast 不重绘 = 用户看到的是"这一下没生效"**：卡片继续显示旧状态，比不响应更容易被误判为 bug。

### 陷阱：`message.get` 不能用来验证卡片内容

对 **JSON 2.0 卡片**，`GET /open-apis/im/v1/messages/{id}` 返回的是**降级后的兼容投影**：

```json
{"title":"DSH · 模型","elements":[[{"tag":"img","image_key":"img_v3_..."},
 {"tag":"text","text":"请升级至最新版本客户端，以查看内容"}]]}
```

**里面没有卡片源码**——模型名、按钮、`✓` 标记全都不在。曾据此判断"更新没生效"，而 `message.patch` 当时返回的是 `code: 0 success`；**拿无效证据否定了正确的行为**。

要验证卡片更新只能看客户端，或用 `update_time` 之类的间接信号。

---

## 4c. 流式会话有 10 分钟寿命 —— 报 200850 / 300309

**`streaming_mode: true` 的卡片不是"一直能流式写"。** 平台在**距上次开启 10 分钟**时自动关闭这条会话，此后：

| 时机 | 第一个失败的写 | 之后每一个写 |
| --- | --- | --- |
| 超过 10 分钟 | `code=200850` `card streaming timeout` | `code=300309` `streaming mode is closed` |

实测（本部署日志，两张卡）：11:05:40 建卡 → 11:15:45 首次 200850，**10 分 04 秒**；00:31:32 建卡 → 00:41:31 首次 200850，**9 分 59 秒**。此后每个 flush（约 400ms 一次）都收到 300309。

受控实测（同一张卡，真实 API 依次写 `elements/answer/content`）：

| 时刻 | 操作 | 结果 |
| --- | --- | --- |
| +300s | 元素写 | `code=0` |
| +500s | 元素写 | `code=0` |
| +582s | 元素写 | `code=0` |
| +615s | 元素写 | `code=200850` `card streaming timeout` |
| +615s | 再写一次 | `code=300309` `streaming mode is closed` |
| +615s | `card.settings` `streaming_mode: true`（**PATCH**） | `code=0` |
| +617s | 元素写 | `code=0` |
| 续期后 +615s | 元素写 | `code=200850` |

**+582s 写过也没用**——这直接证明写操作不续期；关闭后的续期成功，且续期后立刻就能继续写。**窗口从续期那一刻重算**：续期后 +615s 又报 200850。

**这不是"闲置超时"，是寿命。** 本部署测到的两张卡都在**持续写**（flush 每 400ms 一次），照样到点关闭——**写操作不续期**。所以心跳保活**不是**修法：一个真的跑过 10 分钟的回合仍然会撞上它。（上游还报过另一种触发：长工具阶段里没有正文写入时的 200850。两种情况的表现与修法相同。）

**修法是"重新开启"。** 对已存在的卡片实体再调一次 `cardkit.v1.card.settings`（`streaming_mode: true`）即可开启流式更新，窗口从这一刻重新开始。两条路都要有，缺一条都不够：

- **提前续期**：距上次续期超过 8 分钟的**下一笔写之前**先续一次，长回合根本不会掉进关闭里。检查挂在写路径上，所以"安静很久（长工具阶段）再恢复写"也走同一条路——那第一笔写先续期，**连一次失败的写都不会有**
- **被动恢复**：把 200850 / 300309 认成"会话已关闭"，续期后重试那一笔写（兜住"续期与写之间刚好关闭"和"续期这次调用本身失败"）

**降级比"当作终止"更值得做。** 万一确实续不上（例如平台不再允许），`cardkit.v1.card.update` **不依赖流式会话**，可以继续整卡重写——用户看到的是"没有打字机效果"，而不是"卡片停在半句话上不动"。200850 与 300309 只出现在 `cardElement.content` 上，`card.create` / `card.update` 不受影响。

> 反向的坑：往**从未开启流式**的卡片写 `cardElement.content`，报的也是 300309。所以给决策卡（`buildDecisionCard` 不开流式）加"仍在等待"提醒**不能走 `streamElement`**，得走 `card.update`——否则那笔写只能失败，而它当时被一个空 catch 吞掉了。

**`sequence` 必须严格递增，而且是按到达顺序比较的。** 并发两笔写会按**调用顺序**取号、按**完成顺序**到达，后到的那笔被拒：`code=300317` `sequence number compare failed`。所以同一张卡上的写必须**串行**——这不是性能问题，是正确性问题。

## 5. API 清单

### CardKit（卡片实体）

| 操作 | 接口 | 说明 |
| --- | --- | --- |
| 建实体 | `cardkit.v1.card.create` | `{type:'card_json', data: <JSON 字符串>}` → `card_id` |
| 流式开关 | `cardkit.v1.card.settings` | `{settings: JSON 字符串, sequence}`，可对已存在的实体开启/关闭；**会话有 10 分钟寿命，见第 4c 节** |
| 整卡重写 | `cardkit.v1.card.update` | `{card:{type,data}, sequence}`，**不依赖流式会话**（关闭后的降级路径） |
| 元素内容 | `cardkit.v1.cardElement.content` | `{content, sequence}`，**空串会被拒**；**只在流式会话内有效** |
| 元素替换 | `cardkit.v1.cardElement.update` | `{element: JSON 字符串, sequence}` |

**`sequence` 必须严格递增，每个 `card_id` 一个计数器。** 计数器只由 `feishu.js` 持有，调用方永远不碰。

### 消息（im）

| 操作 | 接口 | 说明 |
| --- | --- | --- |
| 发到会话 | `im.v1.message.create` | `params:{receive_id_type:'chat_id'}` |
| 回复某条 | `im.v1.message.reply` | 可带 `reply_in_thread` |
| 发卡片**实体** | `content = {"type":"card","data":{"card_id":"…"}}` | |
| 发**内联**卡片 | `content = <卡片 JSON 本体>` | 两种形状不同 |
| 列表 | `GET im/v1/messages` | `container_id_type=chat`（**不是** `chat_id`） |

> 内联与实体的 content 形状不同，搞错时平台会拒绝——而卡片兜底路径曾经就因为拼错形状，把"卡片失败"变成了"用户什么都没收到"。

### 其它

- 反应：见第 4 节
- 图片/文件上传、资源下载：**尚未实现**（路线图第 1 项）
- 斜杠命令面板同步（`application/v7/app_slash_commands`）：**未实现**，需要已发布的应用版本

---

## 6. 二维码建应用

`@larksuiteoapi/node-sdk` 导出 `registerApp(options)`：

- 传入 `appPreset`（应用名/描述）与 `addons`（scopes / events / callbacks）
- 通过 `onQRCodeReady({url, expireIn})` 拿到注册 URL
- 成功后返回 `{client_id, client_secret}` → 即 `appId` / `appSecret`

本项目提交的 addons（可在日志里解出验证）：

```json
{ "scopes": { "tenant": ["im:message", "im:message:send_as_bot", "im:message:readonly",
                          "im:resource", "im:chat:read", "im:message.reactions"] },
  "events":    { "items": { "tenant": ["im.message.receive_v1"] } },
  "callbacks": { "items": ["card.action.trigger"] } }
```

**二维码过期会自动重发**（实测发生过一次，`user_code` 改变）。

> 注意：这套 SDK 的 `registerApp` 只负责**建应用与订阅**。它不会帮你发布应用版本，而某些能力（如命令面板同步）需要已发布版本。

---

## 7. 长连接

- 一条应用**只能有一条** WS 长连接。两个插件用同一个 app id 会争抢入站事件。
- 不同 app id 互不影响。
- 连接状态可用 `ss -tnp` 看进程到 `open.feishu.cn` 的 ESTAB 连接来确认。
- 发送消息走 REST，与 WS 是两条通道；`open.feishu.cn` 有多个地址，只看到一条连接不代表 WS 没起来。
