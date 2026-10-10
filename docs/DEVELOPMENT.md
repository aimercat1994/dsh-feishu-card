# 开发

## 仓库布局

```
index.js               入口（唯一接线层）
lib/*.js               见 ARCHITECTURE.md 的模块地图
test/offline.mjs       283 项离线断言，不连飞书
cordis.patch.yml       bundle patch：插入 feishu-card 这一行
package.json           声明 dsh.bundle.patch 与依赖
docs/                  本目录
```

## 本地迭代

### 改代码之后必须重启 Harness

**禁用/启用插件不会重新加载代码。** Node 按路径缓存 ES module，toggle 之后 `import()` 拿到的还是旧模块。症状是"改动毫无反应"——本项目在这上面浪费过一整轮：以为 Config schema 没生效，其实跑的是上一版代码。

- 改 `.js` → **必须重启**整个 Harness 进程
- 改 `cordis.patch.yml` 的 `config` → 同样需要重启（或用 Plugin Manager 的 set 操作触发重新挂载，但那不一定重载模块）

### 运行离线测试

```bash
node test/offline.mjs
```

它不连飞书、不需要凭据，纯逻辑断言。**每次改完都该跑。** 覆盖范围见 README。

### 看日志

```bash
tail -f ~/.dsh/dsh-feishu-card/dsh-feishu-card.log
```

控制台与文件双写（`lib/log.js`）。**为什么必须有文件**：本部署的 harness 控制台是一个由监管进程持有的管道，stdout 拿不到；只写 stdout 的插件的失败是**无法事后诊断**的。这条是踩过的教训：早期所有卡片错误都只进 stdout，导致"用户说什么都没收到"时完全无从下手。

日志里会带平台返回的原文（`code` / `msg` / 出错元素路径），这是定位卡片问题的主要手段。

---

## 对真实 API 验证卡片形状

**这是本项目最重要的开发纪律。** 离线测试无法证明平台会接受一张卡片——`action` 标签事件就是这么漏出去的。

模式是从凭据直接打 Open API，把要验证的形状逐个建卡，读返回的 `code`：

```bash
node -e "
const fs=require('fs');
import('./lib/card.js').then(async (m)=>{
  const c = JSON.parse(fs.readFileSync(process.env.HOME+'/.dsh/dsh-feishu-card/credentials.json','utf8'));
  const tok = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{
    method:'POST', headers:{'Content-Type':'application/json; charset=utf-8'},
    body: JSON.stringify({app_id:c.appId, app_secret:c.appSecret})})).json();
  const H = {Authorization:'Bearer '+tok.tenant_access_token,'Content-Type':'application/json; charset=utf-8'};
  const cards = {
    'turn classic': m.buildTurnCard({title:'DSH', preset:'classic'}),
    'decision'    : m.buildDecisionCard({title:'t', body:'b', id:'x'}),
  };
  for (const [name, card] of Object.entries(cards)) {
    const bad = m.invalidElementIds(card);
    const r = await (await fetch('https://open.feishu.cn/open-apis/cardkit/v1/cards',{
      method:'POST', headers:H, body: JSON.stringify({type:'card_json', data: JSON.stringify(card)})})).json();
    console.log(name.padEnd(16), 'ids:'+(bad.length||'ok'), r.code===0?'OK':'FAIL '+JSON.stringify(r).slice(0,180));
  }
});
"
```

**加一个新元素、新预设、新卡片类型时，先这样验一遍再发。**

往已有卡片流式写入也要验（`cardElement.content` 的行为与建卡不同）：

```bash
# 建卡后 PUT /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content
# body: {"content":"...","sequence":<递增>}
```

---

## 验证浏览器一半（无浏览器时）

本部署没有可用的浏览器（Electron 未安装），但客户端一半的**投递链路**可以纯命令行验证。宿主把客户端模块图注入首页的 `__DSH_BOOT__`：

```bash
# 1) 首页需要认证：从日志里取带 token 的 URL，走一次 cookie 流程
TOKEN=$(grep -rhoE 'http://127\.0\.0\.1:2298/\?token=[A-Za-z0-9_-]+' $DSH_HOME/dsh-web.log | tail -1 | sed 's/.*token=//')
curl -s -c /tmp/jar -b /tmp/jar -o /tmp/index.html "http://127.0.0.1:2298/?token=$TOKEN"
curl -s -b /tmp/jar -o /tmp/index.html "http://127.0.0.1:2298/"

# 2) 在注入的模块图里找自己的条目（这一步就是"宿主是否发现了我的客户端一半"）
python3 -c "
import re,json,html
src=open('/tmp/index.html',encoding='utf-8').read()
boot=json.loads(html.unescape(re.search(r'__DSH_BOOT__\"\] = (\{.*?\});',src,re.S).group(1)))
for e in boot['entries']:
    if 'feishu' in e['id']: print(e['id'], e['url'])
"

# 3) 取那个 URL，确认真的能取到
curl -s -b /tmp/jar -o /tmp/served.js "http://127.0.0.1:2298/<url>"
```

