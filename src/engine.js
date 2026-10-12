// JS port of src-tauri/src/engine.rs, used in web mode
import { DISPLAY_POINTS, DISPLAY_MIN_HZ, DISPLAY_MAX_HZ, FLOOR_DB } from './defaults.js'

const HANN_ENBW = 1.5
const HISTORY = 16384
const HOP_MS = 5
const FRAME_MS = 25

const dbToAmp = (db) => Math.pow(10, db / 20)
const powerToDb = (p) => (p <= 0 ? FLOOR_DB : Math.max(FLOOR_DB, 10 * Math.log10(p)))
const normalize = (level, min, max) => {
  if (max <= min) return level >= max ? 1 : 0
  return Math.min(1, Math.max(0, (level - min) / (max - min)))
}

// in-place iterative radix-2 FFT
class FFT {
  constructor(size) {
    this.size = size
    this.rev = new Uint32Array(size)
    const bits = Math.log2(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float32Array(size / 2)
    this.sin = new Float32Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size)
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size)
    }
  }

  process(re, im) {
    const n = this.size
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const step = n / len
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const wr = this.cos[j * step]
          const wi = this.sin[j * step]
          const a = i + j
          const b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }
}

const bandDb = (power, low, high, binHz) => {
  if (low > high) [low, high] = [high, low]
  const last = power.length - 1
  const b0 = Math.min(last, Math.ceil(low / binHz))
  const b1 = Math.min(last, Math.floor(high / binHz))
  let sum = 0
  if (b1 >= b0) {
    for (let k = b0; k <= b1; k++) sum += power[k]
  } else {
    sum = power[Math.min(last, Math.round((low + high) / 2 / binHz))]
  }
  return powerToDb(sum / HANN_ENBW)
}

const displaySpectrum = (power, binHz) => {
  const ratio = Math.pow(DISPLAY_MAX_HZ / DISPLAY_MIN_HZ, 1 / DISPLAY_POINTS)
  const last = power.length - 1
  const out = new Array(DISPLAY_POINTS)
  for (let i = 0; i < DISPLAY_POINTS; i++) {
    const f0 = DISPLAY_MIN_HZ * Math.pow(ratio, i)
    const f1 = f0 * ratio
    const b0 = Math.ceil(f0 / binHz)
    const b1 = Math.ceil(f1 / binHz)
    if (b0 > last) {
      out[i] = FLOOR_DB
      continue
    }
    let p = 0
    if (b1 > b0) {
      for (let k = b0; k < Math.min(b1, last + 1); k++) p = Math.max(p, power[k])
    } else {
      const b = (f0 * Math.sqrt(ratio)) / binHz
      const i0 = Math.min(last, Math.floor(b))
      const i1 = Math.min(last, i0 + 1)
      const t = b - i0
      p = power[i0] * (1 - t) + power[i1] * t
    }
    out[i] = powerToDb(p)
  }
  return out
}

class BandState {
  constructor() {
    this.levelDb = FLOOR_DB
    this.active = false
    this.sentNote = null
    this.sentCc = null
    this.sentOsc = null
    this.cycles = []
    this.sentValues = []
  }

  release(out, m) {
    if (this.sentNote) {
      out.noteOff(...this.sentNote)
      this.sentNote = null
    }
    if (m && this.active && m.output === 'osc' && m.oscMode === 'gate') out.osc(m.oscAddress, 0)
    if (m && this.active && m.output === 'device') sendSteps(m.steps, 'off', this, out)
    this.active = false
  }
}

// fill a step message's value placeholders (-1 = 7-bit, -2/-3 = 14-bit LSB/MSB)
const render = (msg, v) => {
  const v14 = Math.round((v / 127) * 16383)
  return msg.map((b) => (b === -1 ? v : b === -2 ? v14 & 0x7f : b === -3 ? v14 >> 7 : b & 0xff))
}

const sendSteps = (steps, trigger, st, out) => {
  steps.forEach((s, i) => {
    if (s.trigger === trigger) {
      for (const msg of s.msgs) out.raw(render(msg, 0))
    } else if (trigger === 'on' && s.trigger === 'cycle' && s.seq?.length) {
      const n = st.cycles[i] || 0
      for (const msg of s.seq[n % s.seq.length]) out.raw(render(msg, 0))
      st.cycles[i] = (n + 1) % s.seq.length
    }
  })
}

const processDevice = (m, st, out, was) => {
  const steps = m.steps || []
  if (st.steps !== steps) {
    // steps were recompiled, forget per-step state
    st.steps = steps
    st.cycles = []
    st.sentValues = []
  }
  if (st.active && !was) sendSteps(steps, 'on', st, out)
  if (!st.active && was) sendSteps(steps, 'off', st, out)
  const v = normalize(st.levelDb, m.minDb, m.maxDb)
  let follows = false
  steps.forEach((s, i) => {
    if (s.trigger !== 'value') return
    follows = true
    const val = Math.round(Math.min(127, Math.max(0, s.lo + v * (s.hi - s.lo))))
    if (st.sentValues[i] === val) return
    st.sentValues[i] = val
    for (const msg of s.msgs) out.raw(render(msg, val))
  })
  return follows ? v : st.active ? 1 : 0
}

