// editor + setup panel for device outputs (currently the Roland V-4EX)
import { CONTROLS, ASSIGNABLE_CCS, WHEN, SETUP_NOTES, defaultAction, defaultProfile, controlById, actionKind, fixWhen, compile } from './devices/v4ex.js'

const opts = (items, value) => items.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`).join('')
const nums = (from, to) => [...Array(to - from + 1).keys()].map((i) => [i + from, i + from])
const hex = (b) => (b === -1 ? 'vv' : b === -2 ? 'll' : b === -3 ? 'mm' : b.toString(16).toUpperCase().padStart(2, '0'))
const TRIGGER_LABEL = { on: 'sound starts', off: 'sound stops', cycle: 'sound starts, in turn', value: 'continuously' }
const msgsHex = (msgs) => msgs.map((m) => m.map(hex).join(' ')).join(' · ')

const controlOptions = (value) => {
  const groups = [...new Set(CONTROLS.map((c) => c.group))]
  return groups
    .map(
      (g) =>
        `<optgroup label="${g}">${opts(
          CONTROLS.filter((c) => c.group === g).map((c) => [c.id, c.name]),
          value
        )}</optgroup>`
    )
    .join('')
}

const actionRow = (a, i) => {
  const kind = actionKind(a)
  const c = a.type === 'control' ? controlById(a.control) : null
  let params = ''
  if (a.type === 'input') {
    params = `
      <label class="field"><span>Bus</span><select data-a="bus">${opts(
        [
          ['A', 'A'],
          ['B', 'B']
        ],
        a.bus
      )}</select></label>
      <label class="field"><span>${a.when === 'cycle' ? 'Inputs 1 to' : 'Input'}</span><select data-a="input" data-num>${opts(nums(1, 4), a.input)}</select></label>`
  } else if (a.type === 'memory') {
    params = `<label class="field"><span>${a.when === 'cycle' ? 'Memories 1 to' : 'Memory'}</span><select data-a="memory" data-num>${opts(nums(1, 8), a.memory)}</select></label>`
  } else {
    params = `<label class="field wide"><span>Control</span><select data-a="control">${controlOptions(a.control)}</select></label>`
  }
  let values = ''
  if (kind === 'range' && (a.when === 'follow' || a.when === 'momentary')) {
    values = `
      <label class="field"><span>Low</span><input data-a="lo" data-num type="number" min="0" max="127" step="1" value="${a.lo}" /></label>
      <label class="field"><span>High</span><input data-a="hi" data-num type="number" min="0" max="127" step="1" value="${a.hi}" /></label>`
  } else if (kind === 'range' && a.when === 'set') {
    values = `<label class="field"><span>Value</span><input data-a="value" data-num type="number" min="0" max="127" step="1" value="${a.value}" /></label>`
  }
  return `
    <div class="action" data-i="${i}">
      <div class="action-head">
        <select data-a="type">${opts(
          [
            ['input', 'Select input'],
            ['memory', 'Recall memory'],
            ['control', 'Control']
          ],
          a.type
        )}</select>
        <button data-remove title="Remove action">✕</button>
      </div>
      <div class="grid">
        ${params}
        <label class="field wide"><span>When</span><select data-a="when">${opts(WHEN[kind], a.when)}</select></label>
        ${values}
      </div>
      ${c?.hint ? `<div class="hint-text">${c.hint}</div>` : ''}
      ${a.type === 'input' ? '<div class="hint-text">With AUTO TRANSITION on, only switch the A bus.</div>' : ''}
    </div>`
}

const stepsPreview = (steps) =>
  steps
    .map((s) => {
      const body = s.trigger === 'cycle' ? s.seq.map(msgsHex).join(' <em>then</em> ') : msgsHex(s.msgs)
      return `<div><span>${TRIGGER_LABEL[s.trigger]}</span><code>${body}</code></div>`
    })
    .join('')

// returns a function that redraws the actions block for the current mapping
export const renderDeviceEditor = (container, { getMapping, getProfile, setActions, openSetup }) => {
  const draw = () => {
    const m = getMapping()
    if (!m) return
    const { steps, warnings } = compile(m.actions, getProfile())
    container.innerHTML = `
      <div class="device-head">
        <span class="muted">Roland V-4EX · ch${getProfile().channel}</span>
        <button data-setup>V-4EX setup…</button>
      </div>
      ${m.actions.map(actionRow).join('') || '<p class="muted small">No actions yet. Each action is one thing the V-4EX does when this band fires. Add several to do them together.</p>'}
      <button data-add class="add-action">+ Add action</button>
      ${warnings.map((w) => `<p class="warn">${w}</p>`).join('')}
      ${steps.length ? `<div class="preview"><h4>Sends</h4>${stepsPreview(steps)}</div>` : ''}`

    const update = (i, patch) => {
      const actions = m.actions.map((a, j) => (j === i ? fixWhen({ ...a, ...patch }) : a))
      setActions(actions)
      draw()
    }
    container.querySelectorAll('.action').forEach((row) => {
      const i = +row.dataset.i
      row.querySelectorAll('[data-a]').forEach((input) => {
        input.addEventListener('change', () => {
          let v = input.value
          if (input.hasAttribute('data-num')) v = Math.min(127, Math.max(0, Math.round(+v || 0)))
          update(i, { [input.dataset.a]: v })
        })
      })
      row.querySelector('[data-remove]').onclick = () => {
        setActions(m.actions.filter((_, j) => j !== i))
        draw()
      }
    })
    container.querySelector('[data-add]').onclick = () => {
      setActions([...m.actions, defaultAction()])
      draw()
    }
    container.querySelector('[data-setup]').onclick = () => openSetup(draw)
  }
  draw()
  return draw
}

const assignOptions = [['', 'Not assigned'], ...ASSIGNABLE_CCS.map((cc) => [cc, `CC ${cc}`]), ['pressure', 'Channel pressure'], ['bend', 'Pitch bend']]

const assignLabel = (a) => (a === 'pressure' ? 'Channel pressure (aftertouch)' : a === 'bend' ? 'Pitch bend' : typeof a === 'number' ? `CC ${a}` : 'OFF')

const setupText = (profile) => ['Roland V-4EX setup for sound2midi', '', ...SETUP_NOTES.map((n) => `- ${n}`), '', `STD:Rx CHANNEL = ${profile.channel}`, ...CONTROLS.filter((c) => profile.assign[c.id] != null).map((c) => `${c.menu} = ${assignLabel(profile.assign[c.id])}`)].join('\n')

// modal for the V-4EX profile; onChange gets the new profile
export const openDeviceSetup = (profile, onChange) => {
  let p = structuredClone(profile)
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  document.body.appendChild(overlay)

  const draw = () => {
    const counts = {}
    for (const v of Object.values(p.assign)) if (v != null) counts[v] = (counts[v] || 0) + 1
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-label="V-4EX setup">
        <div class="modal-head">
          <h2>Roland V-4EX setup</h2>
          <button data-close>✕</button>
        </div>
        <div class="modal-body">
          <p>The V-4EX only listens once it's set up in <b>MENU &gt; MIDI</b>, and the settings there have to match the ones here.</p>
          <ul class="notes">${SETUP_NOTES.map((n) => `<li>${n}</li>`).join('')}</ul>
          <p class="muted small">Select input and Recall memory send bank select + program change, so they need no assignment.</p>
          <label class="field inline"><span>MIDI channel (STD:Rx CHANNEL)</span><select data-channel>${opts(nums(1, 16), p.channel)}</select></label>
          <table class="assign">
            <thead><tr><th>Control</th><th>V-4EX menu item</th><th>Assignment</th></tr></thead>
            <tbody>
              ${CONTROLS.map(
                (c) => `
                <tr class="${p.assign[c.id] != null && counts[p.assign[c.id]] > 1 ? 'dupe' : ''}">
                  <td>${c.name}${c.hint ? `<div class="muted small">${c.hint}</div>` : ''}</td>
                  <td class="mono">${c.menu}</td>
                  <td><select data-id="${c.id}">${opts(assignOptions, p.assign[c.id] ?? '')}</select></td>
                </tr>`
              ).join('')}
            </tbody>
          </table>
        </div>
        <div class="modal-foot">
          <button data-reset>Reset to suggested</button>
          <button data-copy>Copy as text</button>
          <button data-close class="primary">Done</button>
        </div>
      </div>`

    overlay.querySelector('[data-channel]').onchange = (e) => {
      p = { ...p, channel: +e.target.value }
      onChange(p)
    }
    overlay.querySelectorAll('[data-id]').forEach((sel) => {
      sel.onchange = () => {
        const v = sel.value
        p = { ...p, assign: { ...p.assign, [sel.dataset.id]: v === '' ? null : v === 'pressure' || v === 'bend' ? v : +v } }
        onChange(p)
        draw()
      }
    })
    overlay.querySelector('[data-reset]').onclick = () => {
      p = { ...defaultProfile(), channel: p.channel }
      onChange(p)
      draw()
    }
    overlay.querySelector('[data-copy]').onclick = async (e) => {
      try {
        await navigator.clipboard.writeText(setupText(p))
        e.target.textContent = 'Copied'
      } catch {
        e.target.textContent = 'Copy failed'
      }
    }
    overlay.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close))
  }

  const close = () => {
    overlay.remove()
    window.removeEventListener('keydown', onKey, true)
  }
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  window.addEventListener('keydown', onKey, true)
  overlay.addEventListener('pointerdown', (e) => e.target === overlay && close())
  draw()
}
