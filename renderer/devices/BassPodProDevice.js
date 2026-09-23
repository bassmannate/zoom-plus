import { MessageType } from "../lib/midiproxy.js";
import { getChannelMessage } from "../lib/miditools.js";
import { shouldLog, LogLevel } from "../lib/Logger.js";

// ---------------------------------------------------------------------------
// Line 6 Bass POD Pro - live MIDI control-change adapter.
//
// The Bass POD Pro is not a patch-editor device in the way the Zoom MS Plus
// pedals are: every front-panel control is mirrored by a plain control-change
// message on the POD's global MIDI channel, so the whole panel can be driven
// (and observed) with CCs alone.
//
// Verified message envelope, from "Bass POD Pro Sysex - English.pdf" (page 1):
//
//   program dump request    F0 00 01 0C 02 00 00 <program #> F7
//   edit buffer request     F0 00 01 0C 02 00 01 F7
//   all programs request    F0 00 01 0C 02 00 02 F7
//   program dump reply      F0 00 01 0C 02 01 00 <program #> <version> <data> F7
//   edit buffer reply       F0 00 01 0C 02 01 01 <version> <data> F7
//   all programs reply      F0 00 01 0C 02 01 02 <version> <data> F7
//
// <data> is nibble-encoded: 160 bytes for one 80-byte program, 5760 bytes for
// all 36 programs (2880 bytes = 36 x 80). Those dump messages are NOT
// implemented here yet - this class currently speaks CC only, which is what
// the fixed-panel UI uses. The envelope above is recorded so the dump pass has
// the request/response formats to hand.
//
// Control numbers, ranges and value names come from
// mapping/bass_pod_pro_mapping.ods and are carried in the device's profile
// JSON (renderer/data/bass-pod-pro.json) rather than being hard-coded here.
// ---------------------------------------------------------------------------

// A control we just told the POD about should not bounce straight back and
// yank the on-screen knob around. Real hardware doesn't echo, but a MIDI
// interface in "thru" mode (or a loopback port) can, so anything arriving
// within this window for a control we just sent is treated as our own echo.
const ECHO_SUPPRESSION_MS = 200;

export class BassPodProDevice {
    static PROGRAM_CHANGE_MANUAL = 0;
    static PROGRAM_CHANGE_TUNER = 37;

    /**
     * @param midi A MIDIProxy implementation (renderer: MIDIProxyForWebMIDIAPI)
     * @param midiDevice The MIDIDeviceDescription this device was identified as
     * @param profileData Parsed contents of renderer/data/bass-pod-pro.json
     * @param options { channel, now }
     */
    constructor(midi, midiDevice, profileData, options = {}) {
        this._midi = midi;
        this._midiDevice = midiDevice;
        this._profile = profileData;
        // MIDI channel index, not channel number: 0 is what the POD's front
        // panel calls channel 1. Global on the POD, so if the app and the POD
        // disagree the POD will simply ignore everything we send.
        this._channel = options.channel ?? Math.max(0, (profileData?.channel ?? 1) - 1);
        this._now = options.now ?? (() => performance.now());
        this._isOpen = false;
        this._inputHandle = undefined;
        this._outputHandle = undefined;
        this._openCloseListeners = [];
        this._parameterChangedListeners = [];
        this._programChangedListeners = [];
        this._recentlySent = new Map(); // ccNumber -> timestamp
        this._ccToControl = buildControlLookup(profileData);
        this._midiMessageHandler = (_deviceHandle, data) => this._handleMessage(data);
    }

    get isOpen() {
        return this._isOpen;
    }

    get deviceName() {
        return this._profile?.label || this._midiDevice?.deviceName || "Bass POD Pro";
    }

    /** MIDI channel number as printed on the POD (1-16). */
    get channel() {
        return this._channel + 1;
    }

    get profile() {
        return this._profile;
    }

    /** Control descriptor for a control-change number, or undefined. */
    controlForCc(ccNumber) {
        return this._ccToControl.get(ccNumber);
    }

    // --- Lifecycle ---------------------------------------------------------

    async open() {
        if (this._isOpen) return;
        this._inputHandle = await this._midi.openInput(this._midiDevice.inputID);
        this._outputHandle = await this._midi.openOutput(this._midiDevice.outputID);
        this._midi.addListener(this._midiDevice.inputID, this._midiMessageHandler);
        this._setIsOpen(true);
    }

