// Roland V-4EX, "Standard" MIDI mode (from the V-4EX Remote Control Guide)
//
// Input select and memory recall are fixed messages (bank select + program change).
// Everything else has no MIDI assignment from the factory: each control has to be
// pointed at a CC (1-31, 64-95), channel pressure or pitch bend in MENU > MIDI,
// and the profile here has to match.

const range = (id, name, menu, group, hint = '') => ({ id, name, menu, group, hint, kind: 'range' })
const toggle = (id, name, menu, group, hint = '') => ({ id, name, menu, group, hint, kind: 'toggle' })

export const CONTROLS = [range('videoFader', 'Video fader (T-bar)', 'STD:VIDEO FADER', 'Video', '0 = A bus, 127 = B bus'), range('transitionTime', 'Transition time', 'STD:TRANSITION TIME', 'Video', 'only used when AUTO TRANSITION is on'), range('transitionSel', 'Transition type', 'STD:TRANSITION SEL', 'Video'), range('outputFade', 'Output fade', 'STD:OUTPUT FADE', 'Video'), toggle('freeze', 'Freeze', 'STD:FREEZE', 'Video'), toggle('transformerA', 'Transformer A', 'STD:TRANSFORMER A', 'Video'), toggle('transformerB', 'Transformer B', 'STD:TRANSFORMER B', 'Video'), toggle('bpmSync', 'BPM sync', 'STD:BPM/SYNC', 'Video'), ...[1, 2, 3, 4].map((n) => toggle(`effectA${n}`, `Effect A${n}`, `STD:EFFECTS A${n}`, 'Effects', `A bus effect button ${n}`)), ...[1, 2, 3, 4].map((n) => toggle(`effectB${n}`, `Effect B${n}`, `STD:EFFECTS B${n}`, 'Effects', `B bus effect button ${n}`)), range('audioLevel', 'Audio output level', 'STD:AUDIO LEVEL', 'Audio'), ...[1, 2, 3, 4].map((n) => range(`audioCh${n}`, `Audio CH${n} level`, `STD:AUDIO CH${n} LEVEL`, 'Audio', `HDMI input ${n} audio`)), range('audioIn', 'Analog audio in level', 'STD:AUDIO IN LEVEL', 'Audio'), range('audioDelay1', 'Output audio delay', 'STD:AUDIO DELAY 1', 'Audio'), range('audioDelay2', 'Analog input audio delay', 'STD:AUDIO DELAY 2', 'Audio')]

// assignable CCs on the V-4EX
export const ASSIGNABLE_CCS = [...Array(31).keys()].map((i) => i + 1).concat([...Array(32).keys()].map((i) => i + 64))

// suggested assignments (CC 1-24 in order); enter the same numbers on the V-4EX
export const defaultProfile = () => ({
  channel: 1,
  assign: Object.fromEntries(CONTROLS.map((c, i) => [c.id, i + 1]))
})

export const WHEN = {
  switch: [
    ['on', 'when sound starts'],
    ['off', 'when sound stops'],
    ['cycle', 'next one each time sound starts']
  ],
  toggle: [
    ['momentary', 'on while sound, off after'],
    ['on', 'turn on when sound starts'],
    ['off', 'turn off when sound starts'],
    ['toggle', 'flip each time sound starts']
  ],
  range: [
    ['follow', 'follow sound level (low → high)'],
    ['momentary', 'high while sound, low after'],
    ['set', 'set value when sound starts']
  ]
}

export const defaultAction = () => ({ type: 'input', bus: 'A', input: 1, memory: 1, control: 'videoFader', when: 'on', lo: 0, hi: 127, value: 127 })

export const controlById = (id) => CONTROLS.find((c) => c.id === id)

export const actionKind = (a) => (a.type === 'control' ? controlById(a.control)?.kind || 'range' : 'switch')

// keep `when` valid after the action type/control changes
export const fixWhen = (a) => {
  const options = WHEN[actionKind(a)].map(([v]) => v)
  return options.includes(a.when) ? a : { ...a, when: options[0] }
}

