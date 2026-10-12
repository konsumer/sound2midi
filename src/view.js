// spectrum + waterfall canvases, with draggable band overlays
import { DISPLAY_POINTS, DISPLAY_MIN_HZ, DISPLAY_MAX_HZ } from './defaults.js'
import { describeAction } from './devices/v4ex.js'

const DB_MIN = -100
const DB_MAX = 0
const MARGIN = { left: 40, right: 10, top: 10, bottom: 20 }
const EDGE_PX = 6
const LINE_PX = 6
const WATERFALL_ROWS = 800
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`
export const freqToNote = (f) => Math.round(69 + 12 * Math.log2(f / 440))
export const formatHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : `${Math.round(f)}`)

const clampHz = (f) => Math.min(DISPLAY_MAX_HZ, Math.max(DISPLAY_MIN_HZ, f))

// inferno-ish colormap
const STOPS = [
  [0, 0, 0, 4],
  [0.25, 66, 10, 104],
  [0.5, 147, 38, 103],
  [0.7, 221, 81, 58],
  [0.85, 252, 165, 10],
  [1, 252, 255, 164]
]
const COLORMAP = (() => {
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let k = 0
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++
    const [t0, ...c0] = STOPS[k]
    const [t1, ...c1] = STOPS[k + 1]
    const u = (t - t0) / (t1 - t0)
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * u
  }
  return lut
})()

const withAlpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

export const outputSummary = (m) => {
  if (m.output === 'note') return `${noteName(m.note)} · ch${m.channel}`
  if (m.output === 'cc') return `CC${m.cc} · ch${m.channel}`
  if (m.output === 'osc') return `${m.oscAddress} (${m.oscMode})`
  return m.actions.length ? `V-4EX: ${m.actions.map(describeAction).join(' + ')}` : 'V-4EX: no actions'
}

// device outputs can mix triggered and level-following steps, so they may show both
export const usesThreshold = (m) => m.output === 'note' || (m.output === 'osc' && m.oscMode === 'gate') || (m.output === 'device' && (!m.steps.length || m.steps.some((s) => s.trigger !== 'value')))
export const usesRange = (m) => m.output === 'cc' || (m.output === 'osc' && m.oscMode === 'value') || (m.output === 'device' && m.steps.some((s) => s.trigger === 'value'))

export class SpectrumView {
  constructor({ spectrumCanvas, waterfallCanvas, readout, app }) {
    this.canvas = spectrumCanvas
    this.wCanvas = waterfallCanvas
    this.readout = readout
    this.app = app
    this.ctx = spectrumCanvas.getContext('2d')
    this.wCtx = waterfallCanvas.getContext('2d')
    this.display = new Float32Array(DISPLAY_POINTS).fill(-120)
    this.peaks = new Float32Array(DISPLAY_POINTS).fill(-120)
    this.bands = new Map()
    this.drag = null
    this.hover = null

    // waterfall is drawn at spectrum resolution, then scaled to fit
    this.wBuffer = document.createElement('canvas')
    this.wBuffer.width = DISPLAY_POINTS
    this.wBuffer.height = WATERFALL_ROWS
    this.wBufCtx = this.wBuffer.getContext('2d')
    this.wBufCtx.fillStyle = '#000'
    this.wBufCtx.fillRect(0, 0, DISPLAY_POINTS, WATERFALL_ROWS)
    this.row = this.wBufCtx.createImageData(DISPLAY_POINTS, 1)

    const ro = new ResizeObserver(() => this.resize())
    ro.observe(this.canvas)
    ro.observe(this.wCanvas)
    this.resize()
    this.bindEvents()
    const loop = () => {
      this.draw()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  resize() {
    const dpr = window.devicePixelRatio || 1
    for (const c of [this.canvas, this.wCanvas]) {
      const r = c.getBoundingClientRect()
      c.width = Math.max(1, Math.round(r.width * dpr))
      c.height = Math.max(1, Math.round(r.height * dpr))
    }
    this.dpr = dpr
  }

  get w() {
    return this.canvas.width / this.dpr
  }

  get h() {
    return this.canvas.height / this.dpr
  }

  get plotW() {
    return this.w - MARGIN.left - MARGIN.right
  }

  get plotH() {
    return this.h - MARGIN.top - MARGIN.bottom
  }

  xOf(f) {
    return MARGIN.left + (Math.log(f / DISPLAY_MIN_HZ) / Math.log(DISPLAY_MAX_HZ / DISPLAY_MIN_HZ)) * this.plotW
  }

  fOf(x) {
    const t = (x - MARGIN.left) / this.plotW
    return DISPLAY_MIN_HZ * Math.pow(DISPLAY_MAX_HZ / DISPLAY_MIN_HZ, t)
  }

  yOf(db) {
    return MARGIN.top + ((DB_MAX - db) / (DB_MAX - DB_MIN)) * this.plotH
  }

  dbOf(y) {
    return DB_MAX - ((y - MARGIN.top) / this.plotH) * (DB_MAX - DB_MIN)
  }

  pushFrame(frame) {
    const s = frame.spectrum
    for (let i = 0; i < DISPLAY_POINTS; i++) {
      // fast rise, smooth fall so it reads well at 60fps
      this.display[i] = s[i] > this.display[i] ? s[i] : this.display[i] * 0.6 + s[i] * 0.4
      this.peaks[i] = Math.max(s[i], this.peaks[i] - 0.4)
    }
    this.bands.clear()
    for (const b of frame.bands) this.bands.set(b.id, b)

    // scroll waterfall down one row, paint the new row on top
    const ctx = this.wBufCtx
    ctx.drawImage(this.wBuffer, 0, 0, DISPLAY_POINTS, WATERFALL_ROWS - 1, 0, 1, DISPLAY_POINTS, WATERFALL_ROWS - 1)
    const d = this.row.data
    for (let i = 0; i < DISPLAY_POINTS; i++) {
      const t = Math.min(1, Math.max(0, (s[i] - DB_MIN) / (DB_MAX - DB_MIN)))
      const k = Math.round(t * 255) * 3
      d[i * 4] = COLORMAP[k]
      d[i * 4 + 1] = COLORMAP[k + 1]
      d[i * 4 + 2] = COLORMAP[k + 2]
      d[i * 4 + 3] = 255
    }
    ctx.putImageData(this.row, 0, 0)
  }

  draw() {
    const { ctx, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)
    this.drawGrid()
    this.drawSpectrum()
    this.drawBands()
    this.drawWaterfall()
  }

  drawGrid() {
    const { ctx } = this
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (let db = DB_MAX; db >= DB_MIN; db -= 12) {
      const y = Math.round(this.yOf(db)) + 0.5
      ctx.beginPath()
      ctx.moveTo(MARGIN.left, y)
      ctx.lineTo(this.w - MARGIN.right, y)
      ctx.stroke()
      ctx.fillText(`${db}`, MARGIN.left - 6, y)
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const f of FREQ_TICKS) {
      const x = Math.round(this.xOf(f)) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, MARGIN.top)
      ctx.lineTo(x, this.h - MARGIN.bottom)
      ctx.stroke()
      ctx.fillText(formatHz(f), x, this.h - MARGIN.bottom + 5)
    }
  }

  drawSpectrum() {
    const { ctx } = this
    const step = this.plotW / (DISPLAY_POINTS - 1)
    const bottom = this.h - MARGIN.bottom
    ctx.save()
    ctx.beginPath()
    ctx.rect(MARGIN.left, MARGIN.top, this.plotW, this.plotH)
    ctx.clip()

    ctx.beginPath()
    ctx.moveTo(MARGIN.left, bottom)
    for (let i = 0; i < DISPLAY_POINTS; i++) ctx.lineTo(MARGIN.left + i * step, this.yOf(this.display[i]))
    ctx.lineTo(MARGIN.left + this.plotW, bottom)
    ctx.closePath()
    const g = ctx.createLinearGradient(0, MARGIN.top, 0, bottom)
    g.addColorStop(0, 'rgba(226, 232, 240, 0.45)')
    g.addColorStop(1, 'rgba(226, 232, 240, 0.02)')
    ctx.fillStyle = g
    ctx.fill()
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)'
    ctx.lineWidth = 1.25
    ctx.stroke()

    ctx.beginPath()
    for (let i = 0; i < DISPLAY_POINTS; i++) {
      const x = MARGIN.left + i * step
      const y = this.yOf(this.peaks[i])
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    }
    ctx.strokeStyle = 'rgba(246, 173, 85, 0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  }

  hline(x0, x1, y, color, dash = []) {
    const { ctx } = this
    ctx.setLineDash(dash)
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  drawBands() {
    const { ctx } = this
    const top = MARGIN.top
    const bottom = this.h - MARGIN.bottom
    const selected = this.app.selectedId
    const mappings = [...this.app.config.mappings].sort((a, b) => (a.id === selected) - (b.id === selected))
    for (const m of mappings) {
      const x0 = this.xOf(clampHz(Math.min(m.lowHz, m.highHz)))
      const x1 = this.xOf(clampHz(Math.max(m.lowHz, m.highHz)))
      const live = this.bands.get(m.id)
      const isSel = m.id === selected
      const color = m.enabled ? m.color : '#718096'

      ctx.fillStyle = withAlpha(color, live?.active ? 0.32 : isSel ? 0.14 : 0.08)
      ctx.fillRect(x0, top, x1 - x0, bottom - top)
      ctx.lineWidth = isSel ? 2 : 1
      ctx.strokeStyle = withAlpha(color, isSel ? 1 : 0.6)
      ctx.setLineDash(m.enabled ? [] : [4, 4])
      ctx.beginPath()
      ctx.moveTo(x0, top)
      ctx.lineTo(x0, bottom)
      ctx.moveTo(x1, top)
      ctx.lineTo(x1, bottom)
      ctx.stroke()
      ctx.setLineDash([])

      ctx.lineWidth = isSel ? 2 : 1.25
      if (usesThreshold(m)) {
        this.hline(x0, x1, this.yOf(m.thresholdDb), withAlpha(color, 0.95))
        if (m.hysteresisDb > 0) this.hline(x0, x1, this.yOf(m.thresholdDb - m.hysteresisDb), withAlpha(color, 0.45), [3, 3])
      }
      if (usesRange(m)) {
        const yMax = this.yOf(m.maxDb)
        const yMin = this.yOf(m.minDb)
        ctx.fillStyle = withAlpha(color, 0.08)
        ctx.fillRect(x0, yMax, x1 - x0, yMin - yMax)
        this.hline(x0, x1, yMax, withAlpha(color, 0.9), [6, 3])
        this.hline(x0, x1, yMin, withAlpha(color, 0.9), [2, 3])
      }

      // current band level
      if (live && m.enabled) {
        const y = this.yOf(Math.max(DB_MIN, live.levelDb))
        ctx.fillStyle = withAlpha(color, 0.9)
        ctx.fillRect(x0 + 2, y - 1.5, Math.max(2, x1 - x0 - 4), 3)
        // value meter along the right edge
        const mh = (bottom - top) * live.value
        ctx.fillStyle = withAlpha(color, 0.7)
        ctx.fillRect(x1 - 5, bottom - mh, 3, mh)
      }

      if (isSel) {
        ctx.fillStyle = color
        const hy = (top + bottom) / 2
        ctx.fillRect(x0 - 3, hy - 12, 6, 24)
        ctx.fillRect(x1 - 3, hy - 12, 6, 24)
      }

      ctx.save()
      ctx.beginPath()
      ctx.rect(x0, top, Math.max(0, x1 - x0), bottom - top)
      ctx.clip()
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.font = '600 11px system-ui, sans-serif'
      ctx.fillStyle = withAlpha(color, 1)
      ctx.fillText(m.name, x0 + 5, top + 4)
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillText(outputSummary(m), x0 + 5, top + 18)
      ctx.restore()
    }
  }

  drawWaterfall() {
    const c = this.wCtx
    const dpr = this.dpr
    const w = this.wCanvas.width / dpr
    const h = this.wCanvas.height / dpr
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.fillStyle = '#05060a'
    c.fillRect(0, 0, w, h)
    c.imageSmoothingEnabled = true
    // one row per css pixel, newest at the top
    const rows = Math.min(WATERFALL_ROWS, Math.ceil(h))
    c.drawImage(this.wBuffer, 0, 0, DISPLAY_POINTS, rows, MARGIN.left, 0, this.plotW, rows)
    for (const m of this.app.config.mappings) {
      if (!m.enabled) continue
      const live = this.bands.get(m.id)
      c.strokeStyle = withAlpha(m.color, m.id === this.app.selectedId ? 0.9 : 0.4)
      c.lineWidth = 1
      for (const f of [m.lowHz, m.highHz]) {
        const x = Math.round(this.xOf(clampHz(f))) + 0.5
        c.beginPath()
        c.moveTo(x, 0)
        c.lineTo(x, h)
        c.stroke()
      }
      if (live?.active) {
        const x0 = this.xOf(clampHz(m.lowHz))
        c.fillStyle = withAlpha(m.color, 0.9)
        c.fillRect(x0, 0, this.xOf(clampHz(m.highHz)) - x0, 3)
      }
    }
  }

  // which band (and which part of it) is under the pointer
  hitTest(x, y) {
    const sel = this.app.selectedId
    const list = [...this.app.config.mappings].sort((a, b) => (b.id === sel) - (a.id === sel))
    for (const m of list) {
      const x0 = this.xOf(clampHz(Math.min(m.lowHz, m.highHz)))
      const x1 = this.xOf(clampHz(Math.max(m.lowHz, m.highHz)))
      if (x < x0 - EDGE_PX || x > x1 + EDGE_PX) continue
      if (Math.abs(x - x0) <= EDGE_PX) return { m, part: 'low' }
      if (Math.abs(x - x1) <= EDGE_PX) return { m, part: 'high' }
      if (x < x0 || x > x1) continue
      if (usesThreshold(m) && Math.abs(y - this.yOf(m.thresholdDb)) <= LINE_PX) return { m, part: 'threshold' }
      if (usesRange(m)) {
        if (Math.abs(y - this.yOf(m.maxDb)) <= LINE_PX) return { m, part: 'max' }
        if (Math.abs(y - this.yOf(m.minDb)) <= LINE_PX) return { m, part: 'min' }
      }
      return { m, part: 'body' }
    }
    return null
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  updateReadout(x, y) {
    if (x < MARGIN.left || x > this.w - MARGIN.right || y < MARGIN.top || y > this.h - MARGIN.bottom) {
      this.readout.textContent = ''
      return
    }
    const f = this.fOf(x)
    const n = freqToNote(f)
    this.readout.textContent = `${formatHz(f)}Hz · ${n >= 0 && n <= 127 ? noteName(n) : '--'} · ${this.dbOf(y).toFixed(1)}dB`
  }

  bindEvents() {
    const c = this.canvas
    const cursors = { low: 'ew-resize', high: 'ew-resize', threshold: 'ns-resize', min: 'ns-resize', max: 'ns-resize', body: 'grab' }

    c.addEventListener('pointerdown', (e) => {
      const { x, y } = this.pos(e)
      c.setPointerCapture(e.pointerId)
      const hit = this.hitTest(x, y)
      if (hit) {
        this.app.select(hit.m.id)
        this.drag = { part: hit.part, id: hit.m.id, x, y, orig: { ...hit.m } }
        if (hit.part === 'body') c.style.cursor = 'grabbing'
      } else if (x >= MARGIN.left && x <= this.w - MARGIN.right) {
        this.drag = { part: 'create', x, y, created: null }
      }
    })

    c.addEventListener('pointermove', (e) => {
      const { x, y } = this.pos(e)
      this.updateReadout(x, y)
      const d = this.drag
      if (!d) {
        const hit = this.hitTest(x, y)
        c.style.cursor = hit ? cursors[hit.part] : 'crosshair'
        return
      }
      const f = clampHz(this.fOf(x))
      const db = Math.round(Math.min(DB_MAX, Math.max(DB_MIN, this.dbOf(y))) * 2) / 2
      if (d.part === 'create') {
        if (Math.abs(x - d.x) < 4) return
        const f0 = clampHz(this.fOf(d.x))
        const patch = { lowHz: Math.min(f0, f), highHz: Math.max(f0, f) }
        if (!d.created) d.created = this.app.addMapping({ ...patch, thresholdDb: Math.round(this.dbOf(d.y)) })
        else this.app.updateMapping(d.created, patch)
      } else if (d.part === 'low' || d.part === 'high') {
        this.app.updateMapping(d.id, { [d.part === 'low' ? 'lowHz' : 'highHz']: f })
      } else if (d.part === 'threshold') {
        this.app.updateMapping(d.id, { thresholdDb: db })
      } else if (d.part === 'min' || d.part === 'max') {
        this.app.updateMapping(d.id, { [`${d.part}Db`]: db })
      } else if (d.part === 'body') {
        // shift in log space so the band keeps its width in octaves
        const ratio = this.fOf(x) / this.fOf(d.x)
        let lo = d.orig.lowHz * ratio
        let hi = d.orig.highHz * ratio
        if (lo < DISPLAY_MIN_HZ) {
          hi *= DISPLAY_MIN_HZ / lo
          lo = DISPLAY_MIN_HZ
        }
        if (hi > DISPLAY_MAX_HZ) {
          lo *= DISPLAY_MAX_HZ / hi
          hi = DISPLAY_MAX_HZ
        }
        this.app.updateMapping(d.id, { lowHz: lo, highHz: hi })
      }
    })

    const end = () => {
      const d = this.drag
      this.drag = null
      if (!d) return
      if (d.part === 'create' && !d.created) this.app.select(null)
      // normalize edges if they were dragged past each other
      const m = this.app.config.mappings.find((x) => x.id === (d.id || d.created))
      if (m && m.lowHz > m.highHz) this.app.updateMapping(m.id, { lowHz: m.highHz, highHz: m.lowHz })
      c.style.cursor = 'crosshair'
    }
    c.addEventListener('pointerup', end)
    c.addEventListener('pointercancel', end)
    c.addEventListener('pointerleave', () => {
      if (!this.drag) this.readout.textContent = ''
    })

    c.addEventListener('dblclick', (e) => {
      const { x, y } = this.pos(e)
      if (this.hitTest(x, y)) return
      const f = this.fOf(x)
      const k = Math.pow(2, 1 / 6)
      this.app.addMapping({ lowHz: clampHz(f / k), highHz: clampHz(f * k), thresholdDb: Math.round(this.dbOf(y)) })
    })

    // wheel over a band changes its width around its center
    c.addEventListener(
      'wheel',
      (e) => {
        const { x, y } = this.pos(e)
        const hit = this.hitTest(x, y)
        if (!hit) return
        e.preventDefault()
        const m = hit.m
        const center = Math.sqrt(m.lowHz * m.highHz)
        const half = Math.max(1.0005, Math.sqrt(m.highHz / m.lowHz) * Math.exp(e.deltaY * 0.002))
        this.app.select(m.id)
        this.app.updateMapping(m.id, { lowHz: clampHz(center / half), highHz: clampHz(center * half) })
      },
      { passive: false }
    )
  }
}