    async close() {
        if (!this._isOpen) return;
        this._midi.removeListener(this._midiDevice.inputID, this._midiMessageHandler);
        try {
            await this._midi.closeInput(this._midiDevice.inputID);
        } catch (e) {
            shouldLog(LogLevel.Info) && console.log(`BassPodProDevice.close() input: ${e.message}`);
        }
        try {
            await this._midi.closeOutput(this._midiDevice.outputID);
        } catch (e) {
            shouldLog(LogLevel.Info) && console.log(`BassPodProDevice.close() output: ${e.message}`);
        }
        this._setIsOpen(false);
    }

    _setIsOpen(open) {
        this._isOpen = open;
        for (const listener of this._openCloseListeners) listener(this, open);
    }

    // --- Outbound ----------------------------------------------------------

    /**
     * Sends one parameter to the POD.
     * @param ccNumber Control-change number (from the profile)
     * @param value 0-127; clamped to that control's documented range
     */
    setParameter(ccNumber, value) {
        if (!this._isOpen) return;
        const control = this._ccToControl.get(ccNumber);
        const min = control ? control.min : 0;
        const max = control ? control.max : 127;
        const clamped = Math.max(min, Math.min(max, Math.round(value)));
        this._recentlySent.set(ccNumber, this._now());
        this._midi.sendCC(this._midiDevice.outputID, this._channel, ccNumber, clamped);
    }

    sendProgramChange(programChangeNumber) {
        if (!this._isOpen) return;
        this._midi.sendPC(this._midiDevice.outputID, this._channel, programChangeNumber & 0x7f);
    }

    // --- Inbound -----------------------------------------------------------

    _handleMessage(data) {
        const [messageType, , data1, data2] = getChannelMessage(data);

        if (messageType === MessageType.CC) {
            const sentAt = this._recentlySent.get(data1);
            if (sentAt !== undefined) {
                if (this._now() - sentAt < ECHO_SUPPRESSION_MS) {
                    shouldLog(LogLevel.Midi) && console.log(`BassPodProDevice: swallowed echo of CC ${data1} (${data2})`);
                    return;
                }
                this._recentlySent.delete(data1);
            }
            const control = this._ccToControl.get(data1);
            for (const listener of this._parameterChangedListeners) listener(this, data1, data2, control);
        }
        else if (messageType === MessageType.PC) {
            for (const listener of this._programChangedListeners) listener(this, data1, this.programLabelFor(data1));
        }
    }

    /** "1A".."9D" for a program-change number, or "Manual"/"Tuner"/undefined. */
    programLabelFor(programChangeNumber) {
        if (programChangeNumber === BassPodProDevice.PROGRAM_CHANGE_MANUAL) return "Manual";
        if (programChangeNumber === BassPodProDevice.PROGRAM_CHANGE_TUNER) return "Tuner";
        const programs = this._profile?.programs;
        if (!programs) return undefined;
        const index = programChangeNumber - (programs.pcBase ?? 1);
        if (index < 0 || index >= programs.count) return undefined;
        const banksOf = programs.banksOf ?? 4;
        const bank = Math.floor(index / banksOf) + 1;
        return `${bank}${"ABCD".charAt(index % banksOf)}`;
    }

    // --- Listeners ---------------------------------------------------------

    addOpenCloseListener(listener) {
        this._openCloseListeners.push(listener);
    }

    removeOpenCloseListener(listener) {
        this._openCloseListeners = this._openCloseListeners.filter((l) => l !== listener);
    }

    /** listener(device, ccNumber, value, control|undefined) */
    addParameterChangedListener(listener) {
        this._parameterChangedListeners.push(listener);
    }

    removeParameterChangedListener(listener) {
        this._parameterChangedListeners = this._parameterChangedListeners.filter((l) => l !== listener);
    }

    /** listener(device, programChangeNumber, label|undefined) */
    addProgramChangedListener(listener) {
        this._programChangedListeners.push(listener);
    }

    removeProgramChangedListener(listener) {
        this._programChangedListeners = this._programChangedListeners.filter((l) => l !== listener);
    }
}

/**
 * Builds ccNumber -> control descriptor from the profile's groups.
 * Every control with a "cc" gets an entry; min/max fall back to the full
 * control-change range when the profile doesn't state them.
 * @returns Map<number, object>
 */
export function buildControlLookup(profileData) {
    const lookup = new Map();
    for (const group of profileData?.groups ?? []) {
        for (const control of group.controls ?? []) {
            if (control.cc === undefined || control.cc === null) continue;
            lookup.set(control.cc, {
                ...control,
                groupId: group.id,
                groupName: group.name,
                min: control.min ?? 0,
                max: control.max ?? 127,
            });
        }
    }
    return lookup;
}
