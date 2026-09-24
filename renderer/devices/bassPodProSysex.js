// Line 6 Bass POD Pro sys-ex program dump codec.
//
// Everything in this file is pure - bytes in, values out, no MIDI and no DOM -
// so the whole codec is covered by the test suite without any hardware. The
// device adapter (BassPodProDevice.js) owns the transport and the UI.
//
// Message shapes, from "Bass POD Pro Sysex - English.pdf" (SYSTEM EXCLUSIVE
// OPCODES + DATA DUMP FORMAT sections):
//
//   request   F0 00 01 0C 02 00 <type> [<program #>] F7
//   reply     F0 00 01 0C 02 01 <type> [<program #>] <version> <nibbles> F7
//
//     00 01 0C  Line 6 ("Fast Forward") manufacturer ID
//     02        Bass POD family ID
//     00        opcode: data dump request      01  opcode: data dump
//
//   type 00 = one stored program (<program #> = 0x00-0x23, i.e. 1A-9D)
//   type 01 = the edit buffer (what the POD is playing right now)
//   type 02 = all 36 programs in a single message
//
// Program data is nibble-encoded, HIGH nibble first: every 8-bit program byte
// travels as two bytes, 0000hhhh then 0000llll. A program is 80 bytes, so a
// one-program dump carries 160 nibbles and an all-programs dump 5760 (2880
// bytes = 36 x 80). <version> must match or the POD refuses an upload; it is
// a data-format version (1), not the firmware revision.
//
// Which byte holds which parameter - and how its bit field maps to a
// control-change value - is data, not code: it lives in
// renderer/data/bass-pod-pro.json under "sysexLayout".

export const LINE6_MANUFACTURER_ID = [0x00, 0x01, 0x0c];
export const BASS_POD_PRO_FAMILY_ID = 0x02;

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;

export const OPCODE_REQUEST = 0x00;
export const OPCODE_DUMP = 0x01;

export const DUMP_TYPE_PROGRAM = 0x00;
export const DUMP_TYPE_EDIT_BUFFER = 0x01;
export const DUMP_TYPE_ALL_PROGRAMS = 0x02;

// Data format version this codec speaks. A dump carrying anything else is
// still parsed, but the field offsets below are only known to be right for
// version 1, so callers should check.
export const DUMP_VERSION = 1;

/** 80 bytes per program; the POD has 36 internal programs (1A-9D). */
export const PROGRAM_BYTE_COUNT = 80;

/**
 * Pairs up the nibbles in a dump: high nibble first, as the PDF's
 * "TRANSMITTED and RECEIVED AS" table describes.
 * An odd trailing nibble is ignored rather than producing a bad byte.
 * @param nibbles Array of values, each 0-15
 * @returns Uint8Array of half the length
 */
export function decodeNibbles(nibbles) {
    const byteCount = Math.floor(nibbles.length / 2);
    const bytes = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i++) {
        bytes[i] = ((nibbles[i * 2] & 0x0f) << 4) | (nibbles[i * 2 + 1] & 0x0f);
    }
    return bytes;
}

/**
 * The inverse of decodeNibbles - used when a dump is built for upload, and to
 * keep round-trip tests honest.
 * @param bytes Uint8Array (or array) of 8-bit values
 * @returns Uint8Array with two nibbles per input byte
 */
export function encodeNibbles(bytes) {
    const nibbles = new Uint8Array(bytes.length * 2);
    for (let i = 0; i < bytes.length; i++) {
        nibbles[i * 2] = (bytes[i] >> 4) & 0x0f;
        nibbles[i * 2 + 1] = bytes[i] & 0x0f;
    }
    return nibbles;
}

function podMessage(...bytes) {
    return Uint8Array.from([SYSEX_START, ...LINE6_MANUFACTURER_ID, BASS_POD_PRO_FAMILY_ID, ...bytes, SYSEX_END]);
}

/** F0 00 01 0C 02 00 00 <program #> F7 - asks for one stored program. */
export function buildProgramDumpRequest(programNumber) {
    return podMessage(OPCODE_REQUEST, DUMP_TYPE_PROGRAM, programNumber & 0x7f);
}

/** F0 00 01 0C 02 00 01 F7 - asks for the edit buffer (what is playing). */
export function buildEditBufferDumpRequest() {
    return podMessage(OPCODE_REQUEST, DUMP_TYPE_EDIT_BUFFER);
}

/** F0 00 01 0C 02 00 02 F7 - asks for all 36 programs in one message. */
export function buildAllProgramsDumpRequest() {
    return podMessage(OPCODE_REQUEST, DUMP_TYPE_ALL_PROGRAMS);
}

/**
 * Converts a control-change value into the value a dump carries for it - the
 * inverse of valueFromField().
 *
 * The POD stores most continuous parameters in 6 bits (0-63) while their
 * control-change range runs 0-126, and the two line up as
 * "stored * 2 = control change". That is why 126 (0x7E) is the top of every
 * one of those ranges (the ODS max-value column), and one dump captured from
 * real hardware agrees (test/fixtures/bass-pod-pro-edit-buffer.txt stores
 * Channel Volume as 63, the panel's maximum). Pinched from the PDF's
 * "Bass Pod Data Structure" / "Transmitted MIDI Range" columns.
 */
export function storedValueFromCc(ccValue, scale = 1) {
    return Math.round(ccValue / (scale || 1));
}

