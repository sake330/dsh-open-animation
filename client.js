/**
 * dsh-open-animation — Client half.
 *
 * Registers one lazy factory under the package name `dsh-open-animation`.
 * Two responsibilities:
 *   1. the splash itself: a `position: fixed` layer appended to <body> so no slot
 *      ancestor's stacking context can trap it, plus a pre-paint cover that holds the
 *      app back until the first frame is decoded,
 *   2. the settings page under Settings → Plugins → 开屏动画.
 */
window.__ModuleLoader__.load({
  id: 'dsh-open-animation',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // NOT under /api: the Web carrier's Connection service owns the sole `/api` route and
    // authenticates everything beneath it with its own signed cookie, so a plugin route
    // registered there is never reached. The host half applies its own trust fence instead.
    const ROUTE_BASE = '/dsh-open-animation'
    const Z_INDEX = 2147483000

    /**
     * Theme tokens, by their real names as the Client Theme service reports them
     * (`--dsw-alias-*`). Every one carries a light and a dark override, so referencing them
     * is what makes this page follow the app's appearance. An earlier version used
     * `--dsh-color-*` names, which do not exist — every value silently fell through to its
     * hardcoded light-theme fallback, which is why the page ignored dark mode.
     *
     * Each keeps a fallback chain: the secondary label falls back to the primary one, and
     * the final literal is only a last resort if the headless carrier has no theme at all.
     */
    const T = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      muted: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary, #6b7280))',
      border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.35))',
      surface: 'var(--dsw-alias-bg-layer-1, transparent)',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      warn: 'var(--dsw-alias-state-warn-primary, #9a6700)',
      bad: 'var(--dsw-alias-state-error-primary, #cf222e)',
      idle: 'var(--dsw-alias-state-idle-primary, #6b7280)',
    }

    /** Native controls (the select popup, scrollbars, focus rings) follow the OS scheme. */
    const controlStyle = { colorScheme: 'inherit' }

    const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'ogm', 'mpg', 'mpeg', 'ts']
    const IMAGE_EXT = ['gif', 'apng', 'webp', 'avif', 'png', 'jpg', 'jpeg', 'svg', 'bmp', 'ico']

    const DEFAULTS = {
      src: '',
      autoplay: true,
      muted: true,
      volume: 0.6,
      fit: 'cover',
      background: '#000000',
      fadeInMs: 0,
      fadeOutMs: 300,
      holdAfterEndMs: 0,
      skip: 'button',
      skipAfterMs: 1200,
      playbackRate: 1,
      duration: 0,
      maxReplays: 0,
      waitForAppMs: 2500,
      coverBeforePaint: true,
      fallbackRemoveMs: 10000,
    }

    const absolute = (path) => new URL(path, document.baseURI).href

    function extOf(url) {
      const clean = String(url).split('?')[0].split('#')[0]
      const at = clean.lastIndexOf('.')
      return at < 0 ? '' : clean.slice(at + 1).toLowerCase()
    }

    function kindOf(url) {
      const ext = extOf(url)
      if (VIDEO_EXT.includes(ext)) return 'video'
      if (IMAGE_EXT.includes(ext)) return 'image'
      return ''
    }

    function fitStyle(fit) {
      if (fit === 'contain') return { width: '100%', height: '100%', objectFit: 'contain' }
      if (fit === 'fill') return { width: '100%', height: '100%', objectFit: 'fill' }
      return { width: '100%', height: '100%', objectFit: 'cover' }
    }

    // ------------------------------------------------------------------ state

    /**
     * One mutable controller shared by the splash and the settings page.
     * `revision` is what React subscribes to; everything else is read on demand.
     */
    const controller = {
      ready: false,
      /** '' | 'loading' | 'playing' | 'error' | 'off' */
      status: 'loading',
      message: '',
      /** Set once the splash is on screen; hides the skip affordance until then. */
      disclose: false,
      /** How long the current animated source runs, when the host knows. */
      duration: 0,
      source: { origin: 'bundled', configured: '', path: '', name: '', kind: '', size: 0, exists: false },
      config: { ...DEFAULTS },
      mediaUrl: '',
      playable: false,
      /** True while a settings-page preview owns the screen, so the skip button shows. */
      previewing: false,
      /** The live preview layer, if any; a new press replaces it. */
      previewLayer: null,
      /** Set by apply(); the settings page calls it to play the material on demand. */
      preview: () => false,
      revision: 0,
      listeners: new Set(),
    }

    function bump() {
      controller.revision += 1
      for (const listener of controller.listeners) {
        try {
          listener()
        } catch {
          // A settings component that unmounted mid-notify must not break the splash.
        }
      }
    }

    function subscribe(listener) {
      controller.listeners.add(listener)
      return () => controller.listeners.delete(listener)
    }

    /** React's useSyncExternalStore needs this shape; fall back to useState on old builds. */
    const useSnapshot = () => {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(
          useCallback((listener) => subscribe(listener), []),
          useCallback(() => controller.revision, []),
        )
      }
      const [, force] = useState(0)
      useEffect(() => subscribe(() => force((n) => n + 1)), [])
      return controller.revision
    }

    async function callHost(path, init) {
      const response = await fetch(absolute(`${ROUTE_BASE}${path}`), {
        cache: 'no-store',
        ...init,
      })
      const text = await response.text()
      let payload
      try {
        payload = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(text ? text.slice(0, 200) : `HTTP ${response.status}`)
      }
      if (!response.ok && payload?.error) throw new Error(payload.error)
      return payload
    }

    function adoptState(payload) {
      if (!payload) return
      if (payload.config) controller.config = { ...DEFAULTS, ...payload.config }
      if (payload.source) controller.source = payload.source
      if ('playable' in payload) controller.playable = Boolean(payload.playable)
      if ('duration' in payload) controller.duration = Number(payload.duration) || 0
      if ('mediaUrl' in payload) controller.mediaUrl = payload.mediaUrl ? absolute(payload.mediaUrl) : ''
      controller.message = payload.message ?? ''
    }

    async function refresh() {
      try {
        const payload = await callHost('/state')
        adoptState(payload)
      } catch (error) {
        controller.message = `读不到宿主配置：${error?.message ?? error}`
        controller.playable = false
      }
      controller.ready = true
      bump()
      return controller.playable
    }

    // ------------------------------------------------------------------ pre-paint cover

    /**
     * A black layer that exists from the moment this bundle runs. It owns the whole
     * splash presentation: no React mount can be late, and no slot ancestor can clip it.
     */
    function buildLayer() {
      const root = document.createElement('div')
      root.id = 'dsh-open-animation-layer'
      root.setAttribute('role', 'presentation')
      Object.assign(root.style, {
        position: 'fixed',
        inset: '0',
        zIndex: String(Z_INDEX),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background: DEFAULTS.background,
        opacity: '1',
        transition: 'none',
        pointerEvents: 'auto',
        userSelect: 'none',
        cursor: 'default',
        contain: 'strict',
      })

      const media = document.createElement('div')
      Object.assign(media.style, {
        position: 'absolute',
        inset: '0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      })
      root.append(media)

      return { root, media }
    }

    /**
     * Build one playback layer and mount it immediately.
     *
     * `options.preview` separates the two uses. A startup splash is a one-shot: it plays,
     * fades, and is gone — so the settings page could never reuse it, which is why pressing
     * 预览 used to do nothing at all. A preview layer therefore builds fresh on every press
     * (`startSplash`), while the startup layer is created once and disposed with the plugin.
     */
    function openLayer(options = {}) {
      const preview = Boolean(options.preview)
      const discloseOnCreate = Boolean(options.disclose)
      if (typeof document === 'undefined') return null

      const { root, media } = buildLayer()

      /**
       * The bundle runs from a parser-blocking script in <head>, so `document.body` may
       * not exist yet. Appending into `documentElement` keeps the layer in the very first
       * paint; the observer is the fallback for a shape that appears without a paint.
       */
      let bodyObserver = null
      let bodyTimer = 0
      const place = () => {
        if (document.body) document.body.append(root)
        else document.documentElement.append(root)
      }
      place()
      if (!document.body) {
        bodyObserver = new MutationObserver(() => {
          if (!document.body) return
          disconnectBodyWatch()
          document.body.append(root)
        })
        bodyObserver.observe(document.documentElement, { childList: true })
        bodyTimer = setTimeout(() => {
          disconnectBodyWatch()
          if (document.body && !root.isConnected) document.body.append(root)
        }, 5000)
      }
      function disconnectBodyWatch() {
        if (bodyObserver) bodyObserver.disconnect()
        bodyObserver = null
        if (bodyTimer) clearTimeout(bodyTimer)
        bodyTimer = 0
      }

      let node = null
      let finished = false
      let ended = false
      let replays = 0
      const timers = new Set()
      let onKeyDown = null
      let onClickCapture = null
      let onWheelCapture = null

      const later = (fn, ms) => {
        const id = setTimeout(() => {
          timers.delete(id)
          fn()
        }, ms)
        timers.add(id)
        return id
      }

      const clearTimers = () => {
        for (const id of timers) clearTimeout(id)
        timers.clear()
      }

      const detachInput = () => {
        if (onKeyDown) window.removeEventListener('keydown', onKeyDown, true)
        if (onClickCapture) window.removeEventListener('pointerdown', onClickCapture, true)
        if (onWheelCapture) window.removeEventListener('wheel', onWheelCapture, true)
        onKeyDown = onClickCapture = onWheelCapture = null
      }

      /** Tear the layer down for good; safe to call from any path, only runs once. */
      const remove = (immediate) => {
        if (finished) return
        finished = true
        disconnectBodyWatch()
        clearTimers()
        detachInput()
        const config = controller.config
        const ms = immediate ? 0 : config.fadeOutMs
        root.style.opacity = '0'
        root.style.transition = ms > 0 ? `opacity ${ms}ms ease-out` : 'none'
        const drop = () => {
          if (node?.tagName === 'VIDEO') {
            try {
              node.pause()
            } catch {
              // Already detached.
            }
          }
          root.remove()
          if (preview) controller.previewing = false
          if (controller.status !== 'error') controller.status = 'off'
          bump()
        }
        if (ms > 0) later(drop, ms + 40)
        else drop()
      }

      /**
       * The single exit door: hold, then fade. Only the first call has any effect.
       *
       * A preview does NOT exit here. It has no "next screen" to reveal, so cutting away the
       * moment the material ends would look like a failure; instead the last frame lingers
       * and a timer tears the layer down so the next press starts clean.
       */
      const finish = () => {
        if (finished || ended) return
        ended = true
        if (preview) return
        const hold = controller.config.holdAfterEndMs
        if (hold > 0) later(() => remove(false), hold)
        else remove(false)
      }

      const attachInput = (config) => {
        const skip = () => finish()
        onKeyDown = (event) => {
          if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            skip()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        if (config.skip === 'click') {
          onClickCapture = (event) => {
            event.preventDefault()
            event.stopPropagation()
            skip()
          }
          window.addEventListener('pointerdown', onClickCapture, true)
        }
        onWheelCapture = (event) => {
          event.preventDefault()
          event.stopPropagation()
        }
        window.addEventListener('wheel', onWheelCapture, { capture: true, passive: false })
      }

      /** Replace whatever is presented with `url`, and start its playback clock. */
      const present = (url, kind) => {
        if (finished) return
        if (node) {
          node.remove()
          node = null
        }
        const config = controller.config
        root.style.background = config.background

        // A preview has no "next screen" to reveal, so it cannot cut away the moment the
        // material ends — but it also must not sit there forever. This arms exactly one
        // bounded teardown, from the first frame or from `present` itself, whichever comes
        // first, so a reveal that never arrives can no longer strand the layer.
        let teardownArmed = false
        const schedulePreviewTeardown = () => {
          if (!preview || teardownArmed || finished) return
          teardownArmed = true
          const base = [config.duration, controller.duration, config.waitForAppMs].filter((n) => Number(n) > 0)
          const hold = base.length ? Math.max(...base) : 3000
          later(() => {
            if (!finished) remove(false)
          }, hold + 800)
        }

        if (kind === 'video') {
          const video = document.createElement('video')
          video.src = url
          video.autoplay = false
          video.muted = config.muted
          video.volume = config.muted ? 0 : config.volume
          video.playsInline = true
          video.preload = 'auto'
          video.disablePictureInPicture = true
          video.setAttribute('playsinline', '')
          Object.assign(video.style, {
            ...fitStyle(config.fit),
            display: 'block',
            background: 'transparent',
          })
          try {
            video.playbackRate = config.playbackRate
          } catch {
            // Out-of-range rates are rejected by some builds; the default stands.
          }
          video.addEventListener('ended', () => {
            const cap = controller.config.maxReplays
            if (cap > 0 && replays < cap) {
              replays += 1
              try {
                video.currentTime = 0
                void video.play()
              } catch {
                finish()
              }
              return
            }
            finish()
          })
          video.addEventListener('error', () => {
            controller.status = 'error'
            controller.message = '这个视频无法播放（编码可能不被支持）'
            bump()
            remove(false)
          })
          media.append(video)
          node = video
          armVideo(url, video, config)
          return
        }

        const img = document.createElement('img')
        img.alt = ''
        img.decoding = 'async'
        Object.assign(img.style, {
          ...fitStyle(config.fit),
          display: 'block',
          background: 'transparent',
        })
        // Every listener goes on BEFORE `src`. An animation is served from the same origin and
        // is usually already in the HTTP cache, and a cached load can complete synchronously:
        // assign `src` first and `load` fires into nothing, so the reveal never runs and the
        // cover is never lifted.
        img.addEventListener('error', () => {
          controller.status = 'error'
          controller.message = '这个素材无法显示'
          bump()
          remove(false)
        })
        const startImage = () => {
          reveal()
          if (preview) return
          // An animation has no `ended`; it leaves on the host's wait clock.
          const cap = config.duration > 0 ? config.duration : controller.duration > 0 ? controller.duration : config.waitForAppMs
          if (cap > 0) later(finish, cap)
        }
        img.addEventListener('load', startImage, { once: true })
        media.append(img)
        node = img
        img.src = url
        // A cached image can complete at the assignment, so `load` may never fire; `complete`
        // stands in for it. The bound below is armed outside every reveal path and
        // unconditionally, because `startImage` may never run at all — a teardown that
        // depended on it could strand the layer, which is exactly what a preview used to do.
        if (img.complete) startImage()
        schedulePreviewTeardown()
      }

      /** Lift the cover and report that playback started. */
      function reveal() {
        root.style.background = controller.config.background
        controller.status = 'playing'
        bump()
      }

      /** Video playback: wait for a decodable first frame before lifting the cover. */
      function armVideo(url, video, config) {
        const start = () => {
          reveal()
          if (config.duration > 0 && !preview) later(finish, config.duration)
          if (!config.autoplay) {
            // Autoplay refused (or disabled): stay on the poster frame with a way out.
            later(() => {
              if (!finished && video.paused) {
                controller.status = 'error'
                controller.message = '浏览器拦截了自动播放，已静音重试'
                bump()
                video.muted = true
                void video.play().catch(() => {})
              }
            }, 600)
            return
          }
          void video.play().catch(() => {
            // Chromium refuses unmuted autoplay before any user gesture: retry muted.
            video.muted = true
            void video.play().catch(() => {
              controller.status = 'error'
              controller.message = '浏览器拦截了自动播放，点一下画面开始'
              bump()
            })
          })
        }
        if (video.readyState >= 2) start()
        else {
          video.addEventListener('loadeddata', start, { once: true })
          video.addEventListener('canplay', start, { once: true })
          later(() => {
            if (!finished && controller.status === 'loading') start()
          }, 3000)
        }
      }

      const begin = () => {
        disclose()
        if (!controller.playable || !controller.mediaUrl) {
          controller.status = controller.playable ? 'loading' : 'off'
          bump()
          remove(false)
          return
        }
        const config = controller.config
        controller.status = 'loading'
        bump()
        attachInput(config)
        present(controller.mediaUrl, controller.source.kind || kindOf(controller.mediaUrl))
        if (config.skip === 'auto') later(finish, config.skipAfterMs)
      }

      const disclose = () => {
        controller.disclose = true
      }

      /**
       * The cover is a black screen. Anything that leaves it mounted with no way out is a
       * hang, not a degraded splash, so these two guards make hanging impossible: one gives
       * up before playback ever starts, the other bounds playback itself.
       */
      const armDeadline = (ms) => {
        if (finished) return
        later(() => {
          if (finished) return
          if (node === null) {
            controller.status = 'error'
            if (!controller.message) controller.message = '素材没能开始播放'
            bump()
          }
          remove(false)
        }, ms)
      }

      const armPlaybackDeadline = () => {
        const config = controller.config
        const candidates = [config.duration, controller.duration, config.waitForAppMs].filter((n) => Number(n) > 0)
        if (!candidates.length) return
        later(() => {
          if (!finished) remove(false)
        }, Math.max(...candidates) + 1000)
      }

      // The whole point of the cover: nothing below it is interactive while it is up.
      const blockKeys = (event) => {
        if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') return
        event.stopPropagation()
      }
      window.addEventListener('keydown', blockKeys, true)

      // A preview layer is live the moment it exists; a startup layer waits for `begin()`,
      // which the caller runs once the app has rendered and the config has arrived.
      if (discloseOnCreate) {
        controller.previewing = true
        controller.disclose = true
        begin()
      }

      return {
        begin,
        remove,
        armDeadline,
        armPlaybackDeadline,
        isFinished: () => finished,
        dispose() {
          window.removeEventListener('keydown', blockKeys, true)
          remove(true)
        },
      }
    }

    /**
     * Play the current material once, in a fresh layer, for the settings page.
     *
     * Each press builds a new layer because a finished layer is torn out of the DOM and
     * cannot be revisited. Returns whether a preview actually started, so the caller can
     * explain itself when there is nothing to play.
     */
    function startSplashPreview() {
      if (!controller.playable || !controller.mediaUrl) return false
      const previous = controller.previewLayer
      if (previous && !previous.isFinished()) previous.dispose()
      const layer = openLayer({ preview: true, disclose: true })
      if (!layer) return false
      // Previews are short by design; the entry deadline is what bounds a wedged one.
      layer.armDeadline(Math.max(controller.config.fallbackRemoveMs || 10000, 5000))
      controller.previewLayer = layer
      return true
    }

    // ------------------------------------------------------------------ splash React bits

    /**
     * The floating affordance over the splash. Fixed and body-level in effect, with literal
     * white-on-dark styling: it sits on top of arbitrary artwork, not on a themed surface,
     * so it must not follow the app's appearance.
     */
    const skipButtonStyle = {
      position: 'fixed',
      right: 'clamp(12px, 3vw, 32px)',
      bottom: 'clamp(12px, 3vw, 32px)',
      zIndex: String(Z_INDEX + 1),
      padding: '8px 16px',
      borderRadius: '999px',
      border: '1px solid rgba(255,255,255,0.35)',
      background: 'rgba(0,0,0,0.45)',
      color: '#fff',
      font: 'inherit',
      fontSize: '14px',
      lineHeight: '20px',
      cursor: 'pointer',
      backdropFilter: 'blur(6px)',
    }

    /** The skip affordance, rendered through `shell.overlay` so it sits above the shell. */
    function SkipButton() {
      useSnapshot()
      if (!controller.disclose || controller.status === 'off' || controller.status === 'error') return null
      // A preview has no "next screen", so the affordance reads as a way out of the preview.
      if (controller.previewing && controller.status === 'playing') {
        return h(
          'button',
          {
            type: 'button',
            onClick: () => {
              if (controller.previewLayer) controller.previewLayer.remove(false)
            },
            style: skipButtonStyle,
          },
          '结束预览',
        )
      }
      if (controller.config.skip !== 'button') return null
      return h(
        'button',
        {
          type: 'button',
          onClick: () => controller.finish(),
          style: skipButtonStyle,
        },
        '跳过',
      )
    }

    /** The settings page body. */
    function SettingsPage() {
      useSnapshot()
      const [draft, setDraft] = useState(controller.source.configured)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const dirty = useRef(false)

      useEffect(() => {
        if (!dirty.current) setDraft(controller.source.configured)
      }, [controller.revision])

      const edit = (value) => {
        dirty.current = true
        setDraft(value)
      }

      const save = async (patch, label) => {
        setBusy(label)
        setNotice(null)
        try {
          const payload = await callHost('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch ?? { src: draft }),
          })
          adoptState(payload)
          dirty.current = false
          setDraft(controller.source.configured)
          setNotice({
            tone: payload.playable || !controller.source.configured ? 'ok' : 'warn',
            text: payload.playable
              ? `已保存，下次启动播放：${controller.source.name}`
              : controller.source.configured
                ? `已保存，但当前不可播放：${payload.message}`
                : '已保存：开屏动画关闭，下次启动不播放',
          })
        } catch (error) {
          setNotice({ tone: 'bad', text: `保存失败：${error?.message ?? error}` })
        } finally {
          setBusy('')
          bump()
        }
      }

      const browse = async () => {
        setBusy('pick')
        setNotice(null)
        try {
          const payload = await callHost('/pick')
          if (payload.cancelled) setNotice({ tone: 'muted', text: '已取消' })
          else if (!payload.ok) {
            // The Host explains which part failed; the suggestion is always the same,
            // because typing the path works everywhere the dialog does not.
            setNotice({
              tone: 'warn',
              text: `${payload.error || '打不开文件选择框'}。可以直接把路径粘贴到上面的输入框。`,
            })
          } else if (!payload.supported) {
            edit(payload.path)
            setNotice({ tone: 'warn', text: `选中的扩展名无法识别：${payload.name}` })
          } else {
            edit(payload.path)
            setNotice({ tone: 'ok', text: `已选择：${payload.name}，点「保存」生效` })
          }
        } catch (error) {
          setNotice({ tone: 'bad', text: `选择失败：${error?.message ?? error}。可以直接粘贴路径。` })
        } finally {
          setBusy('')
        }
      }

      const status = (() => {
        if (!controller.playable) {
          return controller.source.configured
            ? { tone: 'bad', text: `不播放 — ${controller.message || '素材不可用'}` }
            : { tone: 'muted', text: '不播放 — 未设置素材（下次启动没有开屏动画）' }
        }
        if (controller.source.origin === 'bundled') return { tone: 'ok', text: '下次启动播放 — 插件自带的默认动画' }
        return { tone: 'ok', text: `下次启动播放 — ${controller.source.name}` }
      })()

      const tone = {
        ok: T.ok,
        warn: T.warn,
        bad: T.bad,
        muted: T.muted,
      }

      const rowStyle = { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '18px' }
      const labelStyle = { fontSize: '13px', fontWeight: 600, color: T.text }
      const inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: '6px',
        border: `1px solid ${T.border}`,
        background: T.surface,
        color: T.text,
        font: 'inherit',
        fontSize: '13px',
        ...controlStyle,
      }
      const hintStyle = { fontSize: '12px', color: T.muted, lineHeight: '18px' }

      return h(
        'div',
        { style: { padding: '4px 0', maxWidth: '720px' } },
        h('div', { style: { ...rowStyle, gap: '8px' } }, h('div', { style: { ...labelStyle, fontSize: '14px' } }, '开屏动画'), h('div', { style: hintStyle }, '启动时播放一段视频或动图，播完渐隐露出界面。路径留空即彻底关闭。')),
        h(
          'div',
          { style: rowStyle },
          h('label', { style: labelStyle, htmlFor: 'dsh-open-animation-src' }, '素材路径'),
          h('div', { style: { display: 'flex', gap: '8px' } },
            h('input', {
              id: 'dsh-open-animation-src',
              type: 'text',
              value: draft,
              spellCheck: false,
              placeholder: '留空 = 关闭；或填写例如 D:\\wallpapers\\opening.webm',
              style: { ...inputStyle, flex: '1 1 auto' },
              onChange: (event) => edit(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void save()
              },
            }),
            h('button', { type: 'button', disabled: busy !== '', onClick: browse, style: buttonStyle }, busy === 'pick' ? '选择中…' : '选择文件…'),
          ),
          h('div', { style: { ...hintStyle, color: tone[status.tone] } }, status.text),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '18px' } },
          h('button', { type: 'button', disabled: busy !== '', onClick: () => void save(), style: buttonStyle }, busy === 'save' ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            disabled: busy !== '',
            onClick: () => {
              edit('')
              void save({ src: '' }, 'clear')
            },
            style: buttonStyle,
          }, '清除（关闭开屏）'),
          h('button', {
            type: 'button',
            disabled: !controller.playable,
            // The draft path may be unsaved, so say which material this plays.
            title: controller.playable ? `播放当前生效的素材：${controller.source.name || '自带动画'}` : '没有可播放的素材',
            onClick: () => {
              if (controller.preview()) {
                setNotice({ tone: 'muted', text: '正在预览当前生效的素材（想预览输入框里的新路径，先点「保存」）' })
              } else {
                setNotice({ tone: 'warn', text: `没有可播放的素材：${controller.message || '先在设置页选一个文件'}` })
              }
            },
            style: buttonStyle,
          }, '预览'),
        ),
        notice ? h('div', { style: { ...hintStyle, color: tone[notice.tone] ?? 'inherit', marginBottom: '18px' } }, notice.text) : null,
        controller.source.path
          ? h('div', { style: { ...rowStyle, gap: '4px' } },
              h('div', { style: labelStyle }, '当前素材'),
              h('div', { style: hintStyle }, `${controller.source.path}（${controller.source.kind || '未知类型'}，${formatSize(controller.source.size)}）`),
            )
          : null,
        h('div', { style: { ...rowStyle, gap: '10px' } },
          h('div', { style: labelStyle }, '播放选项'),
          h(ToggleField, { label: '静音播放', fieldKey: 'muted', config: controller.config, commit: save, busy }),
          h(ToggleField, { label: '应用就绪后再开始', fieldKey: 'coverBeforePaint', config: controller.config, commit: save, busy }),
          h(SelectField, {
            label: '填充方式',
            fieldKey: 'fit',
            options: [['cover', '铺满裁切'], ['contain', '完整显示'], ['fill', '拉伸填满']],
            config: controller.config,
            commit: save,
            busy,
          }),
          h(SelectField, {
            label: '退出方式',
            fieldKey: 'skip',
            options: [['button', '右下角按钮'], ['click', '点任意位置'], ['auto', '自动退出'], ['never', '不可退出']],
            config: controller.config,
            commit: save,
            busy,
          }),
          h(NumberField, { label: '渐隐时长 (ms)', fieldKey: 'fadeOutMs', config: controller.config, commit: save, busy }),
          h(NumberField, { label: '最长播放 (ms，0 = 播完)', fieldKey: 'duration', config: controller.config, commit: save, busy }),
        ),
        h('div', { style: hintStyle }, '改动即时生效，不需要重启。数值框按回车或点到别处才保存。想调更多字段（fadeInMs、volume、playbackRate、maxReplays…）请直接改 profile 的 cordis.patch.yml。'),
      )
    }

    const buttonStyle = {
      padding: '7px 14px',
      borderRadius: '6px',
      border: `1px solid ${T.border}`,
      background: T.surface,
      color: T.text,
      font: 'inherit',
      fontSize: '13px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      ...controlStyle,
    }

    function formatSize(bytes) {
      if (!bytes) return '大小未知'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    const fieldRowStyle = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }
    const fieldLabelStyle = { minWidth: '150px', color: T.text }
    const fieldInputStyle = {
      padding: '4px 8px',
      borderRadius: '6px',
      border: `1px solid ${T.border}`,
      background: T.surface,
      color: T.text,
      font: 'inherit',
      fontSize: '13px',
      ...controlStyle,
    }

    function ToggleField({ label, fieldKey, config, commit, busy }) {
      return h('label', { style: { ...fieldRowStyle, cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: Boolean(config[fieldKey]),
          disabled: busy !== '',
          // A checkbox commits on change: there is no half-typed state to protect.
          onChange: (event) => void commit({ [fieldKey]: event.target.checked }, fieldKey),
        }),
        label,
      )
    }

    function SelectField({ label, fieldKey, options, config, commit, busy }) {
      return h('label', { style: fieldRowStyle },
        h('span', { style: fieldLabelStyle }, label),
        h('select', {
          value: config[fieldKey],
          disabled: busy !== '',
          style: fieldInputStyle,
          onChange: (event) => void commit({ [fieldKey]: event.target.value }, fieldKey),
        }, options.map(([value, text]) => h('option', { key: value, value }, text))),
      )
    }

    /**
     * A numeric setting. The draft lives here and is committed on blur or Enter — NOT on
     * every keystroke, because each keystroke would fire a save, and the save response
     * re-adopts the config and resets the input under the caret.
     */
    function NumberField({ label, fieldKey, config, commit, busy }) {
      const committed = config[fieldKey]
      const [draft, setDraft] = useState(String(committed ?? ''))
      const focused = useRef(false)

      useEffect(() => {
        if (!focused.current) setDraft(String(committed ?? ''))
      }, [committed])

      const commitDraft = () => {
        focused.current = false
        const text = draft.trim()
        // An emptied box is not a number; restore the stored value rather than saving NaN.
        if (text === '') {
          setDraft(String(committed ?? ''))
          return
        }
        const next = Number(text)
        if (!Number.isFinite(next)) {
          setDraft(String(committed ?? ''))
          return
        }
        if (next === committed) return
        void commit({ [fieldKey]: next }, fieldKey)
      }

      return h('label', { style: fieldRowStyle },
        h('span', { style: fieldLabelStyle }, label),
        h('input', {
          type: 'number',
          min: 0,
          step: 50,
          value: draft,
          // Never disabled: the commit happens on blur, so a save in flight must not
          // swallow the edit that is still being typed.
          style: { ...fieldInputStyle, width: '120px' },
          onFocus: () => {
            focused.current = true
          },
          onChange: (event) => setDraft(event.target.value),
          onBlur: commitDraft,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitDraft()
            } else if (event.key === 'Escape') {
              setDraft(String(committed ?? ''))
              event.currentTarget.blur()
            }
          },
        }),
      )
    }

    // ------------------------------------------------------------------ plugin

    return {
      inject: ['slots'],
      apply(ctx) {
        const splash = openLayer()

        controller.finish = () => splash?.remove(false)
        controller.preview = () => startSplashPreview()

        // Everything that depends on the resolved config runs inside one owned effect,
        // and disposes through a single holder so a late disposer is never orphaned.
        let pendingStop = null
        ctx.effect(() => () => {
          if (pendingStop) pendingStop()
          splash?.dispose()
          if (controller.previewLayer) controller.previewLayer.dispose()
        })

        // Armed before the first await: if the Host never answers, the cover must still
        // come down on its own rather than leaving a black screen behind.
        splash?.armDeadline(DEFAULTS.fallbackRemoveMs)

        void refresh().then((playable) => {
          if (!playable) {
            splash?.remove(false)
            return
          }
          splash?.armPlaybackDeadline()

          if (!controller.config.coverBeforePaint) {
            splash?.begin()
            return
          }
          // Hold the black cover until #root actually renders, so the app never flashes.
          const root = document.getElementById('root')
          if (!root || root.childElementCount > 0) {
            splash?.begin()
            return
          }
          const stopWatch = startWatch(root, () => splash?.begin(), controller.config.waitForAppMs || 2500)
          pendingStop = () => stopWatch()
        })

        // Slots are how both visible pieces reach the shell; a composition without the
        // slot service still gets the splash, just without the skip button and settings page.
        const slots = ctx.slots
        if (!slots) return

        slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: 'dsh-open-animation-skip', order: 1000 }, SkipButton),
        )

        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'dsh-open-animation', order: 60, label: '开屏动画' },
            SettingsPage,
          ),
        )
      },
    }
  },
})

/** Wait for `#root` to gain its first child, or give up after `timeoutMs`. */
function startWatch(root, onReady, timeoutMs) {
  let stopped = false
  const observer = new MutationObserver(() => {
    if (stopped) return
    if (root.childElementCount > 0) {
      stop()
      onReady()
    }
  })
  observer.observe(root, { childList: true })
  const timer = setTimeout(() => {
    if (stopped) return
    stop()
    onReady()
  }, timeoutMs)
  function stop() {
    stopped = true
    observer.disconnect()
    clearTimeout(timer)
  }
  return stop
}
