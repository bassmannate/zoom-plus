// Tests for the Bass POD Pro sys-ex program dump path: the byte-level codec in
// renderer/devices/bassPodProSysex.js, and the adapter flow behind the patch
// list (read the names, recall a program, read it back).
//
//   npm test
//
// The dump assertions run against a real capture: a Bass POD Pro (firmware
// 1.40) answering an edit-buffer request while program 1A "Eighties" was in
// its edit buffer. The capture is kept in
// test/fixtures/bass-pod-pro-edit-buffer.txt, and README.md says how it was
// taken. Everything else in here is synthesised.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DUMP_TYPE_ALL_PROGRAMS,
  DUMP_TYPE_EDIT_BUFFER,
  DUMP_TYPE_PROGRAM,
  OPCODE_REQUEST,
  PROGRAM_BYTE_COUNT,
  buildAllProgramsDumpRequest,
  buildEditBufferDumpRequest,
  buildProgramDumpRequest,
  decodeNibbles,
  encodeNibbles,
  isDecodableDump,
  parseDumpMessage,
  readBitField,
  readProgram,
  readProgramValues,
  splitPrograms,
  storedValueFromCc,
  valueFromField,
} from "../renderer/devices/bassPodProSysex.js";
import { BassPodProDevice } from "../renderer/devices/BassPodProDevice.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileData = JSON.parse(readFileSync(path.join(repoRoot, "renderer/data/bass-pod-pro.json"), "utf8"));
const layout = profileData.sysexLayout;

/** Every sysex message in a capture file, as arrays of byte values. */
function messagesIn(file) {
  return readFileSync(path.join(repoRoot, "test/fixtures", file), "utf8")
    .split("\n")
    .filter((line) => line.includes("F0"))
    .map((line) => line.slice(line.indexOf("F0")).trim().split(/\s+/).map((hex) => parseInt(hex, 16)));
}

const captured = messagesIn("bass-pod-pro-edit-buffer.txt");
const capturedIdentity = captured.find((m) => m[1] === 0x7e);
const capturedDump = captured.find((m) => m[1] === 0x00);
const capturedProgram = decodeNibbles(capturedDump.slice(8, capturedDump.length - 1));

/** A dump reply carrying the given program bytes, as the POD sends it. */
function dumpReply({ type, programNumber, programBytes, version = 1 }) {
  const reply = [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x01, type];
  if (type === DUMP_TYPE_PROGRAM) reply.push(programNumber);
  reply.push(version, ...encodeNibbles(programBytes), 0xf7);
  return reply;
}

/** An 80-byte program with a name and a few byte values set. */
function makeProgram(name, fields = {}) {
  const bytes = new Uint8Array(PROGRAM_BYTE_COUNT).fill(0x20, 64, 80); // space-padded name
  for (let i = 0; i < name.length && i < 16; i++) bytes[64 + i] = name.charCodeAt(i);
  for (const [index, value] of Object.entries(fields)) bytes[Number(index)] = value;
  return bytes;
}

/**
 * Answers dump requests with canned replies, the way the POD does - including
 * staying silent when a test asks for something the map has no reply for.
 */
class FakeMIDIProxy {
  constructor(replies = new Map()) {
    this.replies = replies; // dump type -> reply message bytes
    this.sent = [];
    this.listeners = new Map();
    this.inputs = new Map([["in-1", { id: "in-1", name: "Fake MIDI In" }]]);
    this.outputs = new Map([["out-1", { id: "out-1", name: "Fake MIDI Out" }]]);
  }
  async openInput() { return { id: "in-1" }; }
  async openOutput() { return { id: "out-1" }; }
  async closeInput() {}
  async closeOutput() {}
  addListener(id, listener) { this.listeners.set(id, listener); }
  removeListener(id, listener) { if (this.listeners.get(id) === listener) this.listeners.delete(id); }
  sendCC(_id, channel, ccNumber, value) { this.sent.push([0xb0 + channel, ccNumber, value]); }
  sendPC(_id, channel, program) { this.sent.push([0xc0 + channel, program]); }
  send(_id, data) {
    this.sent.push([...data]);
    const parsed = parseDumpMessage(data);
    if (!parsed || parsed.opcode !== OPCODE_REQUEST) return;
    const reply = this.replies.get(parsed.type);
    if (reply) this.emitInbound(reply);
  }
  emitInbound(bytes) {
    for (const listener of this.listeners.values()) listener("in-1", Uint8Array.from(bytes));
  }
  get lastMessage() { return this.sent[this.sent.length - 1]; }
}

