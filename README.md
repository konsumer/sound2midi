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
```

Linux needs `libasound2-dev` plus the usual [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Layout:

- `src-tauri/src/engine.rs`: FFT, band detection and message logic (desktop)
- `src/engine.js`: the same logic in JS (web)
- `src-tauri/src/audio.rs`, `output.rs`: audio input, MIDI/OSC output
- `src/view.js`: spectrum/waterfall canvas and band dragging
- `src/main.js`: toolbar, trigger list and editor
- `src/backend/`: the desktop and web backends behind one interface

CI (`.github/workflows/ci.yml`) builds mac (universal), linux and windows on every push and PR, with the installers attached as workflow artifacts. Pushing a `v*` tag also creates a draft GitHub release. Pushes to `main` deploy the web version to GitHub Pages.
