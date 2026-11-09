import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LucideIcon } from '../components/icons'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  FolderTree,
  Gauge,
  Globe,
  HardDrive,
  Info,
  KeyRound,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Sun,
  Undo2,
} from '../components/icons'
import type { Settings, Source, ThemeSetting } from '../types'
import { bytesToMb, clampInt, formatSpeed, parseMbToBytes } from '../lib/format'
import {
  openDataDir,
  pickDirectory,
  saveSettings as saveSettingsCommand,
  testConnection,
  toErrorText,
} from '../lib/ipc'
import { SOURCE_LABEL } from '../lib/labels'
import { normalizeDownloadDir } from '../lib/downloadPaths'
import { persistThemeSetting } from '../lib/persistTheme'
import { applyThemeSetting } from '../lib/theme'
import { useAppStore } from '../store/appStore'
import { APP_REFRESH_PAGE_EVENT } from '../components/layout/useGlobalShortcuts'
import { Button } from '../components/ui/Button'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { ErrorBanner } from '../components/ui/ErrorBanner'
import { Field, Input } from '../components/ui/Input'
import { ProgressBar } from '../components/ui/ProgressBar'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { cx } from '../lib/cx'
import { canInstallUpdate, updateProgressPercent, validUpdateEndpoint } from '../lib/updateFlow'

const HF_OFFICIAL = 'https://huggingface.co'
const HF_MIRROR = 'https://hf-mirror.com'
const MS_OFFICIAL = 'https://www.modelscope.cn'

interface TestResult {
  status: 'idle' | 'loading' | 'success' | 'error'
  message: string
}

type FieldErrors = Record<string, string>

const EMPTY_TEST_RESULTS: Record<Source, TestResult> = {
  huggingface: { status: 'idle', message: '' },
  modelscope: { status: 'idle', message: '' },
}

const THEME_OPTIONS: Array<{ value: ThemeSetting; label: string; icon: LucideIcon }> = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
]

/** 顶部错误摘要里的字段名 + 对应控件 id（点击摘要可跳到字段）。 */
const FIELD_META: Record<string, { label: string; id: string }> = {
  downloadDir: { label: '下载目录', id: 'settings-download-dir' },
  hfEndpoint: { label: 'HuggingFace 端点', id: 'settings-hf-endpoint' },
  msEndpoint: { label: 'ModelScope 端点', id: 'settings-ms-endpoint' },
  proxy: { label: 'HTTP 代理', id: 'settings-proxy' },
  bandwidthLimit: { label: '限速', id: 'settings-bandwidth' },
  updateEndpoint: { label: '更新源', id: 'settings-update-endpoint' },
}

function settingsEqual(a: Settings, b: Settings): boolean {
  const keys = Object.keys(a) as Array<keyof Settings>
  return keys.every((key) => a[key] === b[key])
}

