# sound2midi

Turn incoming sound into MIDI notes, MIDI CC and OSC messages.

Draw frequency bands ("triggers") on a live spectrum. Each band watches the energy in its frequency range and outputs:

- **Note**: note-on when the band crosses its threshold, note-off when it falls below threshold minus hysteresis. Velocity is fixed, or follows the level between threshold and max.
- **CC**: continuous value, mapping the band level from min dB to max dB onto 0–127.
- **OSC**: a float to an address, either **value** (0–1 level) or **gate** (1/0 on threshold crossing). Desktop only.

Use as many bands as you like, and let them overlap, so different frequencies can drive different messages.

## Using it

- Drag across empty spectrum to create a band. Double-click to create a 1/3-octave band.
- Drag a band's edges to set start/end. Drag the body to move it. Scroll over it to change its width.
- Drag the solid threshold line (note/gate), or the dashed max/min lines (CC/value), to set levels.
- Edit everything precisely in the side panel, including center/width in octaves, attack/release smoothing, and channel/note/CC/address.
- `Delete` removes the selected band. `Esc` deselects it. **Panic** sends all-notes-off.
- **Save/Load** stores presets as JSON. They hold your bands and analysis settings, but not your devices, so they move between machines and between desktop and web.

## Roland V-4EX

Pick **V-4EX** as a trigger's output to control a Roland V-4EX video mixer by purpose instead of by raw MIDI. Each trigger holds a list of **actions**, and every action fires when the band does, so one sound can do several things at once:

- **Select input**: A or B bus, input 1–4. Can also step to the next input each time (e.g. cut to the next camera on every kick).
- **Recall memory**: 1–8, or step through them.
- **Control**: video fader, transition time/type, output fade, freeze, transformers, BPM sync, effects A1–B4, and audio levels/delays. On/off controls can be momentary, on, off or toggle. Ranged controls can follow the band level, jump high/low with the sound, or be set to a value.

Each action knows which MIDI it needs. Input select and memory recall, for example, are three messages each (bank select MSB + LSB + program change). The editor shows the exact bytes every trigger will send.

The V-4EX ignores MIDI until it's set up, and most controls have no MIDI assignment from the factory. **V-4EX setup…** in the editor lists every menu item to set on the mixer (`STD:Rx CHANNEL`, `STD:VIDEO FADER` = CC 1, and so on), with suggested assignments you can change. **Copy as text** gives you a checklist to take to the mixer. The device profile is saved with presets.

Based on the V-4EX Remote Control Guide (Standard mode). Not yet tested against real hardware.

## Desktop vs web

|            | Desktop (Tauri)                                | Web                              |
| ---------- | ---------------------------------------------- | -------------------------------- |
| Audio      | native (cpal), any input device/channel        | getUserMedia                     |
| MIDI       | native ports, plus a virtual port on mac/linux | Web MIDI (Chrome, Edge, Firefox) |
| OSC        | UDP                                            | not available                    |
| Processing | Rust thread, ~5ms hop                          | JS, ~5ms hop                     |

On Windows there are no virtual MIDI ports. Use something like [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) to route into a DAW.

## Develop

```sh
npm i
npm run tauri dev   # desktop app
npm run dev         # web-only version at http://localhost:1420
npm run tauri build # desktop bundles
npm run build       # static web build in dist/
npm run fmt
npm test            # JS tests (Rust: cargo test in src-tauri)
```

Linux needs `libasound2-dev` plus the usual [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Layout:

- `src-tauri/src/engine.rs`: FFT, band detection and message logic (desktop)
- `src/engine.js`: the same logic in JS (web)
- `src-tauri/src/audio.rs`, `output.rs`: audio input, MIDI/OSC output
- `src/view.js`: spectrum/waterfall canvas and band dragging
- `src/main.js`: toolbar, trigger list and editor
- `src/backend/`: the desktop and web backends behind one interface
- `src/devices/v4ex.js`: V-4EX controls and actions, compiled into generic message steps that both engines play
- `src/deviceUi.js`: the action editor and device setup panel

CI (`.github/workflows/ci.yml`) builds mac (universal), linux and windows on every push and PR, with the installers attached as workflow artifacts. Publishing a GitHub release builds from its tag and attaches the installers plus a zip of the web build (the app version is taken from the tag, e.g. `v1.2.0` → `1.2.0`). Pushes to `main` deploy the web version to GitHub Pages.