async function openFakeDevice(replies, options = {}) {
  const midi = new FakeMIDIProxy(replies);
  const device = new BassPodProDevice(
    midi,
    { inputID: "in-1", outputID: "out-1" },
    profileData,
    { dumpTimeoutMs: 50, ...options },
  );
  await device.open();
  return { midi, device };
}

// --- The capture these tests lean on ---------------------------------------

test("fixture: a real POD answered the identity request and a dump request", () => {
  assert.equal(captured.length, 2, "an identity reply plus one program dump");

  assert.equal(capturedIdentity.length, 17, "a 3-byte manufacturer ID gives the 17-byte form");
  assert.deepEqual(capturedIdentity.slice(0, 5), [0xf0, 0x7e, 0x7f, 0x06, 0x02]);
  assert.deepEqual(capturedIdentity.slice(5, 8), [0x00, 0x01, 0x0c], "manufacturer: Line 6");
  assert.equal(String.fromCharCode(...capturedIdentity.slice(12, 16)), "0140", "firmware 1.40");

  const parsed = parseDumpMessage(Uint8Array.from(capturedDump));
  assert.equal(parsed.opcode, 0x01, "a reply, not a request");
  assert.equal(parsed.type, DUMP_TYPE_EDIT_BUFFER);
  assert.equal(parsed.version, 1, "the data format version, not the firmware revision");
  assert.equal(parsed.nibbles.length, 160);
  assert.equal(parsed.byteCount, PROGRAM_BYTE_COUNT);
});

test("requests: the exact envelope the PDF documents", () => {
  assert.deepEqual([...buildEditBufferDumpRequest()], [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x00, 0x01, 0xf7]);
  assert.deepEqual([...buildAllProgramsDumpRequest()], [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x00, 0x02, 0xf7]);
  assert.deepEqual([...buildProgramDumpRequest(0)], [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x00, 0x00, 0x00, 0xf7], "1A");
  assert.deepEqual([...buildProgramDumpRequest(35)], [0xf0, 0x00, 0x01, 0x0c, 0x02, 0x00, 0x00, 0x23, 0xf7], "9D is 0x23");
});

test("nibbles: high nibble first, and the capture round-trips", () => {
  assert.deepEqual([...encodeNibbles([0x8f, 0x01])], [0x08, 0x0f, 0x00, 0x01]);
  assert.deepEqual([...decodeNibbles([0x08, 0x0f, 0x00, 0x01])], [0x8f, 0x01]);
  assert.deepEqual([...decodeNibbles(encodeNibbles(capturedProgram))], [...capturedProgram]);
  assert.deepEqual([...decodeNibbles([0x01, 0x02, 0x03])], [0x12], "a stray nibble is dropped, not shifted");
});

test("parseDumpMessage only claims messages that really are POD dumps", () => {
  assert.equal(parseDumpMessage(Uint8Array.from(capturedIdentity)), undefined, "identity replies are miditools.js's job");
  assert.equal(parseDumpMessage(Uint8Array.from([0xf0, 0x52, 0x00, 0x00, 0x00, 0xf7])), undefined, "a Zoom pedal");
  assert.equal(parseDumpMessage(Uint8Array.from([0xf0, 0x00, 0x01, 0x0c, 0x02, 0x01, 0x01])), undefined, "no EOX");
  assert.equal(parseDumpMessage(Uint8Array.from([0xb0, 12, 5])), undefined, "not sys-ex at all");

  const echoedRequest = parseDumpMessage(buildEditBufferDumpRequest());
  assert.equal(echoedRequest.opcode, OPCODE_REQUEST);
  assert.equal(isDecodableDump(echoedRequest), false, "our own request coming back is not a dump");
  assert.equal(isDecodableDump(parseDumpMessage(Uint8Array.from(capturedDump))), true);
});

