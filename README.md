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

## What it looks like

A "rack unit" aesthetic rather than a generic settings page: the current
patch renders as an actual signal chain - effect modules wired left to
right, like pedals sitting on a board - with real rotary knob controls
instead of sliders.

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

## To Do
- Verify functionality with other devices. I only have the MS-60B+ to test
  with so other pedals such as the MS-50G+ are all theoretical.
- More identifiable effect icons. Just about all of them are completely generic.

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
  app.js             original app logic
  lib/                zoom-explorer core (MIT, unmodified) - protocol, device
                       model, patch (de)serialization
  data/                effect mapping JSON (MIT, unmodified)
```
