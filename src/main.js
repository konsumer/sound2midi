import { defaultMapping, PALETTE, DISPLAY_MIN_HZ, DISPLAY_MAX_HZ } from './defaults.js'
import { SpectrumView, noteName, formatHz, outputSummary, usesThreshold, usesRange } from './view.js'
import { compile, defaultAction } from './devices/v4ex.js'
import { renderDeviceEditor, openDeviceSetup } from './deviceUi.js'

const $ = (id) => document.getElementById(id)
const isTauri = !!window.__TAURI_INTERNALS__
const clampHz = (f) => Math.min(DISPLAY_MAX_HZ, Math.max(DISPLAY_MIN_HZ, f))

let toastTimer
const toast = (msg, isError = true) => {
  const el = $('toast')
  el.textContent = msg
  el.classList.toggle('error', isError)
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000)
}

const backend = await (isTauri ? import('./backend/tauri.js') : import('./backend/web.js')).then((m) => m.createBackend())

const app = {
  config: await backend.getConfig(),
  selectedId: null,
  running: false,

  select(id) {
    if (this.selectedId === id) return
    this.selectedId = id
    renderList()
    renderEditor()
  },

  addMapping(patch = {}) {
    const n = this.config.mappings.length
    const used = new Set(this.config.mappings.map((m) => m.note))
    let note = 36
    while (used.has(note) && note < 127) note++
    const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const m = { ...defaultMapping(), id, name: `Band ${n + 1}`, color: PALETTE[n % PALETTE.length], note, oscAddress: `/sound2midi/band${n + 1}`, ...patch }
    this.config.mappings.push(m)
    this.selectedId = id
    commit()
    renderList()
    renderEditor()
    return id
  },

  updateMapping(id, patch) {
    const m = this.config.mappings.find((x) => x.id === id)
    if (!m) return
    Object.assign(m, patch)
    commit()
    syncEditor()
    renderListItem(m)
  },

  removeMapping(id) {
    this.config.mappings = this.config.mappings.filter((m) => m.id !== id)
    if (this.selectedId === id) this.selectedId = null
    commit()
    renderList()
    renderEditor()
  }
}

// device outputs are sent to the engines as compiled message steps
const compileSteps = () => {
  for (const m of app.config.mappings) m.steps = m.output === 'device' ? compile(m.actions, app.config.devices.v4ex).steps : []
}

// push config to the backend, coalescing rapid edits (e.g. dragging)
let commitTimer = null
const commit = () => {
  compileSteps()
  if (commitTimer) return
  commitTimer = setTimeout(async () => {
    commitTimer = null
    try {
      await backend.setConfig(structuredClone(app.config))
    } catch (e) {
      toast(String(e))
    }
  }, 40)
}

const setGlobal = (patch) => {
  Object.assign(app.config, patch)
  commit()
}

// ---- toolbar ----

const fillSelect = (sel, items, value, extra = []) => {
  sel.innerHTML = ''
  for (const { id, name } of [...extra, ...items]) {
    const o = document.createElement('option')
    o.value = id ?? ''
    o.textContent = name
    sel.appendChild(o)
  }
  sel.value = value ?? ''
  if (sel.value !== (value ?? '') && value) {
    // keep a remembered device visible even when it's unplugged
    const o = document.createElement('option')
    o.value = value
    o.textContent = `${value} (missing)`
    sel.appendChild(o)
    sel.value = value
  }
}

const refreshDevices = async () => {
  try {
    const inputs = await backend.listInputs()
    fillSelect($('input'), inputs, app.config.inputDevice, [{ id: '', name: 'System default' }])
  } catch (e) {
    toast(`Inputs: ${e}`)
  }
  try {
    const { ports, virtualSupported, unavailable } = await backend.listMidiOutputs()
    const extra = [{ id: '', name: unavailable ? 'Web MIDI unavailable' : 'None' }]
    if (virtualSupported) extra.push({ id: '__virtual__', name: 'Virtual port (sound2midi)' })
    fillSelect($('midi'), ports, app.config.midiOutput, extra)
  } catch (e) {
    toast(`MIDI: ${e}`)
  }
}

const setChannels = (count) => {
  const sel = $('channel')
  sel.innerHTML = '<option value="0">Mix</option>'
  for (let i = 1; i <= count; i++) sel.insertAdjacentHTML('beforeend', `<option value="${i}">Ch ${i}</option>`)
  sel.value = app.config.inputChannel <= count ? app.config.inputChannel : 0
  sel.disabled = count <= 1
}