function validateDraft(
  draft: Settings,
  bandwidthRaw: string,
): { cleaned: Settings; errors: FieldErrors } {
  const errors: FieldErrors = {}
  const downloadDir = draft.downloadDir.trim()

  if (!downloadDir) {
    errors.downloadDir = '请选择下载目录。'
  } else if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(downloadDir)) {
    errors.downloadDir = '请填写绝对路径，例如 C:\\Models'
  }

  const isHttpEndpoint = (value: string) => /^https?:\/\/[^\s/]+/i.test(value)
  if (!isHttpEndpoint(draft.hfEndpoint.trim())) {
    errors.hfEndpoint = '请填写合法的 http(s) 端点，例如 https://hf-mirror.com'
  }
  if (!isHttpEndpoint(draft.msEndpoint.trim())) {
    errors.msEndpoint = '请填写合法的 http(s) 端点，例如 https://www.modelscope.cn'
  }
  if (
    draft.proxy.trim() &&
    !/^(https?|socks5h?):\/\/[^\s]+$/i.test(draft.proxy.trim())
  ) {
    errors.proxy = '代理格式应为 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080'
  }

  // 正式版更新器只接受 HTTPS。
  const updateEndpoint = draft.updateEndpoint.trim()
  if (!validUpdateEndpoint(updateEndpoint)) {
    errors.updateEndpoint = '请填 HTTPS 的 latest.json 完整地址，或留空使用内置源。'
  }

  const bandwidth = parseMbToBytes(bandwidthRaw)
  if (bandwidth === null) {
    errors.bandwidthLimit = '请输入不小于 0 的数字（MB/s），0 表示不限速。'
  }

  const cleaned: Settings = {
    ...draft,
    downloadDir: normalizeDownloadDir(downloadDir),
    hfToken: draft.hfToken.trim(),
    msToken: draft.msToken.trim(),
    hfEndpoint: draft.hfEndpoint.trim().replace(/\/+$/, ''),
    msEndpoint: draft.msEndpoint.trim().replace(/\/+$/, ''),
    proxy: draft.proxy.trim(),
    concurrency: clampInt(draft.concurrency, 1, 8),
    maxRetries: clampInt(draft.maxRetries, 0, 10),
    bandwidthLimit: bandwidth ?? 0,
    autoResume: Boolean(draft.autoResume),
    closeToTray: Boolean(draft.closeToTray),
    notificationsEnabled: Boolean(draft.notificationsEnabled),
    // v0.2.0：单文件连接数 1..=8；扫描根由本地模型库页管理，这里保持当前值不做修改。
    connectionsPerFile: clampInt(draft.connectionsPerFile, 1, 8),
    libraryRoots: draft.libraryRoots ?? [],
    // v0.5.0：在线升级
    autoCheckUpdates: Boolean(draft.autoCheckUpdates),
    updateEndpoint,
  }
  return { cleaned, errors }
}

function Section({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string
  description: string
  icon: LucideIcon
  children: ReactNode
}) {
  return (
    <section className="settings-section grid gap-5 xl:grid-cols-[210px_minmax(0,1fr)] xl:gap-10">
      <header className="flex items-start gap-3">
        <div className="pt-1 text-fg-muted">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-section text-fg">{title}</h2>
          <p className="mt-2 text-meta leading-5 text-fg-muted">{description}</p>
        </div>
      </header>
      <div className="min-w-0 space-y-5">{children}</div>
    </section>
  )
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
  ariaLabel,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
  ariaLabel: string
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-line pt-4">
      <div className="min-w-0">
        <p className="text-body font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-meta leading-4 text-fg-secondary">{description}</p>
      </div>
      <Switch checked={checked} onChange={onChange} ariaLabel={ariaLabel} />
    </div>
  )
}