/**
 * Recognises a Bass POD Pro dump (or dump request) and pulls it apart.
 *
 * Only messages this codec fully understands are returned: a Line 6 message
 * whose family or opcode doesn't match comes back undefined so callers can
 * ignore it. (The universal identity reply the POD also sends is handled by
 * renderer/lib/miditools.js, not here.)
 *
 * @param data Raw MIDI message
 * @returns {{ opcode, type, programNumber, version, byteCount, nibbles, bytes }|undefined}
 */
export function parseDumpMessage(data) {
    if (!data || data.length < 6) return undefined;
    if (data[0] !== SYSEX_START) return undefined;
    if (data[data.length - 1] !== SYSEX_END) return undefined;
    for (let i = 0; i < LINE6_MANUFACTURER_ID.length; i++) {
        if (data[1 + i] !== LINE6_MANUFACTURER_ID[i]) return undefined;
    }
    if (data[4] !== BASS_POD_PRO_FAMILY_ID) return undefined;

    const opcode = data[5];
    if (opcode !== OPCODE_REQUEST && opcode !== OPCODE_DUMP) return undefined;

    const type = data[6];
    const hasProgramNumber = type === DUMP_TYPE_PROGRAM;
    // A reply is <opcode> <type> [program #] <version> <nibbles>; a request
    // stops after the program number and carries no version.
    const versionIndex = hasProgramNumber ? 8 : 7;
    const nibbles = Array.from(data.slice(versionIndex + 1, data.length - 1));

    return {
        opcode,
        type,
        programNumber: hasProgramNumber ? data[7] : undefined,
        version: opcode === OPCODE_DUMP ? data[versionIndex] : undefined,
        byteCount: Math.floor(nibbles.length / 2),
        nibbles,
        bytes: decodeNibbles(nibbles),
    };
}

/** True when a parsed message is a dump carrying program data. */
export function isDecodableDump(parsed) {
    return !!parsed && parsed.opcode === OPCODE_DUMP && parsed.byteCount > 0;
}

/**
 * Splits an all-programs dump into one 80-byte slice per program.
 * @returns Uint8Array[] indexed by program number (0 = 1A), so the array's
 *          order is also the program-change order.
 */
export function splitPrograms(bytes, programByteCount = PROGRAM_BYTE_COUNT) {
    const programs = [];
    for (let offset = 0; offset + programByteCount <= bytes.length; offset += programByteCount) {
        programs.push(bytes.slice(offset, offset + programByteCount));
    }
    return programs;
}

/**
 * Pulls one bit field out of a program byte.
 * @param byte The raw program byte
 * @param bits [highest bit, lowest bit], both inclusive - the PDF's MSb/LSb
 *             columns. Omitted means "the whole byte".
 */
export function readBitField(byte, bits) {
    if (!bits) return byte & 0x7f;
    const [high, low] = bits;
    if (high < low) return 0;
    const width = high - low + 1;
    const mask = ((1 << width) - 1) << low;
    return (byte & mask) >>> low;
}
/**
 * Converts one dump field into the control-change value the panel shows.
 *
 * mode "value"  the stored value IS the control-change value (amp model,
 *               cabinet, effect select - the value tables are ordered that way)
 * mode "scale"  the stored value is multiplied by "scale" (2 for the POD's
 *               6-bit continuous parameters)
 * mode "bit"    a single bit standing for an on/off parameter, reported as the
 *               control's off/on values (the DI switch sends 0/127)
 *
 * @param field A "sysexLayout.fields" entry
 * @param programBytes The 80-byte program the field lives in
 * @param control The profile control the field feeds, when there is one
 */
export function valueFromField(field, programBytes, control) {
    const raw = readBitField(programBytes[field.byte], field.bits);
    switch (field.mode) {
        case "bit":
            return raw
                ? (control?.onValue ?? field.onValue ?? 127)
                : (control?.offValue ?? field.offValue ?? 0);
        case "scale": {
            const scaled = raw * (field.scale ?? 1);
            return control?.max === undefined ? scaled : Math.min(scaled, control.max);
        }
        default:
            return raw;
    }
}

/**
 * Reads a program's patch name. The name is 16 ASCII characters, space
 * padded - real hardware sends "Eighties" followed by eight spaces.
 * @returns trimmed name, or "" when the program is empty
 */
export function readPatchName(programBytes, layout) {
    const start = layout?.nameByte ?? 64;
    const length = layout?.nameLength ?? 16;
    let name = "";
    for (let i = 0; i < length; i++) {
        const byte = programBytes[start + i];
        if (byte === undefined || byte === 0) break;
        name += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : " ";
    }
    return name.trim();
}

/**
 * Every panel value a program dump can supply.
 *
 * Fields the profile has no control for are returned too: they are useful when
 * reading a dump by hand, and app.js ignores control changes it has no widget
 * for - exactly what it already does with live control changes.
 *
 * @param programBytes 80 bytes of program data
 * @param layout "sysexLayout" from renderer/data/bass-pod-pro.json
 * @returns Map of control-change number -> value
 */
export function readProgramValues(programBytes, layout) {
    const values = new Map();
    for (const field of layout?.fields ?? []) {
        if (field.byte === undefined || field.byte >= programBytes.length) continue;
        values.set(field.cc, valueFromField(field, programBytes, field.control));
    }
    return values;
}

/** Name + values for one 80-byte program, ready for the panel. */
export function readProgram(programBytes, layout) {
    return {
        name: readPatchName(programBytes, layout),
        values: readProgramValues(programBytes, layout),
    };
}