const setRunning = (running) => {
  app.running = running
  $('start').textContent = running ? 'Stop' : 'Start'
  $('start').classList.toggle('primary', !running)
  document.body.classList.toggle('running', running)
}

const start = async () => {
  try {
    const info = await backend.start()
    setRunning(true)
    setChannels(info.channels)
    // browsers only reveal device labels after permission is granted
    if (!isTauri) await refreshDevices()
  } catch (e) {
    setRunning(false)
    toast(`Audio: ${e?.message || e}`)
  }
}

const initToolbar = () => {
  $('mode').textContent = isTauri ? 'desktop' : 'web'
  $('oscGroup').hidden = !backend.capabilities.osc
  $('gain').value = app.config.inputGainDb
  $('gainValue').textContent = `${app.config.inputGainDb}dB`
  $('fft').value = app.config.fftSize
  $('oscHost').value = app.config.oscHost
  $('oscPort').value = app.config.oscPort

  $('start').onclick = async () => {
    if (app.running) {
      await backend.stop()
      setRunning(false)
    } else {
      await start()
    }
  }
  $('input').onchange = (e) => setGlobal({ inputDevice: e.target.value || null, inputChannel: 0 })
  $('channel').onchange = (e) => setGlobal({ inputChannel: +e.target.value })
  $('gain').oninput = (e) => {
    $('gainValue').textContent = `${e.target.value}dB`
    setGlobal({ inputGainDb: +e.target.value })
  }
  $('fft').onchange = (e) => setGlobal({ fftSize: +e.target.value })
  $('midi').onchange = (e) => setGlobal({ midiOutput: e.target.value || null })
  $('oscHost').onchange = (e) => setGlobal({ oscHost: e.target.value.trim() })
  $('oscPort').onchange = (e) => setGlobal({ oscPort: Math.min(65535, Math.max(1, +e.target.value || 9000)) })
  $('refresh').onclick = async () => {
    await refreshDevices()
    try {
      await backend.reconnect()
    } catch (e) {
      toast(String(e))
    }
  }
  $('panic').onclick = () => backend.panic()
  $('save').onclick = () => backend.savePreset().catch((e) => toast(String(e)))
  $('load').onclick = async () => {
    try {
      const cfg = await backend.loadPreset()
      if (!cfg) return
      app.config = cfg
      await backend.setConfig(structuredClone(cfg))
      app.selectedId = null
      initToolbar()
      renderList()
      renderEditor()
      toast('Preset loaded', false)
    } catch (e) {
      toast(`Preset: ${e}`)
    }
  }
  $('add').onclick = () => {
    // drop new bands into the biggest free gap
    const edges = app.config.mappings
      .flatMap((m) => [m.lowHz, m.highHz])
      .concat([DISPLAY_MIN_HZ, DISPLAY_MAX_HZ])
      .sort((a, b) => a - b)
    let best = [200, 400]
    let bestRatio = 0
    for (let i = 0; i < edges.length - 1; i++) {
      const r = edges[i + 1] / edges[i]
      if (r > bestRatio) {
        bestRatio = r
        best = [edges[i], edges[i + 1]]
      }
    }
    const c = Math.sqrt(best[0] * best[1])
    const k = Math.min(Math.pow(2, 1 / 3), Math.sqrt(bestRatio))
    app.addMapping({ lowHz: clampHz(c / k), highHz: clampHz(c * k) })
  }
}

// ---- trigger list ----

const listItems = new Map()

const renderListItem = (m) => {
  const li = listItems.get(m.id)
  if (!li) return
  li.querySelector('.name').textContent = m.name
  li.querySelector('.sub').textContent = `${formatHz(m.lowHz)}–${formatHz(m.highHz)}Hz → ${outputSummary(m)}`
  li.querySelector('.dot').style.background = m.color
  li.querySelector('input').checked = m.enabled
  li.classList.toggle('disabled', !m.enabled)
}

const renderList = () => {
  const ul = $('list')
  ul.innerHTML = ''
  listItems.clear()
  for (const m of app.config.mappings) {
    const li = document.createElement('li')
    li.className = 'item'
    li.classList.toggle('selected', m.id === app.selectedId)
    li.innerHTML = `
      <span class="dot"></span>
      <div class="info"><div class="name"></div><div class="sub mono"></div></div>
      <span class="led"></span>
      <input type="checkbox" title="Enabled" />
      <div class="bar"><div></div></div>`
    li.onclick = (e) => {
      if (e.target.tagName !== 'INPUT') app.select(m.id)
    }
    li.querySelector('input').onchange = (e) => app.updateMapping(m.id, { enabled: e.target.checked })
    ul.appendChild(li)
    listItems.set(m.id, li)
    renderListItem(m)
  }
  if (!app.config.mappings.length) ul.innerHTML = '<li class="empty">No triggers yet. Drag across the spectrum to add one.</li>'
}