function Stepper({
  value,
  min,
  max,
  onChange,
  ariaLabel,
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  ariaLabel: string
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-1 rounded-control border border-line-strong bg-surface p-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${ariaLabel}减少`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <span className="w-7 text-center text-body font-medium tabular-nums text-fg">{value}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${ariaLabel}增加`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

function PresetChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'h-8 cursor-pointer rounded-control border px-2.5 text-meta font-medium transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        active
          ? 'border-primary/40 bg-primary-soft text-primary'
          : 'border-line bg-surface text-fg-secondary hover:bg-surface-2 hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

export default function SettingsPage() {
  const settings = useAppStore((state) => state.settings)
  const dataDir = useAppStore((state) => state.dataDir)
  const defaultDownloadDir = useAppStore((state) => state.defaultDownloadDir)
  const appVersion = useAppStore((state) => state.appVersion)
  const snapshotStatus = useAppStore((state) => state.snapshotStatus)
  const snapshotError = useAppStore((state) => state.snapshotError)
  const loadSnapshot = useAppStore((state) => state.loadSnapshot)
  const pushToast = useAppStore((state) => state.pushToast)
  const setSettings = useAppStore((state) => state.setSettings)
  const setPage = useAppStore((state) => state.setPage)
  // v0.5.0：在线升级（切片命名 updateState，避免与草稿辅助函数 update() 冲突）
  const updateState = useAppStore((state) => state.update)
  const checkForUpdates = useAppStore((state) => state.checkForUpdates)
  const installUpdate = useAppStore((state) => state.installUpdate)

  const [installConfirmOpen, setInstallConfirmOpen] = useState(false)
  const updatePercent = updateProgressPercent(updateState.progress)

  const [draft, setDraft] = useState<Settings | null>(null)
  const [bandwidthInput, setBandwidthInput] = useState('0')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [tokenVisible, setTokenVisible] = useState({ hf: false, ms: false })
  const [testResults, setTestResults] =
    useState<Record<Source, TestResult>>(EMPTY_TEST_RESULTS)
  const summaryRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (draft || !settings) return
    setDraft({ ...settings })
    setBandwidthInput(String(bytesToMb(settings.bandwidthLimit)))
  }, [draft, settings])

  // 顶栏一键切换写入已保存主题后，设置页分段控件跟着更新，其它未保存草稿保留。
  useEffect(() => {
    if (!settings) return
    setDraft((previous) => {
      if (!previous || previous.theme === settings.theme) return previous
      return { ...previous, theme: settings.theme }
    })
  }, [settings])

  // v0.2.0：扫描根在「本地模型库」页管理；外部修改（增删根）后同步草稿，
  // 避免保存设置时用旧 libraryRoots 覆盖。
  useEffect(() => {
    if (!settings) return
    setDraft((previous) => {
      if (!previous) return previous
      const current = previous.libraryRoots ?? []
      const next = settings.libraryRoots ?? []
      if (
        current.length === next.length &&
        current.every((root, index) => root === next[index])
      ) {
        return previous
      }
      return { ...previous, libraryRoots: next }
    })
  }, [settings])

  // F5：重新读取当前设置（丢弃未保存草稿）。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: string }>).detail
      if (detail?.page && detail.page !== 'settings') return
      void loadSnapshot(true).then(() => {
        const latest = useAppStore.getState().settings
        if (!latest) return
        setDraft({ ...latest })
        setBandwidthInput(String(bytesToMb(latest.bandwidthLimit)))
        setFieldErrors({})
        setError('')
        pushToast('info', '已重新读取当前设置')
      })
    }
    window.addEventListener(APP_REFRESH_PAGE_EVENT, handler)
    return () => window.removeEventListener(APP_REFRESH_PAGE_EVENT, handler)
  }, [loadSnapshot, pushToast])

  const dirty =
    draft !== null &&
    settings !== null &&
    (!settingsEqual(draft, settings) ||
      parseMbToBytes(bandwidthInput) !== settings.bandwidthLimit)

  const summaryErrors = Object.entries(fieldErrors)

  // 校验失败后把焦点移到顶部错误摘要（P2-9：多错误时键盘用户无需逐字段寻找）。
  useEffect(() => {
    if (summaryErrors.length > 0) summaryRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldErrors])

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous))
    setFieldErrors((previous) => {
      if (!(key in previous)) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  /** 主题三选一：立即应用并单独保存主题，不提交其他未保存草稿。 */
  const handleThemeChange = (value: ThemeSetting) => {
    update('theme', value)
    void persistThemeSetting(value, { announce: true }).catch(() => {
      const fallback = useAppStore.getState().settings?.theme ?? 'system'
      setDraft((previous) => (previous ? { ...previous, theme: fallback } : previous))
    })
  }

  const handleReset = () => {
    if (!settings) return
    setDraft({ ...settings })
    setBandwidthInput(String(bytesToMb(settings.bandwidthLimit)))
    setFieldErrors({})
    setError('')
    setTestResults(EMPTY_TEST_RESULTS)
    applyThemeSetting(settings.theme)
    pushToast('info', '已恢复为已保存的设置')
  }

  const handlePickDir = async () => {
    if (!draft) return
    setPicking(true)
    try {
      const picked = await pickDirectory(draft.downloadDir)
      if (picked) update('downloadDir', picked)
    } catch (err) {
      pushToast('error', '无法打开目录选择器', toErrorText(err))
    } finally {
      setPicking(false)
    }
  }

  const handleSave = async () => {
    if (!draft) return
    const { cleaned, errors } = validateDraft(draft, bandwidthInput)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      pushToast('error', '请检查设置项', `有 ${Object.keys(errors).length} 个字段填写不正确，请修正后再保存。`)
      return
    }
    setSaving(true)
    setError('')
    try {
      const saved = await saveSettingsCommand(cleaned)
      setDraft({ ...saved })
      setBandwidthInput(String(bytesToMb(saved.bandwidthLimit)))
      setFieldErrors({})
      setSettings(saved)
      applyThemeSetting(saved.theme)
      pushToast('success', '设置已保存', '新的下载参数已立即生效。')
    } catch (err) {
      const message = toErrorText(err)
      setError(message)
      pushToast('error', '保存设置失败', message)
    } finally {
      setSaving(false)
    }
  }

  const focusField = (field: string) => {
    const meta = FIELD_META[field]
    if (!meta) return
    const element = document.getElementById(meta.id)
    if (element instanceof HTMLElement) {
      element.focus()
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }

  const handleTest = async (source: Source) => {
    setTestResults((previous) => ({
      ...previous,
      [source]: { status: 'loading', message: '' },
    }))
    try {
      const message = await testConnection(source)
      setTestResults((previous) => ({
        ...previous,
        [source]: { status: 'success', message },
      }))
      pushToast('success', `${SOURCE_LABEL[source]} 连接成功`)
    } catch (err) {
      const message = toErrorText(err)
      setTestResults((previous) => ({
        ...previous,
        [source]: { status: 'error', message },
      }))
      pushToast('error', `${SOURCE_LABEL[source]} 连接失败`, message)
    }
  }

  const handleOpenDataDir = async () => {
    try {
      await openDataDir()
      pushToast('success', '已打开应用数据目录', dataDir || undefined)
    } catch (err) {
      pushToast('error', '无法打开数据目录', toErrorText(err))
    }
  }

  if (!draft) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="page-container max-w-[1120px] space-y-3 pb-10">
          {snapshotStatus === 'error' ? (
            <ErrorBanner
              title="无法加载设置"
              message={snapshotError ?? '未知错误'}
              onRetry={() => void loadSnapshot(true)}
            />
          ) : (
            <>
              <Skeleton className="h-40 w-full rounded-card" />
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <Skeleton className="h-64 w-full rounded-card" />
                <Skeleton className="h-64 w-full rounded-card" />
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="page-container max-w-[1120px] space-y-6 pb-8">
        {error ? (
          <ErrorBanner
            title="保存设置失败"
            message={error}
            onRetry={() => void handleSave()}
          />
        ) : null}

        {/* 多字段校验失败时的顶部错误摘要（role=alert，可聚焦；点击跳到字段）。 */}
        {summaryErrors.length > 0 ? (
          <div
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            className="rounded-card border border-danger/40 bg-danger/5 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <p className="flex items-center gap-2 text-body font-medium text-danger">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              有 {summaryErrors.length} 项设置需要修正
            </p>
            <ul className="mt-1.5 space-y-0.5 pl-6">
              {summaryErrors.map(([field, message]) => (
                <li key={field}>
                  <button
                    type="button"
                    onClick={() => focusField(field)}
                    className="cursor-pointer text-meta text-danger underline decoration-danger/40 underline-offset-2 hover:decoration-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                  >
                    {FIELD_META[field]?.label ?? field}：{message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <div>
            {/* 外观（v0.1.3 新增分组） */}
            <Section
              title="外观"
              description="界面主题与窗口/通知行为；主题更改立即生效并保存。"
              icon={Palette}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-body font-medium text-fg">主题</p>
                  <p className="mt-0.5 text-meta leading-4 text-fg-secondary">
                    选择浅色、深色或跟随系统外观，也可在页面右上角一键切换。更改立即应用。
                  </p>
                </div>
                <SegmentedControlWrapper
                  value={draft.theme}
                  onChange={(value) => void handleThemeChange(value)}
                />
              </div>

              <ToggleRow
                title="关闭窗口时最小化到托盘"
                description="后台继续下载；托盘菜单提供「显示主窗口 / 暂停全部 / 继续全部 / 退出」。"
                checked={draft.closeToTray}
                onChange={(value) => update('closeToTray', value)}
                ariaLabel="关闭窗口时最小化到托盘并在后台继续下载"
              />
              <ToggleRow
                title="下载完成/失败时发送系统通知"
                description="任务完成或失败时发送 Windows 系统通知；应用内提示不受影响。"
                checked={draft.notificationsEnabled}
                onChange={(value) => update('notificationsEnabled', value)}
                ariaLabel="下载完成或失败时发送系统通知"
              />
            </Section>

            {/* 存储位置 */}
            <Section
              title="存储位置"
              description="模型文件与本地模型库扫描的根目录。"
              icon={HardDrive}
            >
              <Field
                label="下载目录"
                htmlFor="settings-download-dir"
                error={fieldErrors.downloadDir}
                hint={`默认目录：${defaultDownloadDir || '—'}`}
              >
                <div className="flex gap-2">
                  <Input
                    id="settings-download-dir"
                    value={draft.downloadDir}
                    onChange={(event) => update('downloadDir', event.target.value)}
                    placeholder="C:\Models"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <Button
                    variant="secondary"
                    onClick={() => void handlePickDir()}
                    loading={picking}
                    leftIcon={<FolderOpen className="h-4 w-4" />}
                    className="shrink-0"
                  >
                    选择目录
                  </Button>
                </div>
              </Field>

              <div className="-mt-1 flex flex-wrap items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => update('downloadDir', defaultDownloadDir)}
                  disabled={!defaultDownloadDir || draft.downloadDir === defaultDownloadDir}
                  leftIcon={<Undo2 className="h-3.5 w-3.5" />}
                >
                  恢复默认目录
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadSnapshot(true)}
                  leftIcon={<Info className="h-3.5 w-3.5" />}
                >
                  重新读取当前设置
                </Button>
              </div>

              {/* v0.2.0：本地模型库附加扫描根（在本地模型库页管理） */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-surface-2/60 px-3 py-2">
                <span className="inline-flex items-center gap-1.5 text-meta text-fg-secondary">
                  <FolderTree className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
                  本地库附加扫描根：{draft.libraryRoots.length} 个
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage('library')}
                  leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
                >
                  在本地模型库中管理
                </Button>
              </div>

              <div className="rounded-control border border-line bg-surface-2/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-meta font-medium text-fg-secondary">
                    <HardDrive className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
                    应用数据目录
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleOpenDataDir()}
                    disabled={!dataDir}
                    leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
                  >
                    打开
                  </Button>
                </div>
                <p className="mt-1 break-all font-mono text-meta leading-4 text-fg-secondary">
                  {dataDir || '正在加载…'}
                </p>
                <p className="mt-1 text-meta leading-4 text-fg-muted">
                  任务列表与设置以 JSON 文件保存在此目录，应用版本 v{appVersion || '—'}。
                </p>
              </div>
            </Section>

            {/* 下载引擎 */}
            <Section
              title="下载引擎"
              description="并发、限速、重试与启动恢复策略，保存后立即生效。"
              icon={Gauge}
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-body font-medium text-fg">并发下载数</p>
                  <p className="mt-0.5 text-meta leading-4 text-fg-secondary">
                    同时进行的下载任务数（1-8）。
                  </p>
                </div>
                <Stepper
                  value={draft.concurrency}
                  min={1}
                  max={8}
                  onChange={(value) => update('concurrency', value)}
                  ariaLabel="并发下载数"
                />
              </div>

              {/* v0.2.0：单文件多连接（Range 分段并行） */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-body font-medium text-fg">单文件连接数</p>
                  <p className="mt-0.5 text-meta leading-4 text-fg-secondary">
                    每个文件拆分的并行下载连接数（1-8），1 表示单流下载。
                  </p>
                </div>
                <Stepper
                  value={draft.connectionsPerFile}
                  min={1}
                  max={8}
                  onChange={(value) => update('connectionsPerFile', value)}
                  ariaLabel="单文件连接数"
                />
              </div>
              <p className="-mt-1 text-meta leading-4 text-fg-muted">
                总连接数 ≈ 并发任务数 × 单文件连接数；CDN 单连接有限速，建议 4–8。
              </p>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-body font-medium text-fg">最大重试次数</p>
                  <p className="mt-0.5 text-meta leading-4 text-fg-secondary">
                    网络错误 / 5xx 时的重试上限（0-10）。
                  </p>
                </div>
                <Stepper
                  value={draft.maxRetries}
                  min={0}
                  max={10}
                  onChange={(value) => update('maxRetries', value)}
                  ariaLabel="最大重试次数"
                />
              </div>

              <Field
                label="限速（MB/s）"
                htmlFor="settings-bandwidth"
                error={fieldErrors.bandwidthLimit}
                hint={`全局下载限速，0 表示不限速。当前生效：${
                  draft.bandwidthLimit > 0 ? formatSpeed(draft.bandwidthLimit) : '不限速'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Input
                    id="settings-bandwidth"
                    type="number"
                    min={0}
                    step={0.5}
                    inputMode="decimal"
                    value={bandwidthInput}
                    onChange={(event) => setBandwidthInput(event.target.value)}
                    className="w-40"
                  />
                  <span className="text-meta text-fg-muted">MB/s</span>
                </div>
              </Field>

              <ToggleRow
                title="启动时自动继续"
                description="应用启动后自动恢复未完成的下载任务。"
                checked={draft.autoResume}
                onChange={(value) => update('autoResume', value)}
                ariaLabel="启动时自动继续未完成任务"
              />
            </Section>
          </div>

          <div>
            {/* 访问凭据 */}
            <Section
              title="访问凭据"
              description="私有仓库与 gated 仓库需要对应的访问 Token。"
              icon={KeyRound}
            >
              <Field
                label="HuggingFace Token"
                htmlFor="settings-hf-token"
                optional
                hint="在 huggingface.co/settings/tokens 创建；仅本地保存。"
              >
                <div className="relative">
                  <Input
                    id="settings-hf-token"
                    type={tokenVisible.hf ? 'text' : 'password'}
                    value={draft.hfToken}
                    onChange={(event) => update('hfToken', event.target.value)}
                    placeholder="hf_..."
                    autoComplete="off"
                    spellCheck={false}
                    className="pr-11 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setTokenVisible((previous) => ({ ...previous, hf: !previous.hf }))
                    }
                    aria-label={tokenVisible.hf ? '隐藏 HuggingFace Token' : '显示 HuggingFace Token'}
                    className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-control text-fg-muted transition-colors duration-micro hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {tokenVisible.hf ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </Field>

              <Field
                label="ModelScope Token"
                htmlFor="settings-ms-token"
                optional
                hint="在 modelscope.cn 个人中心获取；私有模型下载时需要。"
              >
                <div className="relative">
                  <Input
                    id="settings-ms-token"
                    type={tokenVisible.ms ? 'text' : 'password'}
                    value={draft.msToken}
                    onChange={(event) => update('msToken', event.target.value)}
                    placeholder="modelscope 访问令牌"
                    autoComplete="off"
                    spellCheck={false}
                    className="pr-11 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setTokenVisible((previous) => ({ ...previous, ms: !previous.ms }))
                    }
                    aria-label={tokenVisible.ms ? '隐藏 ModelScope Token' : '显示 ModelScope Token'}
                    className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-control text-fg-muted transition-colors duration-micro hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {tokenVisible.ms ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </Field>

              <div className="flex items-start gap-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-meta leading-4 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Token 以明文形式保存在本机应用数据目录的 settings.json 中。请勿在共享电脑上保存敏感
                  Token；日志与错误信息中不会输出 Token。
                </span>
              </div>
            </Section>


            {/* 网络与镜像 */}
            <Section
              title="网络与镜像"
              description="访问仓库与下载文件使用的端点、代理和连通性测试。"
              icon={Globe}
            >
              <Field
                label="HuggingFace 端点"
                htmlFor="settings-hf-endpoint"
                error={fieldErrors.hfEndpoint}
                hint="默认使用 hf-mirror 镜像（国内网络可用）；如需官方源可切换为 huggingface.co。"
              >
                <Input
                  id="settings-hf-endpoint"
                  value={draft.hfEndpoint}
                  onChange={(event) => update('hfEndpoint', event.target.value)}
                  spellCheck={false}
                  className="font-mono"
                />
              </Field>
              <div className="-mt-1 flex flex-wrap gap-1.5">
                <PresetChip
                  active={draft.hfEndpoint === HF_OFFICIAL}
                  onClick={() => update('hfEndpoint', HF_OFFICIAL)}
                >
                  官方 HuggingFace
                </PresetChip>
                <PresetChip
                  active={draft.hfEndpoint === HF_MIRROR}
                  onClick={() => update('hfEndpoint', HF_MIRROR)}
                >
                  hf-mirror 镜像
                </PresetChip>
              </div>

              <Field
                label="ModelScope 端点"
                htmlFor="settings-ms-endpoint"
                error={fieldErrors.msEndpoint}
                hint="一般无需修改，保持默认即可。"
              >
                <Input
                  id="settings-ms-endpoint"
                  value={draft.msEndpoint}
                  onChange={(event) => update('msEndpoint', event.target.value)}
                  spellCheck={false}
                  className="font-mono"
                />
              </Field>
              <div className="-mt-1">
                <PresetChip
                  active={draft.msEndpoint === MS_OFFICIAL}
                  onClick={() => update('msEndpoint', MS_OFFICIAL)}
                >
                  官方 ModelScope
                </PresetChip>
              </div>

              <Field
                label="HTTP 代理"
                htmlFor="settings-proxy"
                optional
                error={fieldErrors.proxy}
                hint="留空则读取系统环境变量；例如 http://127.0.0.1:7890。"
              >
                <Input
                  id="settings-proxy"
                  value={draft.proxy}
                  onChange={(event) => update('proxy', event.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  spellCheck={false}
                  className="font-mono"
                />
              </Field>

              <div className="border-t border-line pt-4">
                <p className="text-body font-medium text-fg">连接测试</p>
                <p className="mt-0.5 text-meta leading-4 text-fg-secondary">
                  使用已保存的设置发起真实请求；如刚修改端点，请先保存再测试。
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(['huggingface', 'modelscope'] as Source[]).map((source) => {
                    const result = testResults[source]
                    return (
                      <div
                        key={source}
                        className="rounded-control bg-surface-2 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-meta font-medium text-fg-secondary">
                            {SOURCE_LABEL[source]}
                          </span>
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={result.status === 'loading'}
                            onClick={() => void handleTest(source)}
                          >
                            测试
                          </Button>
                        </div>
                        {result.status === 'loading' ? (
                          <p className="mt-1.5 text-meta text-fg-muted">正在连接…</p>
                        ) : result.status === 'success' || result.status === 'error' ? (
                          <p
                            className={cx(
                              'mt-1.5 flex items-start gap-1 break-words text-meta leading-4',
                              result.status === 'success' ? 'text-success' : 'text-danger',
                            )}
                          >
                            {result.status === 'success' ? (
                              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                            ) : (
                              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                            )}
                            <span>{result.message}</span>
                          </p>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            </Section>

            {/* 关于与更新（v0.5.0） */}
            <Section
              title="关于与更新"
              description="检查应用新版本并一键升级；更新源可指向镜像 latest.json。便携版不支持自动升级。"
              icon={RefreshCw}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-body font-medium text-fg">
                    当前版本 v{appVersion || '—'}
                  </p>
                  <p className="mt-0.5 text-meta leading-4 text-fg-secondary">
                    更新包需通过发布方数字签名校验；下载与安装在应用内完成。
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={updateState.status === 'checking'}
                  disabled={updateState.status === 'downloading'}
                  onClick={() => void checkForUpdates(true)}
                  leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                  className="shrink-0"
                >
                  检查更新
                </Button>
              </div>

              {updateState.status === 'upToDate' ? (
                <p className="flex items-center gap-1.5 text-meta text-success" role="status">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  已是最新版本
                </p>
              ) : null}

              {updateState.status === 'failed' && updateState.error ? (
                <ErrorBanner
                  title="检查更新失败"
                  message={updateState.error}
                  onRetry={() => void checkForUpdates(true)}
                />
              ) : null}

              {updateState.status === 'available' && updateState.info ? (
                <div className="rounded-control border border-primary/30 bg-primary-soft/50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-body font-medium text-fg">
                      发现新版本 v{updateState.info.version}
                    </span>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!canInstallUpdate(updateState.status)}
                      onClick={() => setInstallConfirmOpen(true)}
                      leftIcon={<Download className="h-3.5 w-3.5" />}
                    >
                      立即更新
                    </Button>
                  </div>
                  {updateState.info.notes ? (
                    <p className="mt-2 whitespace-pre-wrap text-meta leading-5 text-fg-secondary">
                      {updateState.info.notes}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {updateState.status === 'downloading' ? (
                <div aria-live="polite">
                  <div className="mb-1.5 flex items-center justify-between text-meta text-fg-secondary">
                    <span>正在下载更新…</span>
                    <span className="tabular-nums">
                      {updatePercent === null ? '准备中' : `${updatePercent}%`}
                    </span>
                  </div>
                  <ProgressBar
                    value={updatePercent ?? 0}
                    indeterminate={updatePercent === null}
                    ariaLabel="下载更新进度"
                  />
                </div>
              ) : null}

              {updateState.status === 'installed' ? (
                <p
                  className="flex items-center gap-1.5 text-meta text-success"
                  role="status"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  更新已安装，应用即将重启…
                </p>
              ) : null}

              <Field
                label="更新源"
                htmlFor="settings-update-endpoint"
                optional
                error={fieldErrors.updateEndpoint}
                hint="留空使用 GitHub Releases，也可填写镜像 latest.json 的 HTTPS 地址。"
              >
                <Input
                  id="settings-update-endpoint"
                  value={draft.updateEndpoint}
                  onChange={(event) => update('updateEndpoint', event.target.value)}
                  placeholder="https://mirror.example.com/.../latest.json"
                  spellCheck={false}
                  className="font-mono"
                />
              </Field>

              <ToggleRow
                title="启动时自动检查更新"
                description="启动数秒后静默检查，发现新版本才提示；检查失败不打扰。"
                checked={draft.autoCheckUpdates}
                onChange={(value) => update('autoCheckUpdates', value)}
                ariaLabel="启动时自动检查更新"
              />
            </Section>
          </div>
        </div>

        </div>
      </div>
        {/* 保存区占独立布局空间，始终可见且不覆盖字段。 */}
        <section data-action-shelf className="workspace-inset flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-surface py-4">
          <div className="flex items-center gap-2">
            <span
              className={cx('h-1.5 w-1.5 rounded-full', dirty ? 'bg-warning' : 'bg-success')}
              aria-hidden="true"
            />
            <span
              className={dirty ? 'text-meta text-warning' : 'text-meta text-fg-muted'}
              aria-live="polite"
            >
              {dirty ? '有未保存的更改' : '所有更改已保存'}
            </span>
            <span className="hidden text-meta text-fg-muted sm:inline">
              · 主题更改会立即保存，其余设置需点击「保存设置」
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={handleReset}
              disabled={!dirty || saving}
              leftIcon={<Undo2 className="h-4 w-4" />}
            >
              重置更改
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              loading={saving}
              disabled={!dirty}
              leftIcon={<Save className="h-4 w-4" />}
            >
              保存设置
            </Button>
          </div>
        </section>

        {/* v0.5.0：安装更新确认（进度在「关于与更新」区内联展示） */}
        <ConfirmDialog
          open={installConfirmOpen}
          title="立即安装更新？"
          description={
            updateState.info
              ? `将下载并安装 v${updateState.info.version}，然后重启应用。${settings?.autoResume ? '正在下载和排队的任务会自动继续，已暂停的任务保持暂停。' : '自动继续已关闭，重启后请手动继续下载。'}`
              : '将下载并安装最新版本。下载完成后自动安装并重启应用。'
          }
          confirmLabel="下载并安装"
          tone="primary"
          onConfirm={() => {
            setInstallConfirmOpen(false)
            void installUpdate()
          }}
          onClose={() => setInstallConfirmOpen(false)}
        />
    </div>
  )
}

/** 主题三选一（SegmentedControl 的薄包装，便于后续复用）。 */
function SegmentedControlWrapper({
  value,
  onChange,
}: {
  value: ThemeSetting
  onChange: (value: ThemeSetting) => void
}) {
  return (
    <SegmentedControl
      ariaLabel="界面主题"
      value={value}
      onChange={onChange}
      options={THEME_OPTIONS}
      size="sm"
    />
  )
}
