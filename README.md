# Signal Chain

A native desktop patch editor for Zoom's MS Plus multistomp pedals
(MS-50G+, MS-60B+; MS-70CDR+ partially - see below), built as an
alternative interface to [zoom-explorer](https://github.com/thammer/zoom-explorer), reusing its
underlying protocol/patch logic under the MIT license. See
`THIRD_PARTY_NOTICES.md` for the attribution details.

If you just want a working patch manager today, use sym.bios.is - it's
tested on real hardware across the whole Plus line and actively
maintained. This project is for anyone who specifically wants a native
desktop app with a different interface.

It also drives the **Line 6 Bass POD Pro**, which is a different kind of
device entirely - see [Line 6 Bass POD Pro](#line-6-bass-pod-pro) below.

## What it looks like

A "rack unit" aesthetic rather than a generic settings page: the current
patch renders as an actual signal chain - effect modules wired left to
right, like pedals sitting on a board - with real rotary knob controls
instead of sliders.

Devices with a *fixed* signal path (the Bass POD Pro) render as grouped rows
of those same knobs instead, because there is nothing to reorder - what the
panel shows is closer to the pedal's own front panel.

## Setup

```bash
npm install
npm start
```

Requires Node.js (for Electron itself, not for talking to the pedal -
all MIDI happens through the renderer's Web MIDI API, same as
sym.bios.is in a browser).

## Status - what works and what doesn't yet

- ✅ Connect / auto-identify (via the same `getMIDIDeviceList()` identity-
  request logic that resolved the "which Plus pedal is this" question)
- ✅ Browse and load patches from the pedal's memory
- ✅ View the current patch as a signal chain, select an effect module
- ✅ Adjust parameters with real knob controls (drag up/down)
- ✅ Toggle an effect on/off
- ✅ Sync current patch to the pedal
- ✅ Save/load a single patch to/from a `.zpatch` file (the pedal's own
  binary patch format via `ZoomPatch.buildPTCFChunk()` /
  `fromPatchData()` - not a lossy reinterpretation)
- ✅ Backup every patch on the pedal to a folder of `.zpatch` files
- ✅ Restore a single patch back into a specific memory slot (vs. just
  the edit buffer via Sync)
- ⚠️ MS-70CDR+ effect names/parameter ranges aren't wired in yet - only
  MS-50G+ (model `0x23`) and MS-60B+ (model `0x27`) are mapped in
  `app.js`'s `MODEL_TO_MAPPING_FILE`. The effect mapping JSON for
  MS-70CDR+ is already bundled in `renderer/data/` though - it just
  needs that pedal's model number confirmed and added.
- ❌ Patch renaming isn't sent to the pedal live yet (real hardware sends
  name edits character-by-character; this app currently only updates
  the name locally until you hit Sync)
- ✅ Re-order effects within a patch - drag and drop modules within the
  signal chain to reorder them
- ✅ Add effects from a drag-and-drop library - effect library panel shows
  all effects available on the connected pedal, organized by category;
  drag effects into the chain up to the pedal's maximum (typically 6)
- ✅ Remove effects from the chain - click the × button on each module
  to remove it
- ❌ Offline font loading - `index.html` currently pulls IBM Plex from
  Google Fonts; falls back to system fonts if offline, but for a fully
  offline-capable app the font files should be bundled locally

### Line 6 Bass POD Pro

The POD Pro is not a patch editor in the way the Zoom pedals are: every
front-panel control is mirrored by a plain MIDI control-change message, so
the app drives it live rather than uploading a patch blob. What works today:

- ✅ Identification (the POD answers the same identity request the Zoom
  pedals do, with manufacturer `00 01 0C`, family `02 00`)
- ✅ Amp model (CC 12), cabinet (CC 71) and effect (CC 19) selection
- ✅ Every continuous front-panel control: drive, bass, middle, treble,
  channel volume, compress, effect tweak, FX lo-cut, noise gate, parametric
  EQ (freq/Q/gain) and mid sweep, plus the digital output level and the
  D.I. effects switch
- ✅ Manual, Tuner and the 36 internal programs (1A-9D) via program change
- ✅ The pedal's own knob movements and program changes are reflected back in
  the UI as they happen
- ✅ "Sync to Pedal" replays the panel's settings as control changes
- ❌ Program *names* - they only exist in the pedal's sys-ex program dump
- ❌ Save/Load/Backup/Restore - same reason; they stay disabled for the POD
  until the dump is implemented

Two things worth knowing before connecting one:

- The POD Pro has 5-pin DIN MIDI only, so you need a MIDI interface (there's
  no USB-MIDI port). Set the POD's global MIDI Channel to match the app's
  (1 by default) - the POD ignores messages on any other channel.
- Until the sys-ex read lands, the app has no way to know the pedal's current
  settings, so controls start dimmed with a "?" rather than showing a made-up
  value. They stop being dimmed as soon as you move one here, or turn one on
  the POD. "Sync to Pedal" only ever sends controls it actually knows.

One control number is worth double-checking against real hardware: the effect
*selector* (CC 19) is the only one taken from the control-number column of
`mapping/Bass POD Pro Sysex - English .pdf` rather than from
`mapping/bass_pod_pro_mapping.ods`, which lists the 16 effect names but no CC
number for picking between them.

## To Do
- Verify functionality with other devices. I only have the MS-60B+ to test
  with so other pedals such as the MS-50G+ are all theoretical.
- More identifiable effect icons. Just about all of them are completely generic.
- Bass POD Pro: implement the sys-ex program dump, which is what program
  names, Save/Load and Backup/Restore need. The envelope is documented in
  `renderer/devices/BassPodProDevice.js` - request
  `F0 00 01 0C 02 00 00 <program #> F7`, reply
  `F0 00 01 0C 02 01 00 <program #> <version> <data> F7`, where `<data>` is
  160 nibbles of an 80-byte program (all 36 programs at once is 5760 nibbles).
- Bass POD Pro: confirm CC 19 selects the effect, and that the pedal's global
  MIDI channel matches, on real hardware.

## Tests

```bash
npm test        # same as: node --test test/
```

No MIDI hardware, no Electron and no display needed. The vendored protocol
code in `renderer/lib/` is plain ES modules, so `test/bass-pod-pro.test.mjs`
drives the real identity-reply parser and the real CC adapter through a fake
MIDI proxy and asserts the exact bytes on the wire, while
`test/controls.test.mjs` drives the panel widgets through a minimal DOM stub.
`renderer/package.json` exists only so the Node test runner treats
`renderer/**/*.js` as ES modules - the app itself never reads it.

## Packaging as a real installable app

`npm run dist` (via `electron-builder`, already in `devDependencies`)
builds an AppImage on Linux per the `build` config in `package.json`.
Add `mac`/`win` targets there if you need other platforms.

## Screen shots
<img width="1280" height="830" alt="image" src="https://github.com/user-attachments/assets/065c01fc-9e50-417a-95f1-ad5252c607db" />
<img width="1283" height="831" alt="image" src="https://github.com/user-attachments/assets/01d56c86-d339-4e4f-a6a5-a61e30c011e5" />



## Project layout

```
main.js            Electron main process (window, MIDI permission, file IPC)
preload.js          contextBridge - the only path from renderer to filesystem
renderer/
  index.html
  styles.css         original design
  app.js             UI orchestration - picks a device, builds its view
  lib/                zoom-explorer core (MIT, unmodified) - protocol, device
                       model, patch (de)serialization
  data/                effect mapping JSON (MIT, unmodified), plus
                       bass-pod-pro.json - the POD's control map
  devices/             one protocol adapter per device, and profiles.js which
                       decides what a MIDI identity reply means and which view
                       layout that device gets
  ui/controls.js       knobs/selects/toggles shared by both view layouts
  package.json         {"type": "module"} - for the Node test runner only
test/                  node --test suites (no test dependencies)
```
