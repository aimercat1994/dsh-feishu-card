/**
 * dsh-feishu-card — browser half: the plugin's configuration page.
 *
 * Hand-written and build-free, like the rest of this package: the host serves
 * `exports["./client"]` verbatim and the browser evaluates it through
 * `window.__ModuleLoader__`. `React.createElement` is used directly rather than
 * JSX so that no transform step exists to forget to run.
 *
 * It registers into the Plugins page's `plugins.bundle.config` keyed slot, which is
 * how a bundle gets a configuration section on its own page. That page is rendered
 * with `view` alone — the owner passes no values — so this half reads its form from
 * the `configForms` service by namespace, follows its snapshots, and submits edits
 * through it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-feishu-card',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    /**
     * The bundle this page configures: `plugins.bundle.config` is keyed by the
     * PACKAGE name, and the page is the plugin's own — not a component row's.
     *
     * The row-level slot (`plugins.row.config`, keyed `<package>#<rowId>`) is for
     * settings that belong to ONE component of a multi-row bundle. This plugin is
     * a single row whose settings are the plugin's settings, so the bundle slot is
     * the right home. The two also differ in what the owner passes: the row page
     * receives `form`, the bundle page receives only `view` and must fetch its own.
     */
    const BUNDLE_KEY = 'dsh-feishu-card'

    /**
     * The settings namespace for this plugin: the BARE patch id, not the Loader
     * entry id (`include:feishu-card`). The host keys `settings.describe()` by
     * `entry.options.id`, and the shipped reference implementation uses its bare
     * patch id the same way.
     */
    const NAMESPACE = 'feishu-card'

    const CARD_STROKE = 'var(--dsw-alias-settings-card-stroke)'
    const CARD_FILL = 'var(--dsw-alias-settings-card-fill)'
    const LABEL = 'var(--dsw-alias-label-primary)'
    const LABEL_2 = 'var(--dsw-alias-label-secondary)'
    const TERTIARY = 'var(--dsw-alias-label-tertiary)'
    const BORDER = 'var(--dsw-alias-border-l4)'
    const BG = 'var(--dsw-alias-bg-layer-1)'
    const BUSINESS = 'var(--dsw-alias-state-business-primary)'

    /**
     * The form model, mirroring lib/config.js.
     *
     * Hand-written rather than derived from the Host schema on purpose: the schema
     * is a validation contract (a deep `anyOf` of loader expressions), and dumping
     * it into a form produces an unusable page. What a person needs here is a
     * short label, a control, and one sentence of consequence.
     */
    const GROUPS = [
      {
        title: '飞书连接',
        note: '留空则依次回退到环境变量、本地凭据文件，最后是扫码建应用。',
        fields: [
          { name: 'appId', label: 'App ID', kind: 'text', placeholder: 'cli_…' },
          { name: 'appSecret', label: 'App Secret', kind: 'secret' },
          {
            name: 'domain',
            label: 'API 域名',
            kind: 'text',
            placeholder: '留空 = 国内飞书',
            hint: '国际版 Lark 填 https://open.larksuite.com',
          },
        ],
      },
      {
        title: '工作区与会话',
        fields: [
          {
            name: 'cwd',
            label: '默认工作区',
            kind: 'text',
            placeholder: '留空 = 自动选择',
            hint: '飞书里新开的对话从哪个目录开始。留空时会自动选一个已注册工作区，并排除 Harness 自身的安装目录。',
          },
          {
            name: 'sessionScope',
            label: '会话划分',
            kind: 'select',
            options: [
              { value: 'chat', label: '整个会话一个（chat）' },
              { value: 'chat-thread', label: '每个话题一个（chat-thread）' },
              { value: 'chat-sender', label: '每个人一个（chat-sender）' },
            ],
          },
          {
            name: 'locale',
            label: '回复语言',
            kind: 'select',
            options: [
              { value: 'auto', label: '跟随消息（auto）' },
              { value: 'zh', label: '中文' },
              { value: 'en', label: 'English' },
            ],
          },
          { name: 'requireMention', label: '群里需要 @机器人', kind: 'boolean' },
        ],
      },
      {
        title: '输入与输出',
        fields: [
          {
            name: 'images',
            label: '接收图片',
            kind: 'boolean',
            hint: '若当前模型路由不支持图片，附件仍会写入会话历史。发 /new 可换一个干净会话。',
          },
          { name: 'maxImagesPerMessage', label: '每条消息最多几张图', kind: 'number', min: 1, max: 20 },
          {
            name: 'fileOutput',
            label: '允许发送文件',
            kind: 'boolean',
            hint: '让 agent 用 send_file 把工作区文件作为附件发到聊天。',
          },
          {
            name: 'allowedFileDirs',
            label: '额外可发送目录',
            kind: 'list',
            hint: '每行一个绝对路径。注意这**不是安全边界**：agent 可以把文件复制进工作区再发。',
          },
          { name: 'maxFileBytes', label: '发送文件大小上限（字节）', kind: 'number', min: 1 },
        ],
      },
      {
        title: '卡片外观',
        fields: [
          { name: 'showProcess', label: '显示过程面板', kind: 'boolean' },
          {
            name: 'readingPreset',
            label: '版式预设',
            kind: 'select',
            options: [
              { value: 'classic', label: 'classic' },
              { value: 'focused', label: 'focused' },
              { value: 'detailed', label: 'detailed' },
              { value: 'task', label: 'task' },
            ],
          },
          {
            name: 'widthMode',
            label: '卡片宽度',
            kind: 'select',
            options: [
              { value: 'default', label: 'default' },
              { value: 'compact', label: 'compact' },
              { value: 'fill', label: 'fill' },
            ],
          },
          { name: 'hideProcessWhenDone', label: '结束后折叠过程', kind: 'boolean' },
          {
            name: 'textSizes',
            label: '字号',
            kind: 'textSizes',
            parts: [
              { name: 'reasoning', label: '思考' },
              { name: 'activity', label: '工具' },
              { name: 'answer', label: '正文' },
              { name: 'footer', label: '页脚' },
            ],
          },
          { name: 'reactionFeedback', label: '消息上的状态表情', kind: 'boolean' },
          { name: 'flushIntervalMs', label: '流式合并间隔（ms）', kind: 'number', min: 50 },
          { name: 'reasoningTail', label: '思考只留最后 N 字', kind: 'number', min: 0 },
        ],
      },
      {
        title: '交互',
        fields: [
          {
            name: 'cardInput',
            label: '提问卡片内放输入框',
            kind: 'boolean',
            hint: '默认关闭：飞书的 input 元素会弹客户端原生面板，各端体验不一致，直接回复聊天更自然。',
          },
          { name: 'approvalTimeoutSec', label: '等待审批（秒）', kind: 'number', min: 0 },
          { name: 'approvalReminderMs', label: '催促间隔（ms，0=不催）', kind: 'number', min: 0 },
        ],
      },
      {
        title: '授权',
        note: '留空表示不限制。被拒绝的发送者会记一条日志。',
        fields: [
          { name: 'senderAllowlist', label: '私聊白名单（open_id）', kind: 'list' },
          { name: 'groupAllowlist', label: '群白名单（chat_id）', kind: 'list' },
          { name: 'approvers', label: '审批人（open_id）', kind: 'list' },
          {
            name: 'denyTools',
            label: '禁用工具',
            kind: 'list',
            hint: '每行一个工具名。留空 = 与 GUI 同权限。',
          },
        ],
      },
      {
        title: '通知与生命周期',
        // `stateDir` and `onboarding` are deliberately absent: both are read once
        // while the plugin mounts, so they are not volatile, so the host's form
        // does not carry them — a control here would show an empty box whose
        // saved value could never be read back. They stay file/env-only settings.
        fields: [
          { name: 'notices', label: '重试/用量/压缩/任务通知', kind: 'boolean' },
          { name: 'pressureWarnTokens', label: '上下文用量告警阈值', kind: 'number', min: 0 },
          { name: 'autoResumeGoals', label: '自动重新武装 goal', kind: 'boolean' },
        ],
      },
    ]

    /** Every field, flattened, for change detection. */
    const FIELDS = GROUPS.flatMap((group) => group.fields)

    /**
     * The Host redacts secrets: a redacted field arrives as `{path, set}` rather
     * than a string. Reading it as a value would render "[object Object]".
     */
    function isRedacted(value) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && typeof value.set === 'boolean' && Array.isArray(value.path)
    }

    /** The editable text for one field, or '' when it has no value yet. */
    function toText(field, value) {
      if (value === undefined || value === null) return ''
      if (field.kind === 'list') return Array.isArray(value) ? value.join('\n') : String(value)
      if (field.kind === 'boolean') return ''
      return String(value)
    }

    /** Whether a field is unset, so the UI can show the placeholder instead of a value. */
    function isUnset(value) {
      return value === undefined || value === null || value === '' || isRedacted(value)
    }

    function labelStyle() {
      return { fontSize: '13px', lineHeight: '20px', color: LABEL }
    }

    function controlStyle() {
      return {
        width: '100%',
        boxSizing: 'border-box',
        height: '32px',
        padding: '0 10px',
        fontSize: '13px',
        color: LABEL,
        background: BG,
        border: `0.5px solid ${BORDER}`,
        borderRadius: 'var(--dsw-radius-md)',
        outline: 'none',
        font: 'inherit',
      }
    }

    /** One labelled row with its control and its one sentence of consequence. */
    function Field(props) {
      const { field, value, disabled, onChange } = props
      const id = `feishu-card-${field.name}`
      let control

      if (field.kind === 'boolean') {
        control = h('input', {
          id,
          type: 'checkbox',
          checked: value === true,
          disabled,
          onChange: (event) => onChange(event.target.checked),
          style: { width: '16px', height: '16px', accentColor: BUSINESS, cursor: disabled ? 'default' : 'pointer' },
        })
      } else if (field.kind === 'select') {
        control = h(
          'select',
          { id, value: value ?? '', disabled, onChange: (event) => onChange(event.target.value), style: controlStyle() },
          field.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        )
      } else if (field.kind === 'number') {
        control = h('input', {
          id,
          type: 'number',
          value: value ?? '',
          min: field.min,
          max: field.max,
          disabled,
          onChange: (event) => onChange(event.target.value),
          style: controlStyle(),
        })
      } else if (field.kind === 'secret') {
        const redacted = isRedacted(value)
        control = h('input', {
          id,
          type: 'password',
          value: redacted ? '' : (value ?? ''),
          disabled,
          autoComplete: 'off',
          placeholder: redacted && value.set ? '已设置（留空表示不修改）' : '未设置',
          onChange: (event) => onChange(event.target.value),
          style: controlStyle(),
        })
      } else if (field.kind === 'list') {
        control = h('textarea', {
          id,
          value: value ?? '',
          disabled,
          rows: 3,
          placeholder: '每行一个',
          onChange: (event) => onChange(event.target.value),
          style: { ...controlStyle(), height: 'auto', padding: '6px 10px', lineHeight: '20px', resize: 'vertical' },
        })
      } else {
        control = h('input', {
          id,
          type: 'text',
          value: value ?? '',
          disabled,
          placeholder: field.placeholder,
          onChange: (event) => onChange(event.target.value),
          style: controlStyle(),
        })
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } },
        h(
          'label',
          { htmlFor: id, style: { ...labelStyle(), display: 'flex', alignItems: 'center', gap: '8px' } },
          field.kind === 'boolean' ? [control, h('span', { key: 'l' }, field.label)] : field.label,
        ),
        field.kind === 'boolean' ? null : control,
        field.hint ? h('p', { style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: TERTIARY } }, field.hint) : null,
      )
    }

    /** The four per-region font sizes, as one row of selects. */
    function TextSizes(props) {
      const { field, value, disabled, onChange } = props
      const sizes = ['normal', 'notation', 'x-small', 'small']
      const current = value && typeof value === 'object' ? value : {}
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('span', { style: labelStyle() }, field.label),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '8px' } },
          field.parts.map((part) =>
            h(
              'label',
              { key: part.name, style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: TERTIARY } },
              part.label,
              h(
                'select',
                {
                  value: current[part.name] ?? 'normal',
                  disabled,
                  onChange: (event) => onChange({ ...current, [part.name]: event.target.value }),
                  style: controlStyle(),
                },
                sizes.map((size) => h('option', { key: size, value: size }, size)),
              ),
            ),
          ),
        ),
      )
    }

    /**
     * Resolve this page's form.
     *
     * Two sources, in order of preference:
     *
     *  1. the `configForms` service, looked up by namespace. Required here: the
     *     bundle page is rendered with `view` alone, so nothing else would supply
     *     the values.
     *  2. the owner-supplied `form` prop, kept for the row-level slot's shape.
     */
    function resolveForm(props) {
      const service = props.configForms
      const owned = service && typeof service.get === 'function' ? service.get(NAMESPACE) : undefined
      if (owned && typeof owned.getSnapshot === 'function') {
        return {
          source: 'service',
          getSnapshot: () => owned.getSnapshot(),
          subscribe: typeof owned.subscribe === 'function' ? (listener) => owned.subscribe(listener) : undefined,
          mutate: (ops, revision) => owned.mutate(ops, revision),
        }
      }
      const direct = props.form
      if (direct && direct.state) {
        return {
          source: 'owner',
          getSnapshot: () => direct.state,
          subscribe: undefined,
          mutate: (ops, revision) => direct.mutate(ops, revision),
        }
      }
      return undefined
    }

    /** Follow a form's snapshots; the reference is stable until the form changes. */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => (form ? form.getSnapshot() : undefined))
      React.useEffect(() => {
        if (!form) {
          setSnapshot(undefined)
          return undefined
        }
        setSnapshot(form.getSnapshot())
        if (!form.subscribe) return undefined
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [form])
      return snapshot
    }

    /** The page body: the groups, a dirty-aware save control, and the Host state. */
    function ConfigPage(props) {
      const form = React.useMemo(() => resolveForm(props), [props.configForms, props.form])
      const state = useFormSnapshot(form)
      const revision = state?.revision
      // Edits live here until they are submitted; the owner's state is the
      // accepted truth, so a revision change discards a stale draft.
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        setDraft({})
        setMessage('')
      }, [revision])

      // These three states need different fixes, so they must not share one
      // message: "no form at all" is a namespace-wiring problem, "unavailable" is
      // the connection, and "loading" is just not-yet.
      if (!form) {
        return h(
          'p',
          { style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-state-error-primary)' } },
          `没有拿到配置表单：客户端未暴露命名空间 “${NAMESPACE}”。`,
        )
      }
      if (!state || state.status === 'loading') {
        return h('p', { style: { margin: 0, fontSize: '13px', color: TERTIARY } }, '正在读取配置…')
      }
      if (state.status === 'unavailable') {
        return h(
          'p',
          { style: { margin: 0, fontSize: '13px', color: TERTIARY } },
          '该配置在此客户端不可用（连接处于 memory 模式或未暴露该命名空间）。',
        )
      }

      const accepted = state.value ?? {}
      const writable = state.writable !== false
      const disabled = !writable || busy

      const display = (field) => (field.name in draft ? draft[field.name] : accepted[field.name])

      const edit = (field, next) => {
        setDraft((previous) => ({ ...previous, [field.name]: next }))
        setMessage('')
      }

      /** Only changed fields become ops; a blank secret is never written. */
      const opsForDraft = () => {
        const ops = []
        for (const field of FIELDS) {
          if (!(field.name in draft)) continue
          const next = draft[field.name]
          const current = accepted[field.name]
          if (field.kind === 'secret') {
            if (typeof next !== 'string' || next.length === 0) continue
            ops.push({ op: 'set', path: [field.name], value: next })
            continue
          }
          if (field.kind === 'list') {
            const list = String(next ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
            if (isRedacted(current)) continue
            ops.push({ op: 'set', path: [field.name], value: list })
            continue
          }
          if (field.kind === 'number') {
            if (next === '') {
              ops.push({ op: 'unset', path: [field.name] })
              continue
            }
            const parsed = Number(next)
            if (!Number.isFinite(parsed)) continue
            ops.push({ op: 'set', path: [field.name], value: parsed })
            continue
          }
          if (field.kind === 'textSizes') {
            ops.push({ op: 'set', path: [field.name], value: next })
            continue
          }
          ops.push({ op: 'set', path: [field.name], value: next })
        }
        return ops
      }

      const save = async () => {
        const ops = opsForDraft()
        if (ops.length === 0) {
          setMessage('没有改动')
          return
        }
        setBusy(true)
        setMessage('')
        try {
          const ok = await form.mutate(ops, revision)
          setMessage(ok ? `已保存 ${ops.length} 项（重启 Harness 后生效）` : '宿主拒绝了这次写入')
        } catch (error) {
          setMessage(`写入失败：${error?.message ?? error}`)
        } finally {
          setBusy(false)
        }
      }

      const dirtyCount = opsForDraft().length

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', maxWidth: '760px' } },
        writable
          ? null
          : h(
              'p',
              { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' } },
              '当前 profile 不接受写入。',
            ),
        GROUPS.map((group) =>
          h(
            'section',
            {
              key: group.title,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                padding: '12px 14px',
                border: `0.5px solid ${CARD_STROKE}`,
                borderRadius: 'var(--dsw-radius-xl)',
                background: CARD_FILL,
              },
            },
            h('h3', { style: { margin: 0, fontSize: '14px', fontWeight: 600, color: LABEL } }, group.title),
            group.note ? h('p', { style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: TERTIARY } }, group.note) : null,
            group.fields.map((field) =>
              field.kind === 'textSizes'
                ? h(TextSizes, {
                    key: field.name,
                    field,
                    value: display(field),
                    disabled,
                    onChange: (next) => edit(field, next),
                  })
                : h(Field, {
                    key: field.name,
                    field,
                    value: display(field),
                    disabled,
                    onChange: (next) => edit(field, next),
                  }),
            ),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              disabled: disabled || dirtyCount === 0,
              onClick: save,
              style: {
                height: '32px',
                padding: '0 16px',
                fontSize: '13px',
                font: 'inherit',
                color: '#fff',
                background: disabled || dirtyCount === 0 ? 'var(--dsw-alias-bg-module-platform)' : BUSINESS,
                border: 'none',
                borderRadius: 'var(--dsw-radius-md)',
                cursor: disabled || dirtyCount === 0 ? 'default' : 'pointer',
              },
            },
            busy ? '保存中…' : dirtyCount > 0 ? `保存 ${dirtyCount} 项` : '保存',
          ),
          dirtyCount > 0
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => {
                    setDraft({})
                    setMessage('')
                  },
                  style: {
                    height: '32px',
                    padding: '0 12px',
                    fontSize: '13px',
                    font: 'inherit',
                    color: LABEL_2,
                    background: 'transparent',
                    border: `0.5px solid ${BORDER}`,
                    borderRadius: 'var(--dsw-radius-md)',
                    cursor: 'pointer',
                  },
                },
                '撤销',
              )
            : null,
          message ? h('span', { style: { fontSize: '12px', color: TERTIARY } }, message) : null,
        ),
      )
    }

    /** The row's configuration contribution: a one-liner and the page behind it. */
    function FeishuCardConfig(props) {
      if (props.view === 'summary') {
        return h('span', null, '飞书连接、默认工作区与卡片外观')
      }
      // The WHOLE props object is forwarded, not a hand-picked field: this entry
      // point is where the slot's injected services arrive, and naming only some
      // of them silently drops the rest. Naming `form` alone is exactly how the
      // `configForms` service got lost and the page could never load.
      return h(ConfigPage, props)
    }

    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: BUNDLE_KEY,
            // Reaching the settings service directly is what makes this page work
            // without the owner's help; `form` arrives only when the owner's own
            // namespace lookup succeeded.
            inject: () => ({ configForms: ctx.configForms }),
          },
          FeishuCardConfig,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms']
    return module.exports
  },
})
