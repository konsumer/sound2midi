// browser backend: web audio for input, web midi for output, no OSC (browsers can't send UDP)
import { Engine } from '../engine.js'
import { normalizeConfig } from '../defaults.js'

const STORAGE_KEY = 'sound2midi-config'

const load = () => {
  try {
    return normalizeConfig(JSON.parse(localStorage.getItem(STORAGE_KEY)))
  } catch {
    return normalizeConfig(null)
  }
}

const store = (config) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {}
}

export const createBackend = async () => {
  let config = load()
  let midiAccess = null
  let midiOut = null
  const frameListeners = new Set()

  const connectMidi = () => {
    midiOut = midiAccess && config.midiOutput ? midiAccess.outputs.get(config.midiOutput) || null : null
  }

  const ensureMidi = async () => {
    if (midiAccess || !navigator.requestMIDIAccess) return
    try {
      midiAccess = await navigator.requestMIDIAccess()
      midiAccess.onstatechange = connectMidi
      connectMidi()
    } catch (e) {
      console.warn('Web MIDI unavailable', e)
    }
  }

  const send = (bytes) => midiOut && midiOut.send(bytes)
  const out = {
    noteOn: (ch, note, vel) => send([0x90 | (ch - 1), note & 0x7f, vel]),
    noteOff: (ch, note) => send([0x80 | (ch - 1), note & 0x7f, 0]),
    cc: (ch, cc, v) => send([0xb0 | (ch - 1), cc & 0x7f, v & 0x7f]),
    raw: (bytes) => send(bytes),
    osc: () => {}
  }

  const engine = new Engine({
    getConfig: () => config,
    out,
    onFrame: (f) => frameListeners.forEach((cb) => cb(f))
  })

  let running = null
  const start = async () => {
    running = { device: config.inputDevice, channel: config.inputChannel }
    return engine.start({ deviceId: config.inputDevice, channel: config.inputChannel })
  }

  await ensureMidi()

  return {
    kind: 'web',
    capabilities: { osc: false },
    getConfig: async () => config,
    setConfig: async (next) => {
      const midiChanged = next.midiOutput !== config.midiOutput
      config = normalizeConfig(next)
      store(config)
      if (midiChanged) {
        for (let ch = 1; ch <= 16; ch++) out.cc(ch, 123, 0)
        connectMidi()
      }
      if (running && (running.device !== config.inputDevice || running.channel !== config.inputChannel)) await start()
    },
    listInputs: async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return []
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default').map((d, i) => ({ id: d.deviceId, name: d.label || `Input ${i + 1}` }))
    },
    listMidiOutputs: async () => {
      await ensureMidi()
      const ports = midiAccess ? [...midiAccess.outputs.values()].map((o) => ({ id: o.id, name: o.name })) : []
      return { ports, virtualSupported: false, unavailable: !midiAccess }
    },
    start,
    stop: async () => {
      running = null
      await engine.stop()
    },
    reconnect: async () => connectMidi(),
    panic: async () => {
      for (let ch = 1; ch <= 16; ch++) out.cc(ch, 123, 0)
    },
    onFrame: (cb) => {
      frameListeners.add(cb)
      return () => frameListeners.delete(cb)
    },
    savePreset: async () => {
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'sound2midi-preset.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    },
    loadPreset: () =>
      new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'application/json,.json'
        input.onchange = async () => {
          const file = input.files[0]
          if (!file) return resolve(null)
          const preset = JSON.parse(await file.text())
          resolve(normalizeConfig({ ...preset, inputDevice: config.inputDevice, inputChannel: config.inputChannel, midiOutput: config.midiOutput }))
        }
        input.click()
      })
  }
}