// --- What a program dump says ----------------------------------------------

test("a real program decodes into the panel's control values", () => {
  const { name, values } = readProgram(capturedProgram, layout);
  assert.equal(name, "Eighties", "program 1A's factory name, straight out of the dump");

  // Every number comes from that capture; the comment names the program byte
  // behind it, so a decode bug points at the byte that moved.
  const expected = [
    [12, 5],   // amp model, byte 3 (4 bits) -> 5 is the "Eighties" model
    [13, 26],  // drive, byte 4 = 13 stored, x2
    [14, 70],  // bass, byte 6 = 35 stored, x2
    [15, 66],  // middle, byte 7 = 33 stored, x2
    [16, 112], // treble, byte 8 = 56 stored, x2
    [17, 126], // channel volume, byte 10 = 63 -> the top of the control's range
    [18, 0],   // compress, byte 11
    [28, 64],  // mid sweep, byte 12 = 32 -> centre
    [25, 64],  // parametric frequency, byte 13 = 32 -> centre
    [26, 64],  // parametric Q, byte 14
    [27, 64],  // parametric gain, byte 15
    [71, 0],   // cabinet, byte 31 (4 bits) -> the first cabinet in the table
    [9, 0],    // digital output level, byte 33
    [19, 10],  // effect select, byte 49 (4 bits)
    [1, 0],    // effect tweak, byte 50
    [21, 0],   // fx lo-cut, byte 51
    [22, 64],  // noise gate: byte 0 bit 0 is set, and a dump only says on/off
    [64, 0],   // apply FX to D.I.: byte 2 bit 0 clear
    [60, 127], // effect on/off: byte 52 bit 0 set
    [23, 13],  // gate threshold, byte 16 - a parameter the CC map has no knob for
    [42, 30],  // compressor ratio, byte 25: 25-49 is 3.3:1
    [7, 127],  // volume pedal, byte 22
    [45, 127], // wah top frequency, byte 20
    [74, 124], // D.I. time alignment: byte 34 is 0xFE, only bits 5-0 are ours
  ];
  for (const [cc, value] of expected) {
    const field = layout.fields.find((f) => f.cc === cc);
    assert.equal(values.get(cc), value, `CC ${cc} (${field?.id})`);
  }
});

test("the field map covers every control the panel shows, inside the 80 bytes", () => {
  const controls = profileData.groups
    .flatMap((group) => group.controls)
    .filter((control) => control.cc !== undefined);

  assert.ok(controls.length > 0);
  for (const control of controls) {
    assert.ok(layout.fields.some((field) => field.cc === control.cc), `${control.id} (CC ${control.cc}) has no dump field`);
  }
  for (const field of layout.fields) {
    assert.equal(typeof field.cc, "number", `${field.id} needs a control-change number`);
    assert.ok(field.byte >= 0 && field.byte < layout.programByteCount, `${field.id}: byte ${field.byte}`);
    if (field.bits) {
      assert.ok(field.bits[0] <= 7 && field.bits[1] >= 0 && field.bits[0] >= field.bits[1], `${field.id}: bits ${field.bits}`);
    }
  }
});

test("stored values convert the way the panel sends control changes", () => {
  assert.equal(storedValueFromCc(126, 2), 63, "the top of a 0-126 range is the top of a 6-bit field");
  assert.equal(storedValueFromCc(1, 2), 1, "1 rounds up rather than collapsing to 0");
  assert.equal(storedValueFromCc(64, 1), 64, "7-bit parameters are stored as they are sent");

  const channelVolume = { mode: "scale", scale: 2, byte: 10, bits: [5, 0] };
  assert.equal(valueFromField(channelVolume, capturedProgram, { max: 126 }), 126, "byte 10 holds 63 -> the panel shows 126");
  assert.equal(valueFromField(channelVolume, makeProgram("x", { 10: 0 }), { max: 126 }), 0);
});