// ---- editor ----

const field = (label, key, attrs = {}) => {
  const { type = 'number', options, step = 'any', min, max, suffix = '' } = attrs
  let input
  if (options) {
    input = `<select data-key="${key}">${options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`
  } else {
    input = `<input data-key="${key}" type="${type}" step="${step}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} />`
  }
  return `<label class="field"><span>${label}</span>${input}${suffix ? `<em>${suffix}</em>` : ''}</label>`
}

// derived fields that don't live on the mapping directly
const derived = {
  centerHz: {
    get: (m) => Math.round(Math.sqrt(m.lowHz * m.highHz)),
    set: (m, v) => {
      const half = Math.sqrt(m.highHz / m.lowHz)
      return { lowHz: clampHz(v / half), highHz: clampHz(v * half) }
    }
  },
  widthOct: {
    get: (m) => +Math.log2(m.highHz / m.lowHz).toFixed(3),
    set: (m, v) => {
      const c = Math.sqrt(m.lowHz * m.highHz)
      const half = Math.pow(2, Math.max(0.01, v) / 2)
      return { lowHz: clampHz(c / half), highHz: clampHz(c * half) }
    }
  }
}

const numeric = new Set(['lowHz', 'highHz', 'thresholdDb', 'hysteresisDb', 'minDb', 'maxDb', 'attackMs', 'releaseMs', 'channel', 'note', 'velocity', 'cc', 'centerHz', 'widthOct'])
const intKeys = { channel: [1, 16], note: [0, 127], velocity: [0, 127], cc: [0, 127] }

const renderEditor = () => {
  const el = $('editor')
  const m = app.config.mappings.find((x) => x.id === app.selectedId)
  if (!m) {
    el.innerHTML = '<p class="muted">Select a trigger to edit it, or drag across the spectrum to make a new one.</p>'
    return
  }
  const midiCh = field('Channel', 'channel', { min: 1, max: 16, step: 1 })
  el.innerHTML = `
    <div class="row">
      <input data-key="color" type="color" class="swatch" />
      <input data-key="name" type="text" class="name-input" />
    </div>

    <h3>Frequency band</h3>
    <div class="grid">
      ${field('Start', 'lowHz', { min: 20, max: 20000, suffix: 'Hz' })}
      ${field('End', 'highHz', { min: 20, max: 20000, suffix: 'Hz' })}
      ${field('Center', 'centerHz', { min: 20, max: 20000, suffix: 'Hz' })}
      ${field('Width', 'widthOct', { min: 0.01, max: 10, step: 0.05, suffix: 'oct' })}
    </div>

    <h3>Output</h3>
    <div class="seg" data-seg="output">
      <button data-v="note">Note</button><button data-v="cc">CC</button><button data-v="osc" ${backend.capabilities.osc ? '' : 'disabled title="OSC needs the desktop app"'}>OSC</button><button data-v="device" title="Roland V-4EX video mixer">V-4EX</button>
    </div>
    <div class="grid" data-show="note">
      ${midiCh}
      ${field('Note', 'note', { min: 0, max: 127, step: 1, suffix: '<span data-note></span>' })}
      ${field('Velocity', 'velocity', { min: 0, max: 127, step: 1, suffix: '0=auto' })}
    </div>
    <div class="grid" data-show="cc">
      ${midiCh}
      ${field('CC #', 'cc', { min: 0, max: 127, step: 1 })}
    </div>
    <div class="grid" data-show="osc">
      <label class="field wide"><span>Address</span><input data-key="oscAddress" type="text" class="mono" /></label>
      ${field('Mode', 'oscMode', {
        options: [
          ['value', 'Value (0–1)'],
          ['gate', 'Gate (1/0)']
        ]
      })}
    </div>

    <div data-show="device"><div data-device></div></div>

    <h3>Detection</h3>
    <div class="grid">
      <div data-gate class="contents">
        ${field('Threshold', 'thresholdDb', { min: -120, max: 0, step: 0.5, suffix: 'dB' })}
        ${field('Hysteresis', 'hysteresisDb', { min: 0, max: 48, step: 0.5, suffix: 'dB' })}
      </div>
      <div data-range class="contents">
        ${field('Min', 'minDb', { min: -120, max: 0, step: 0.5, suffix: 'dB' })}
      </div>
      ${field('Max', 'maxDb', { min: -120, max: 0, step: 0.5, suffix: 'dB' })}
      ${field('Attack', 'attackMs', { min: 0, max: 2000, step: 1, suffix: 'ms' })}
      ${field('Release', 'releaseMs', { min: 0, max: 5000, step: 1, suffix: 'ms' })}
    </div>

    <div class="row actions">
      <button data-act="duplicate">Duplicate</button>
      <button data-act="delete" class="danger">Delete</button>
    </div>`

  el.querySelectorAll('[data-key]').forEach((input) => {
    const key = input.dataset.key
    const handler = () => {
      const cur = app.config.mappings.find((x) => x.id === app.selectedId)
      if (!cur) return
      let v = input.value
      if (numeric.has(key)) {
        v = parseFloat(v)
        if (!Number.isFinite(v)) return
        if (intKeys[key]) v = Math.min(intKeys[key][1], Math.max(intKeys[key][0], Math.round(v)))
      }
      app.updateMapping(cur.id, derived[key] ? derived[key].set(cur, v) : { [key]: v })
    }
    input.addEventListener(input.tagName === 'SELECT' || input.type === 'color' ? 'input' : 'change', handler)
    if (input.type === 'number') input.addEventListener('input', handler)
  })
  el.querySelectorAll('[data-seg="output"] button').forEach((b) => {
    b.onclick = () => {
      const cur = app.config.mappings.find((x) => x.id === app.selectedId)
      // start a fresh V-4EX trigger with one action so there's something to edit
      const actions = b.dataset.v === 'device' && !cur.actions.length ? [defaultAction()] : cur.actions
      app.updateMapping(app.selectedId, { output: b.dataset.v, actions })
      redrawDevice()
    }
  })
  const redrawDevice = renderDeviceEditor(el.querySelector('[data-device]'), {
    getMapping: () => app.config.mappings.find((x) => x.id === app.selectedId),
    getProfile: () => app.config.devices.v4ex,
    setActions: (actions) => app.updateMapping(app.selectedId, { actions }),
    openSetup: (redraw) =>
      openDeviceSetup(app.config.devices.v4ex, (profile) => {
        app.config.devices.v4ex = profile
        commit()
        redraw()
        syncEditor()
        renderList()
      })
  })
  el.querySelector('[data-act="delete"]').onclick = () => app.removeMapping(m.id)
  el.querySelector('[data-act="duplicate"]').onclick = () => {
    const { id, ...rest } = m
    app.addMapping({ ...rest, name: `${m.name} copy` })
  }
  syncEditor()
}

