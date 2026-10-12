// desktop backend: everything real-time happens in rust
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { normalizeConfig } from '../defaults.js'

const filters = [{ name: 'sound2midi preset', extensions: ['json'] }]

export const createBackend = async () => ({
  kind: 'desktop',
  capabilities: { osc: true },
  getConfig: async () => normalizeConfig(await invoke('get_config')),
  setConfig: (config) => invoke('set_config', { config }),
  listInputs: async () => (await invoke('list_inputs')).map((name) => ({ id: name, name })),
  listMidiOutputs: async () => {
    const { ports, virtualSupported } = await invoke('list_midi_outputs')
    return { ports: ports.map((name) => ({ id: name, name })), virtualSupported }
  },
  start: () => invoke('start_audio'),
  stop: () => invoke('stop_audio'),
  reconnect: () => invoke('reconnect_outputs'),
  panic: () => invoke('panic'),
  onFrame: (cb) => listen('frame', (e) => cb(e.payload)),
  savePreset: async () => {
    const path = await save({ filters, defaultPath: 'preset.json' })
    if (path) await invoke('save_preset', { path })
  },
  loadPreset: async () => {
    const path = await open({ filters, multiple: false })
    if (!path) return null
    return normalizeConfig(await invoke('load_preset', { path }))
  }
})