test("bit fields read the way the PDF's MSb/LSb columns are written", () => {
  assert.equal(readBitField(0x0a, [3, 0]), 10);
  assert.equal(readBitField(0xfe, [5, 0]), 62, "unused high bits are ignored");
  assert.equal(readBitField(0x20, [5, 0]), 32);
  assert.equal(readBitField(0x0f, undefined), 0x0f, "no field means the whole byte");

  const diSwitch = { mode: "bit", byte: 2, bits: [0, 0] };
  assert.equal(valueFromField(diSwitch, makeProgram("x", { 2: 1 }), { onValue: 127, offValue: 0 }), 127);
  assert.equal(valueFromField(diSwitch, makeProgram("x", { 2: 0 }), { onValue: 127, offValue: 0 }), 0);
});

test("an all-programs dump is 36 programs in program-change order", () => {
  const bytes = new Uint8Array(36 * PROGRAM_BYTE_COUNT);
  for (let i = 0; i < 36; i++) bytes.set(makeProgram(`Patch ${i + 1}`, { 3: i & 0x0f }), i * PROGRAM_BYTE_COUNT);

  const reply = dumpReply({ type: DUMP_TYPE_ALL_PROGRAMS, programBytes: bytes });
  assert.equal(reply.length, 7 + 1 + 36 * PROGRAM_BYTE_COUNT * 2 + 1, "header, version, 5760 nibbles, EOX");

  const parsed = parseDumpMessage(Uint8Array.from(reply));
  assert.equal(parsed.byteCount, 2880, "2880 bytes = 36 x 80");
  assert.equal(parsed.programNumber, undefined, "an all-programs dump names no program");

  const programs = splitPrograms(parsed.bytes, layout.programByteCount);
  assert.equal(programs.length, 36);
  assert.equal(readProgram(programs[0], layout).name, "Patch 1");
  assert.equal(readProgram(programs[35], layout).name, "Patch 36");
  assert.equal(readProgramValues(programs[35], layout).get(12), 35 & 0x0f, "9D's amp model");
});

// --- The adapter flow behind the patch list --------------------------------

/** An all-programs reply whose programs are named "Patch 1" .. "Patch 36". */
function allProgramsReply() {
  const bytes = new Uint8Array(36 * PROGRAM_BYTE_COUNT);
  for (let i = 0; i < 36; i++) bytes.set(makeProgram(`Patch ${i + 1}`), i * PROGRAM_BYTE_COUNT);
  return dumpReply({ type: DUMP_TYPE_ALL_PROGRAMS, programBytes: bytes });
}

test("reading the patch list asks for all programs and labels them 1A-9D", async () => {
  const replies = new Map([[DUMP_TYPE_ALL_PROGRAMS, allProgramsReply()]]);
  const { midi, device } = await openFakeDevice(replies);

  const listed = await device.requestProgramNames();
  assert.deepEqual(midi.sent[0], [...buildAllProgramsDumpRequest()], "one message, not 36 requests");
  assert.equal(listed.length, 36);
  assert.deepEqual(listed[0], { programNumber: 0, programChangeNumber: 1, label: "1A", name: "Patch 1" });
  assert.deepEqual(listed[35], { programNumber: 35, programChangeNumber: 36, label: "9D", name: "Patch 36" });
  assert.deepEqual(device.programs, listed, "the list is cached for the UI");
  await device.close();
});