// update editor inputs in place, without stealing focus from the one being typed in
const syncEditor = () => {
  const el = $('editor')
  const m = app.config.mappings.find((x) => x.id === app.selectedId)
  if (!m) return
  el.querySelectorAll('[data-key]').forEach((input) => {
    if (input === document.activeElement) return
    const key = input.dataset.key
    let v = derived[key] ? derived[key].get(m) : m[key]
    if (key === 'lowHz' || key === 'highHz') v = Math.round(v * 10) / 10
    input.value = v
  })
  el.querySelectorAll('[data-seg="output"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === m.output))
  el.querySelectorAll('[data-show]').forEach((g) => (g.hidden = g.dataset.show !== m.output))
  el.querySelector('[data-gate]').hidden = !usesThreshold(m)
  el.querySelector('[data-range]').hidden = !usesRange(m)
  const noteEl = el.querySelector('[data-note]')
  if (noteEl) noteEl.textContent = noteName(m.note)
}

// ---- live data ----

const view = new SpectrumView({ spectrumCanvas: $('spectrum'), waterfallCanvas: $('waterfall'), readout: $('readout'), app })

backend.onFrame((frame) => {
  view.pushFrame(frame)
  const pct = Math.max(0, Math.min(1, (frame.peakDb + 60) / 60)) * 100
  $('inputMeter').style.width = `${pct}%`
  $('inputMeter').classList.toggle('clip', frame.peakDb > -1)
  for (const b of frame.bands) {
    const li = listItems.get(b.id)
    if (!li) continue
    li.querySelector('.bar > div').style.width = `${b.value * 100}%`
    li.classList.toggle('active', b.active)
  }
})

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return
  if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId) {
    e.preventDefault()
    app.removeMapping(app.selectedId)
  } else if (e.key === 'Escape') {
    app.select(null)
  }
})

compileSteps()
initToolbar()
renderList()
renderEditor()
await refreshDevices()
// desktop can start right away; browsers want a click before opening the mic
if (isTauri) await start()