const processBand = (m, st, out) => {
  const level = st.levelDb
  const offDb = m.thresholdDb - Math.max(0, m.hysteresisDb)
  const was = st.active
  const active = was ? level > offDb : level >= m.thresholdDb
  st.active = active

  if (m.output !== 'note' && st.sentNote) {
    out.noteOff(...st.sentNote)
    st.sentNote = null
  }

  if (m.output === 'note') {
    const velNorm = normalize(level, m.thresholdDb, m.maxDb)
    if (st.sentNote && (st.sentNote[0] !== m.channel || st.sentNote[1] !== m.note)) {
      out.noteOff(...st.sentNote)
      st.sentNote = null
      st.active = false
      return velNorm
    }
    if (active && !was) {
      const vel = m.velocity > 0 ? m.velocity : 1 + Math.round(velNorm * 126)
      out.noteOn(m.channel, m.note, vel)
      st.sentNote = [m.channel, m.note]
    } else if (!active && st.sentNote) {
      out.noteOff(...st.sentNote)
      st.sentNote = null
    }
    return active ? 1 : 0
  }

  if (m.output === 'device') return processDevice(m, st, out, was)

  if (m.output === 'cc') {
    const v = normalize(level, m.minDb, m.maxDb)
    const key = `${m.channel}:${m.cc}:${Math.round(v * 127)}`
    if (st.sentCc !== key) {
      out.cc(m.channel, m.cc, Math.round(v * 127))
      st.sentCc = key
    }
    return v
  }

  if (m.oscMode === 'gate') {
    if (active !== was) out.osc(m.oscAddress, active ? 1 : 0)
    return active ? 1 : 0
  }
  const v = normalize(level, m.minDb, m.maxDb)
  if (st.sentOsc === null || Math.abs(st.sentOsc - v) >= 0.002) {
    out.osc(m.oscAddress, v)
    st.sentOsc = v
  }
  return v
}

export class Engine {
  constructor({ getConfig, out, onFrame }) {
    this.getConfig = getConfig
    this.out = out
    this.onFrame = onFrame
    this.states = new Map()
    this.history = new Float32Array(HISTORY)
    this.ctx = null
    this.analyser = null
    this.stream = null
    this.fftSize = 0
    this.last = performance.now()
    this.lastEmit = 0
    this.timer = setInterval(() => this.tick(), HOP_MS)
  }

  async start({ deviceId, channel }) {
    await this.stop()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 32 }
      }
    })
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await ctx.resume()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = HISTORY
    analyser.smoothingTimeConstant = 0
    const track = stream.getAudioTracks()[0]
    const channels = track.getSettings().channelCount || source.channelCount || 1
    if (channel > 0 && channel <= channels) {
      const splitter = ctx.createChannelSplitter(channels)
      source.connect(splitter)
      splitter.connect(analyser, channel - 1)
    } else {
      // analyser downmixes to mono
      source.connect(analyser)
    }
    this.ctx = ctx
    this.stream = stream
    this.analyser = analyser
    return { device: track.label || 'Default input', sampleRate: ctx.sampleRate, channels }
  }

  async stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop())
    if (this.ctx) await this.ctx.close()
    this.stream = null
    this.ctx = null
    this.analyser = null
    this.history.fill(0)
  }

  setupFft(size) {
    this.fftSize = size
    this.fft = new FFT(size)
    this.window = new Float32Array(size)
    let sum = 0
    for (let i = 0; i < size; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
      sum += this.window[i]
    }
    this.windowSum = sum
    this.re = new Float32Array(size)
    this.im = new Float32Array(size)
    this.power = new Float32Array(size / 2)
  }

  tick() {
    const cfg = this.getConfig()
    if (!cfg) return
    const gain = dbToAmp(cfg.inputGainDb)
    const sampleRate = this.ctx ? this.ctx.sampleRate : 48000
    if (this.analyser) this.analyser.getFloatTimeDomainData(this.history)

    const size = Math.min(HISTORY, Math.max(256, cfg.fftSize | 0))
    if (size !== this.fftSize) this.setupFft(size)
    const { re, im, window, power } = this
    const start = HISTORY - size
    for (let i = 0; i < size; i++) {
      re[i] = this.history[start + i] * gain * window[i]
      im[i] = 0
    }
    this.fft.process(re, im)
    const norm = 2 / this.windowSum
    for (let k = 0; k < power.length; k++) {
      const m = Math.hypot(re[k], im[k]) * norm
      power[k] = m * m
    }
    const binHz = sampleRate / size

    const now = performance.now()
    const dt = (now - this.last) / 1000
    this.last = now

    const enabled = cfg.mappings.filter((m) => m.enabled)
    for (const [id, st] of this.states) {
      if (!enabled.some((m) => m.id === id)) {
        st.release(this.out, null)
        this.states.delete(id)
      }
    }
    const bands = []
    for (const m of enabled) {
      const raw = bandDb(power, m.lowHz, m.highHz, binHz)
      let st = this.states.get(m.id)
      if (!st) this.states.set(m.id, (st = new BandState()))
      const ms = raw > st.levelDb ? m.attackMs : m.releaseMs
      const coef = ms <= 0 ? 1 : 1 - Math.exp(-dt / (ms / 1000))
      st.levelDb += (raw - st.levelDb) * coef
      const value = processBand(m, st, this.out)
      bands.push({ id: m.id, levelDb: st.levelDb, value, active: st.active })
    }

    if (now - this.lastEmit >= FRAME_MS) {
      this.lastEmit = now
      let peak = 0
      for (let i = HISTORY - 1024; i < HISTORY; i++) peak = Math.max(peak, Math.abs(this.history[i]))
      this.onFrame({
        spectrum: displaySpectrum(power, binHz),
        bands,
        peakDb: powerToDb(peak * peak * gain * gain),
        sampleRate,
        running: !!this.analyser
      })
    }
  }
}