export const describeAction = (a) => {
  if (a.type === 'input') return a.when === 'cycle' ? `${a.bus}←In1-${a.input}` : `${a.bus}←In${a.input}`
  if (a.type === 'memory') return a.when === 'cycle' ? `Mem 1-${a.memory}` : `Mem ${a.memory}`
  return controlById(a.control)?.name || a.control
}

// message bytes; -1 is the 7-bit value, -2/-3 are pitch bend LSB/MSB
const template = (ch, assign) => {
  if (assign === 'pressure') return [0xd0 | ch, -1]
  if (assign === 'bend') return [0xe0 | ch, -2, -3]
  if (typeof assign === 'number') return [0xb0 | ch, assign, -1]
  return null
}

export const fill = (msg, v) => {
  const v14 = Math.round((v / 127) * 16383)
  return msg.map((b) => (b === -1 ? v : b === -2 ? v14 & 0x7f : b === -3 ? v14 >> 7 : b))
}

const bankProgram = (ch, msb, program) => [
  [0xb0 | ch, 0x00, msb],
  [0xb0 | ch, 0x20, 0x00],
  [0xc0 | ch, program]
]

// turn friendly actions into steps the engines play:
// { trigger: on|off|cycle|value, msgs, seq?, lo?, hi? }
export const compile = (actions, profile) => {
  const ch = (Math.min(16, Math.max(1, profile.channel)) - 1) & 0x0f
  const steps = []
  const warnings = []
  for (const a of actions || []) {
    if (a.type === 'input' || a.type === 'memory') {
      const msb = a.type === 'memory' ? 0x50 : a.bus === 'B' ? 0x01 : 0x00
      const n = a.type === 'memory' ? a.memory : a.input
      // cycle steps through 1..n, one per trigger
      if (a.when === 'cycle') steps.push({ trigger: 'cycle', msgs: [], seq: [...Array(n).keys()].map((i) => bankProgram(ch, msb, i)) })
      else steps.push({ trigger: a.when === 'off' ? 'off' : 'on', msgs: bankProgram(ch, msb, n - 1) })
      continue
    }
    const c = controlById(a.control)
    const t = c && template(ch, profile.assign[c.id])
    if (!t) {
      warnings.push(`${c?.name || a.control} has no MIDI assignment. Set one in V-4EX setup.`)
      continue
    }
    if (c.kind === 'toggle') {
      const on = [fill(t, 127)]
      const off = [fill(t, 0)]
      if (a.when === 'momentary') steps.push({ trigger: 'on', msgs: on }, { trigger: 'off', msgs: off })
      else if (a.when === 'on') steps.push({ trigger: 'on', msgs: on })
      else if (a.when === 'off') steps.push({ trigger: 'on', msgs: off })
      else steps.push({ trigger: 'cycle', msgs: [], seq: [on, off] })
    } else if (a.when === 'follow') {
      steps.push({ trigger: 'value', msgs: [t], lo: a.lo, hi: a.hi })
    } else if (a.when === 'momentary') {
      steps.push({ trigger: 'on', msgs: [fill(t, a.hi)] }, { trigger: 'off', msgs: [fill(t, a.lo)] })
    } else {
      steps.push({ trigger: 'on', msgs: [fill(t, a.value)] })
    }
  }
  return { steps, warnings }
}

export const SETUP_NOTES = ['MENU > MIDI > COM:Rx SOURCE: USB if the computer is plugged into the V-4EX USB port, MIDI IN if you use a MIDI interface.', 'MENU > MIDI > STD:Rx CHANNEL: set to the channel below. It is OFF from the factory, and while it is OFF the V-4EX ignores everything.', 'For every control you use, set its STD:… menu item to the matching CC (or pressure/bend) below.', 'STD:AUTO TRANSITION ON: selecting an A-bus input does a full transition by itself (using transition time/type). Only switch the A bus in that mode, and leave the panel alone.', 'STD:AUTO TRANSITION OFF: input select only sets up the A/B buses, and the video fader decides what is on air.']