test("the patch list listener fires with the names, and again when one changes", async () => {
  const replies = new Map([
    [DUMP_TYPE_ALL_PROGRAMS, allProgramsReply()],
    [DUMP_TYPE_PROGRAM, dumpReply({ type: DUMP_TYPE_PROGRAM, programNumber: 2, programBytes: makeProgram("Renamed") })],
  ]);
  const { device } = await openFakeDevice(replies);

  const seen = [];
  device.addProgramListChangedListener((d, programs) => seen.push(programs.map((p) => p.name).slice(0, 3)));
  await device.requestProgramNames();
  assert.deepEqual(seen, [["Patch 1", "Patch 2", "Patch 3"]]);

  // Reading one program keeps the list's name for it in step. requestProgramDump()
  // takes a program number, so 2 is 1C - the third row.
  await device.requestProgramDump(2);
  assert.deepEqual(seen[1], ["Patch 1", "Patch 2", "Renamed"]);
  assert.equal(device.programs[2].name, "Renamed");
  assert.equal(device.programs[1].name, "Patch 2", "its neighbours are untouched");
  await device.close();
});

test("clicking a patch recalls it on the POD and reads it back", async () => {
  const program = makeProgram("Heavy", { 3: 5, 4: 20 }); // Eighties amp, drive 20
  const replies = new Map([
    [DUMP_TYPE_PROGRAM, dumpReply({ type: DUMP_TYPE_PROGRAM, programNumber: 4, programBytes: program })],
  ]);
  const { midi, device } = await openFakeDevice(replies);

  const loadedEvents = [];
  device.addProgramLoadedListener((d, payload) => loadedEvents.push(payload));

  const loaded = await device.loadProgram(4); // program 4 == 2A
  assert.deepEqual(midi.sent[0], [0xc0, 5], "program change 5 is 2A");
  assert.deepEqual(midi.sent[1], [...buildProgramDumpRequest(4)]);

  assert.equal(loaded.programNumber, 4);
  assert.equal(loaded.label, "2A");
  assert.equal(loaded.name, "Heavy");
  assert.equal(loaded.values.get(12), 5);
  assert.equal(loaded.values.get(13), 40, "drive is stored as 20 and reported doubled");

  assert.equal(loadedEvents.length, 1, "the payload reaches the UI through the listener");
  assert.equal(loadedEvents[0].label, "2A");
  await device.close();
});

test("the edit buffer comes back labelled with the program the POD reported", async () => {
  const replies = new Map([
    [DUMP_TYPE_EDIT_BUFFER, dumpReply({ type: DUMP_TYPE_EDIT_BUFFER, programBytes: capturedProgram })],
  ]);
  const { device } = await openFakeDevice(replies);

  const loaded = await device.requestEditBufferDump();
  assert.equal(loaded.name, "Eighties");
  assert.equal(loaded.values.get(17), 126);
  assert.equal(loaded.programNumber, undefined, "the edit buffer carries no program number");
  assert.equal(loaded.label, undefined, "and nothing has told the app which program is playing yet");

  // Once a program change has been seen (or sent), the label is known.
  device.sendProgramChange(1);
  const second = await device.requestEditBufferDump();
  assert.equal(second.label, "1A");
  await device.close();
});

test("a POD that never answers times out instead of hanging the app", async () => {
  const { device } = await openFakeDevice(new Map());
  assert.equal(await device.requestProgramNames(), undefined);
  assert.equal(await device.requestProgramDump(0), undefined);
  assert.equal(await device.requestEditBufferDump(), undefined);
  assert.deepEqual(device.programs, [], "no list rather than a made-up one");
  await device.close();
});

test("a truncated dump is ignored rather than read as a program of zeros", async () => {
  const half = makeProgram("cut short").slice(0, PROGRAM_BYTE_COUNT / 2);
  const replies = new Map([[DUMP_TYPE_EDIT_BUFFER, dumpReply({ type: DUMP_TYPE_EDIT_BUFFER, programBytes: half })]]);
  const { device } = await openFakeDevice(replies);

  const loaded = await device.requestEditBufferDump();
  assert.equal(loaded, undefined, "the app would rather have nothing than invented values");
  await device.close();
});
