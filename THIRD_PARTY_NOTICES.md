# Third-party code

`renderer/lib/*.js` and `renderer/data/zoom-effect-mappings-*.json` are
copied, unmodified, from Thomas Hammer's
[zoom-explorer](https://github.com/thammer/zoom-explorer) project
(MIT licensed - see `renderer/lib/LICENSE`). They provide the MIDI
sysex protocol handling, device discovery, and per-effect parameter data
for the Zoom MS Plus pedal series.

Everything else in this repository - the Electron shell (`main.js`,
`preload.js`), the UI (`renderer/index.html`, `renderer/styles.css`,
`renderer/app.js`), and the visual design - is original, written for
this project.

This project is not affiliated with Thomas Hammer, sym.bios.is, or Zoom
Corporation. It exists to provide an alternative, native-desktop
interface to the same well-documented, community-reverse-engineered
protocol that sym.bios.is (the original, actively maintained,
web-based tool) already implements excellently. If you just want a
working patch manager today, use sym.bios.is - this project is for
people who specifically want a native app.
