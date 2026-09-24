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
- ✅ Reading a program: the patch list shows all 36 programs with their real
  names (one all-programs sys-ex dump), and clicking one recalls it on the
  POD and reads it back, so the panel shows what the program actually
  contains. Connecting does the same for the program the POD is playing.
- ❌ Save/Load/Backup/Restore - these need the app to *send* a program dump
  back to the POD, which isn't wired up yet (reading works, writing doesn't)

Two things worth knowing before connecting one:

- The POD Pro has 5-pin DIN MIDI only, so you need a MIDI interface (there's
  no USB-MIDI port). Set the POD's global MIDI Channel to match the app's
  (1 by default) - the POD ignores messages on any other channel.
- Control changes only travel one way: the POD does not report a program's
  settings when it is recalled, so the app cannot see a knob until it is
  moved. It reads programs as sys-ex dumps instead, which is why the panel
  fills in when you connect and when you click a patch in the list.
- A control the dump says nothing about stays dimmed with a "?" rather than
  showing a made-up value, and "Sync to Pedal" only ever sends controls it
  actually knows - it will not zero a knob on the pedal. The noise gate is the
  one control with a caveat: CC 22 is a switch (0-63 off, 64-127 on) and the
  gate's actual amount is a parameter that has no control-change number at all,
  so the dump's on/off bit loads as 64 (on).

Two details come from the POD's own sys-ex document rather than from a
cross-reference table, and both are quick to check against the pedal:

- The 16 effects are stored as the "Bass Pod Internal Value" column of the
  EFFECT TYPE PARAMETER TABLE, which is *not* the order the POD's knob lists
  them in (Orange Phase is 0, Bypass is 10, ...). `valueTables.effects` is
  ordered by that value, so turning the POD's effect knob should highlight the
  matching name in the app.
- Continuous parameters are stored in 6 bits while their control-change range
  runs 0-126, so a dump reads back as "stored x 2". That is what makes 126 the
  top of those ranges, and the captured dump agrees (program 1A stores Channel
  Volume as 63). If a knob ever reads back at exactly half what the POD's
  display shows, that conversion is the line to change
  (`sysexLayout.fields[].scale`).

## To Do
- Verify functionality with other devices. I only have the MS-60B+ to test
  with so other pedals such as the MS-50G+ are all theoretical.
- More identifiable effect icons. Just about all of them are completely generic.
- Bass POD Pro: sending a program dump back to the POD, which is what
  Save/Load/Backup/Restore need. The read side is done
  (`renderer/devices/bassPodProSysex.js` plus the `sysexLayout` byte map in
  `renderer/data/bass-pod-pro.json`); the write side needs the same 80 bytes
  nibble-encoded again, with the version byte the POD expects.
- Bass POD Pro: the sys-ex-only parameters (compressor ratio/attack/decay,
  gate threshold and decay, wah, volume pedal, AIR level, D.I. alignment and
  mix) are decoded but have no controls in the panel yet - they're the extra
  entries in `sysexLayout.fields`.
- Bass POD Pro: confirm the two inference points above (effect value order,
  the 6-bit doubling) against the pedal's own display.

## Tests

```bash
npm test        # same as: node --test test/
```

No MIDI hardware, no Electron and no display needed. The vendored protocol
code in `renderer/lib/` is plain ES modules, so `test/bass-pod-pro.test.mjs`
drives the real identity-reply parser and the real CC adapter through a fake
MIDI proxy and asserts the exact bytes on the wire,
`test/bass-pod-pro-sysex.test.mjs` does the same for the dump codec and the
patch-list flow, and `test/controls.test.mjs` drives the panel widgets through
a minimal DOM stub. `renderer/package.json` exists only so the Node test
runner treats `renderer/**/*.js` as ES modules - the app itself never reads it.

The dump tests run against real captures in `test/fixtures/`: a Bass POD Pro on
firmware 1.40 answering an identity request and dump requests, with program 1A
"Eighties" in its edit buffer. They were taken with `aseqdump` on the pedal's
MIDI input, and they exist so the byte offsets in `sysexLayout` are checked
against hardware data instead of against the same document they came from.

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
                       bass-pod-pro.json - the POD's control map and the byte
                       layout of its 80-byte programs
  devices/             one protocol adapter per device, and profiles.js which
                       decides what a MIDI identity reply means and which view
                       layout that device gets
  devices/bassPodProSysex.js
                       the POD's dump codec: requests, nibble encoding, and
                       program bytes -> panel values
  ui/controls.js       knobs/selects/toggles shared by both view layouts
  package.json         {"type": "module"} - for the Node test runner only
test/                  node --test suites (no test dependencies)
test/fixtures/         real hardware captures the dump tests run against
mapping/               the source documents the POD's numbers came from
```
