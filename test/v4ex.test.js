import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../src/engine.js'
import { defaultConfig, defaultMapping } from '../src/defaults.js'
import { compile, defaultProfile } from '../src/devices/v4ex.js'

const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ')

// run a mapping through the web engine with an 80Hz sine, returning MIDI per phase
const play = (mapping, amps) => {
  const cfg = { ...defaultConfig(), mappings: [{ ...defaultMapping(), id: 'x', lowHz: 60, highHz: 100, thresholdDb: -30, minDb: -40, maxDb: -10, ...mapping }] }
  let sent = []
  const out = { raw: (b) => sent.push(hex(b)), noteOn() {}, noteOff() {}, cc() {}, osc() {} }
  const e = new Engine({ getConfig: () => cfg, out, onFrame() {} })
  clearInterval(e.timer)
  let amp = 0
  let t = 0
  e.ctx = { sampleRate: 48000 }
  e.analyser = {
    getFloatTimeDomainData(b) {
      for (let i = 0; i < b.length; i++) b[i] = amp * Math.sin((2 * Math.PI * 80 * (t + i)) / 48000)
      t += 240
    }
  }
  return amps.map((a) => {
    amp = a
    sent = []
    for (let i = 0; i < 80; i++) {
      e.last -= 5
      e.tick()
    }
    return sent
  })
}

test('select input is bank select + program change', () => {
  const { steps } = compile([{ type: 'input', bus: 'B', input: 3, when: 'on' }], defaultProfile())
  assert.deepEqual(steps, [{ trigger: 'on', msgs: [[0xb0, 0x00, 0x01], [0xb0, 0x20, 0x00], [0xc0, 0x02]] }])
})

test('memory recall uses bank 50h on the profile channel', () => {
  const { steps } = compile([{ type: 'memory', memory: 8, when: 'off' }], { ...defaultProfile(), channel: 16 })
  assert.deepEqual(steps, [{ trigger: 'off', msgs: [[0xbf, 0x00, 0x50], [0xbf, 0x20, 0x00], [0xcf, 0x07]] }])
})

test('unassigned controls warn instead of sending', () => {
  const { steps, warnings } = compile([{ type: 'control', control: 'freeze', when: 'on' }], { channel: 1, assign: {} })
  assert.equal(steps.length, 0)
  assert.equal(warnings.length, 1)
})

test('pitch bend assignment fills 14-bit value', () => {
  const { steps } = compile([{ type: 'control', control: 'videoFader', when: 'set', value: 127 }], { channel: 2, assign: { videoFader: 'bend' } })
  assert.deepEqual(steps[0].msgs, [[0xe1, 0x7f, 0x7f]])
})

test('engine plays on/off/cycle/value steps', () => {
  const actions = [
    { type: 'input', bus: 'A', input: 2, when: 'cycle' },
    { type: 'control', control: 'freeze', when: 'momentary' },
    { type: 'control', control: 'videoFader', when: 'follow', lo: 0, hi: 127 }
  ]
  const { steps } = compile(actions, defaultProfile())
  const [hit1, quiet1, hit2] = play({ output: 'device', actions, steps }, [0.5, 0, 0.5])
  assert.ok(hit1.includes('c0 00'), 'first hit selects input 1')
  assert.ok(hit2.includes('c0 01'), 'second hit selects input 2')
  assert.ok(hit1.includes('b0 05 7f') && quiet1.includes('b0 05 00'), 'freeze is momentary')
  assert.equal(hit1.filter((m) => m.startsWith('b0 01')).at(-1), 'b0 01 7f', 'fader follows to the top')
  assert.equal(quiet1.filter((m) => m.startsWith('b0 01')).at(-1), 'b0 01 00', 'fader falls back to 0')
})