服务端**原样**提供 `exports["./client"]`，只追加一行 `sourceMappingURL`——所以 `diff` 只该看到那一行。

**这一步抓得到什么**：客户端一半没被发现（`dsh.client` 写错、`exports["./client"]` 指错）、注册的 slot 名或 row key 不对（那会让"配置"按钮永远不出现，而且没有任何报错）。**抓不到什么**：渲染出来的样子、点击行为、`form.mutate` 是否真的写进 profile。那些只能靠人在浏览器里看。

## 让一个插件出现在设置页

要同时满足三件事，缺一件就是**静默失败**：

1. **配置字段标记 `.volatile()`**——否则该字段不在投影里；一个 volatile 都没有时整条被 `settings.describe()` 跳过，命名空间到不了浏览器。
2. **注册正确的 slot**：插件自己的设置挂 `plugins.bundle.config`（key = **包名**）；"多行 bundle 里某一个组件"的设置挂 `plugins.row.config`（key = `包名#rowId`）。
3. **两级拿数据的方式不同**：`plugins.row.config` 由 owner 传 `form`；`plugins.bundle.config` **只传 `view`**，必须自己从 `configForms` 服务按命名空间取。命名空间是**裸 patch id**（`feishu-card`），不是 loader 目录键（`include:feishu-card`）。

排查顺序建议：先看 slot 占用（`cordis_inspect_query` 的 client `Slots` → `listSubTree`，`root: plugins.bundle.config`）确认注册生效；再确认命名空间；最后才怀疑表单代码。**"命名空间未暴露"几乎总是第 1 条。**

## 加一个功能

按 `ARCHITECTURE.md` 第 7 节的扩展点走。通用流程：

1. **先确认宿主契约**：要订阅的事件真的存在吗？模式（waterfall / emit / serial）是什么？async 吗？服务方法签名是什么？
   - `cordis_inspect_query`（`Event` / `Service` provider）是权威
   - 类型定义在 `node_modules/@deepseek-ai/*/lib/types/`
2. **把纯逻辑放进独立模块**（像 `present.js` / `notice.js` / `fanout.js` 那样），这样能离线测试
3. **在 `index.js` 接线**
4. **补离线断言**
5. **对真实 API 验证卡片形状**（若涉及新元素）
6. **重启并观察日志**

### 枚举 DSH 事件类型的坑

`dsh-session` 自己的 `SessionEventMap` **不是全集**。`todo/write`、`tool-workflow/*`、`subagent/*`、`goal/change` 都是由各自的工具包通过 **module augmentation** 声明的。

```bash
# 找全所有会话事件类型
grep -rn -A12 'interface SessionEventMap' node_modules/@deepseek-ai/*/lib/types/*.d.ts
```

只读宿主包一定会漏。

### waterfall 的规矩

注册在别人的 waterfall 上时：

- **纯观察者必须 `next()`**，否则会吞掉宿主或其他插件的处理
- 注意模式：`compaction/summary-error` 是**同步** waterfall（返回 boolean），里面有异步工作只能 fire-and-forget
- 监听器里的异常要自己接住；抛进宿主的事件分发路径会波及整个回合

---

## 安装 / 升级的坑

### `link:` 安装不装依赖

`install_bundle` 会以 `link:` 方式把本地目录链进 profile，pnpm **不会**安装插件自身的依赖。表现是：

```
feishu-card (dsh-feishu-card): failed to import
```

状态显示 `inactive`。解决：

```bash
cd <插件目录> && pnpm install --prod
```

（这一步过后 toggle 一下或重启即可。）

### `protobufjs` 的构建脚本

pnpm 会报 `ERR_PNPM_IGNORED_BUILDS: protobufjs`。这是 `@larksuiteoapi/node-sdk` 的传递依赖，其 postinstall 只打印一句捐赠提示，**不影响使用**。要消除告警跑 `pnpm approve-builds`。

### 安装方式与依赖的关系（实测）

