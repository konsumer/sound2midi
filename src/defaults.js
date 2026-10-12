// mirrors src-tauri/src/config.rs so web mode starts from the same place
import { defaultProfile as v4exProfile } from './devices/v4ex.js'

export const DISPLAY_POINTS = 480
export const DISPLAY_MIN_HZ = 20
export const DISPLAY_MAX_HZ = 20000
export const FLOOR_DB = -120

export const PALETTE = ['#f6ad55', '#4fd1c5', '#b794f4', '#f687b3', '#68d391', '#63b3ed', '#fc8181', '#faf089']

export const defaultMapping = () => ({
  id: 'band',
  name: 'Band',
  color: '#4fd1c5',
  enabled: true,
  lowHz: 200,
  highHz: 400,
  thresholdDb: -30,
  hysteresisDb: 6,
  minDb: -60,
  maxDb: -10,
  attackMs: 5,
  releaseMs: 80,
  output: 'note',
  channel: 1,
  note: 60,
  velocity: 0,
  cc: 1,
  oscAddress: '/sound2midi/band',
  oscMode: 'value',
  // output: 'device' plays compiled steps for a hardware profile (see src/devices)
  device: 'v4ex',
  actions: [],
  steps: []
})

export const defaultConfig = () => ({
  inputDevice: null,
  inputChannel: 0,
  inputGainDb: 0,
  fftSize: 2048,
  midiOutput: null,
  oscHost: '127.0.0.1',
  oscPort: 9000,
  devices: { v4ex: v4exProfile() },
  mappings: [
    { ...defaultMapping(), id: 'kick', name: 'Kick', color: '#f6ad55', lowHz: 40, highHz: 120, note: 36 },
    { ...defaultMapping(), id: 'mids', name: 'Mids', color: '#4fd1c5', lowHz: 500, highHz: 2000, output: 'cc', cc: 1, releaseMs: 150 },
    { ...defaultMapping(), id: 'hats', name: 'Hats', color: '#b794f4', lowHz: 7000, highHz: 14000, thresholdDb: -40, output: 'osc', oscAddress: '/sound2midi/hats', oscMode: 'gate' }
  ]
})

// fill in any fields missing from an older/partial config
export const normalizeConfig = (cfg) => {
  const base = defaultConfig()
  const out = { ...base, ...(cfg || {}) }
  out.mappings = (cfg?.mappings || base.mappings).map((m) => ({ ...defaultMapping(), ...m }))
  const v4ex = cfg?.devices?.v4ex || {}
  out.devices = { ...cfg?.devices, v4ex: { ...base.devices.v4ex, ...v4ex, assign: { ...base.devices.v4ex.assign, ...v4ex.assign } } }
  return out
}