| 安装方式 | 依赖会装上吗 | 适用 |
| --- | --- | --- |
| `github:aimercat1994/dsh-feishu-card`（插件管理界面或 `pnpm add`） | ✅ 会。实测 57 个包一并装好，插件端到端加载成功 | **用户安装** |
| `link:/本地路径` | ❌ 不会，必须自己 `pnpm install --prod` | **改代码** |

原因是 `link:` 只是把目录链进去，而 git 规格是一次真正的依赖解析安装。所以上面那个"缺 node_modules"的坑**只存在于开发路径**——别把它写进面向用户的安装说明里（本项目犯过这个错：README 曾把开发步骤当成安装步骤）。

> 附带一个测量陷阱：验证 git 安装是否可用时，我用 `createRequire(<符号链接路径>)` 探测依赖，得到 `MODULE_NOT_FOUND`——但插件其实**加载正常**。因为 pnpm 把包放在 `.pnpm/` 虚拟存储里、只在真实路径旁放依赖，而 Node 解析时会先 realpath。**用符号链接路径做 CJS 探测会给出假阴性**；要判断"能不能用"，直接 `import()` 一次比探测解析更可靠。

---

## 验证清单

交付/发布前：

- [ ] `node test/offline.mjs` 全过
- [ ] 所有卡片形状对真实 API 建卡成功
- [ ] 插件状态 `active`（Plugin Manager 或 `Config.listConfigs` 有 `feishu-card`）
- [ ] 日志出现 `using workspace as cwd` + `active` + `connected to Feishu`
- [ ] 真实飞书里跑一遍：发消息 → 卡片流式 → 结束态；提问 → 选项按钮 → 回执；`/new`；`/status`
- [ ] 若改了反应/进度卡/扇出，对应路径也走一遍

---

## 已知的验证缺口

诚实列出，接手时不要以为都验过：

| 项 | 状态 |
| --- | --- |
| 图片输入 | 已实现并离线覆盖；**尚未用真实图片在飞书里跑通**（类型嗅探/下载/入 prompt 三段都只测了假 transport） |
| 出站文件（`send_file`） | ✅ 真实链路已通过（发出 README.md，13593 字节）。路径安全（含 realpath 符号链接逃逸）与工具契约已离线覆盖 |
| `allowedFileDirs` 的边界作用 | ❌ **它不是安全边界**。实测让 agent 发 `/etc/hostname`：它先把文件复制进工作区（字节一致），再发副本，从未被拒绝。agent 本就有文件工具，在 `danger-full-access` 下"能读=能发"；它也可以直接把内容打在聊天里。真正的边界是部署文件策略与审批 |
| 拒绝路径的真实触发 | ❌ 从未发生（上述测试里 agent 没走那条路），仅有离线断言 |
| `denyTools` guard 的运行时效果 | 逻辑已抽出为 `lib/guard.js` 并有离线覆盖；注册点覆盖两条会话路径。**但默认名单为空**（与 GUI 同权限），所以该路径从未被真实触发。要依赖它之前，把 `denyTools` 设成某个工具、发一条会用到它的消息、确认日志出现 `denied tool "x"` |
| `senderAllowlist` / `groupAllowlist` | 逻辑已抽出为 `lib/access.js`，8 项断言覆盖空名单/匹配/不匹配/仅群/群内发送者/mention 门槛。**未在真实飞书里逐条复现**，但拒绝时会写日志 |
| `approvers` | 逻辑已写并离线覆盖；但本部署文件策略为 `danger-full-access`，**审批从未被触发**，所以「非审批人点击被拒」这条只在代码层面成立 |
| 审批卡片真实点击 | 本部署文件策略为 `danger-full-access`，**没有触发过审批**，所以审批路径只在离线断言和建卡层面验证过 |
| 群聊 / `chat-thread` / `chat-sender` 作用域 | 只在私聊 `chat` 作用域实测过 |
| 子代理名册卡（0.3.4） | 卡片构造、`callId` 精确结算、`started …` 不判完成、宽扇出裁剪都有离线断言；**没有在真实 API 上建过卡**，`started …` 那条分支也**没有被一次真实的委派驱动过**。要补：在这里委派一个后台子代理，看卡片是否出现、是否停在"进行中" |
| 流式会话过期（200850/300309）的恢复 | 平台行为**已用真实 API 直接验证**：同一张卡 +300/+500/+582s 写成功、+615s 报 200850、再写报 300309、`card.settings` 续期 `code=0`、紧接的元素写成功（见 PLATFORM-NOTES 4c）。**但"一个真跑过 10 分钟、中途不断更"的回合还没在飞书里跑过**——那需要一次真的超过 10 分钟的回合 |
| `output: cot` | 未实现 |
