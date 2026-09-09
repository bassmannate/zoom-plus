import { iconSvgFor, categorize } from "./effect-icons.js";
import { MIDIProxyForWebMIDIAPI } from "./lib/MIDIProxyForWebMIDIAPI.js";
import { getMIDIDeviceList } from "./lib/miditools.js";
import { ZoomDevice } from "./lib/ZoomDevice.js";

// Model number (from the identity reply) -> effect mapping file. Only the
// two models actually confirmed against real hardware are listed - see
// THIRD_PARTY_NOTICES.md and the zoomplus/ project's README for how these
// were found.
//
// MS-70CDR+'s mapping file is already bundled (renderer/data/) and its
// effect-icon category table is already built (effect-icons.js) - both
// verified against the real data (150/150 effects categorized cleanly).
// The only missing piece is its model number byte, which can only come
// from running `identify` against real hardware (it's a protocol detail,
// not something in Zoom's published manuals). Once known, add it both
// here and in effect-icons.js's PREFIX_CATEGORY - that's the entire fix.
const MODEL_TO_MAPPING_FILE = {
  0x23: "data/zoom-effect-mappings-ms50gp.json",
  0x27: "data/zoom-effect-mappings-ms60bp.json",
  // 0x??: "data/zoom-effect-mappings-ms70cdrp.json", // MS-70CDR+ - see above
};

const ZOOM_MANUFACTURER_ID = 0x52;

let midi = null;
let device = null;
let effectMap = {};
let currentModelByte = null;
let selectedSlot = null;
let selectedMemorySlot = null;

const el = (id) => document.getElementById(id);
const els = {
  connLed: el("conn-led"),
  connLabel: el("conn-label"),
  patchNumber: el("patch-number"),
  patchName: el("patch-name"),
  patchTempo: el("patch-tempo"),
  btnConnect: el("btn-connect"),
  btnSync: el("btn-sync"),
  btnRestore: el("btn-restore"),
  btnBackup: el("btn-backup"),
  btnSave: el("btn-save"),
  btnLoad: el("btn-load"),
  patchList: el("patch-list"),
  chainEmpty: el("chain-empty"),
  chainWrap: el("chain-wrap"),
  chain: el("chain"),
  detail: el("detail"),
  detailName: el("detail-name"),
  detailBypass: el("detail-bypass"),
  detailKnobs: el("detail-knobs"),
  statusText: el("status-text"),
  crcIndicator: el("crc-indicator"),
  library: el("library"),
  libraryContent: el("library-content"),
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function status(msg, isError = false) {
  els.statusText.textContent = msg;
  els.statusText.style.color = isError ? "var(--accent-red)" : "";
  if (isError) console.error(msg);
}

function updateRestoreButtonState() {
  els.btnRestore.disabled = !device || !device.isOpen || selectedMemorySlot === null;
}

function setConnected(open, name) {
  els.connLed.className = "led " + (open ? "led-on" : "led-off");
  els.connLabel.textContent = open ? name : "Not connected";
  for (const b of [els.btnSync, els.btnBackup, els.btnSave, els.btnLoad]) b.disabled = !open;
  els.btnConnect.textContent = open ? "Reconnect" : "Connect";
  els.chainEmpty.classList.toggle("hidden", open);
  els.chainWrap.classList.toggle("hidden", !open);
  els.library.classList.toggle("hidden", !open);
  if (!open) {
    els.patchNumber.textContent = "--";
    els.patchName.value = "";
    els.patchTempo.textContent = "--";
    selectedMemorySlot = null;
    els.libraryContent.innerHTML = "";
  }
  updateRestoreButtonState();
}

async function loadEffectMapFor(modelNumber) {
  effectMap = {};
  const key = modelNumber ? modelNumber[0] : undefined;
  currentModelByte = key ?? null;
  const file = MODEL_TO_MAPPING_FILE[key];
  if (!file) {
    status(`No effect map for model ${key !== undefined ? "0x" + key.toString(16) : "?"} yet - modules will show raw IDs.`);
    return;
  }
  try {
    const res = await fetch(file);
    effectMap = await res.json();
  } catch (e) {
    status("Could not load effect map: " + e.message, true);
  }
}

function effectInfo(id) {
  const key = (id >>> 0).toString(16).padStart(8, "0");
  return effectMap[key] || null;
}

// --- Connect flow --------------------------------------------------------

async function connect() {
  status("Requesting MIDI access…");
  try {
    midi = new MIDIProxyForWebMIDIAPI();
    await midi.enable();
  } catch (e) {
    status("MIDI access was denied, or Web MIDI isn't available.", true);
    return;
  }

  status("Looking for a Zoom pedal…");
  let descriptions;
  try {
    descriptions = await getMIDIDeviceList(midi, midi.inputs, midi.outputs, 150, false);
  } catch (e) {
    status("Error scanning MIDI devices: " + e.message, true);
    return;
  }
  const zoomOnes = descriptions.filter((d) => d.manufacturerID && d.manufacturerID[0] === ZOOM_MANUFACTURER_ID);
  if (zoomOnes.length === 0) {
    status("No Zoom pedal found. Check the USB connection and try again.", true);
    return;
  }

  if (device) {
    try { await device.close(); } catch (e) { /* already closed, ignore */ }
  }

  const desc = zoomOnes[0];
  device = new ZoomDevice(midi, desc);
  wireDeviceEvents(device);

  status(`Connecting to ${desc.deviceName}…`);
  try {
    await device.open();
  } catch (e) {
    status("Could not open the pedal: " + e.message, true);
    return;
  }
  device.parameterEditEnable();

  await loadEffectMapFor(desc.modelNumber);
  populateLibrary();
  setConnected(true, device.deviceName || desc.deviceName);
  status("Connected.");

  try {
    await device.downloadCurrentPatch();
  } catch (e) {
    status("Connected, but couldn't read the current patch: " + e.message, true);
  }
  loadPatchList(); // don't block the UI on a full patch-list read
}

function wireDeviceEvents(dev) {
  dev.addCurrentPatchChangedListener((d) => renderChain(d.currentPatch));
  dev.addEffectParameterChangedListener((d, slot, paramNum, value) => {
    if (slot === selectedSlot) updateKnobDisplay(paramNum, value);
  });
  dev.addTempoChangedListener((d, tempo) => { els.patchTempo.textContent = tempo; });
  dev.addOpenCloseListener((d, open) => {
    setConnected(open, d.deviceName);
    status(open ? "Connected." : "Disconnected.");
  });
}

async function loadPatchList() {
  status("Loading patch list…");
  try {
    await device.updatePatchListFromPedal();
    renderPatchList(device.patchList);
    status("Ready.");
  } catch (e) {
    status("Could not load the patch list: " + e.message, true);
  }
}

function renderPatchList(patches) {
  els.patchList.innerHTML = "";
  patches.forEach((patch, i) => {
    const li = document.createElement("li");
    if (selectedMemorySlot === i) {
      li.classList.add("active");
    }
    li.innerHTML = `<span class="p-num">${String(i).padStart(2, "0")}</span>` +
      `<span class="p-name">${escapeHtml(patch?.name || "(empty)")}</span>`;
    li.addEventListener("click", () => selectPatchFromList(i, li));
    els.patchList.appendChild(li);
  });
}

async function selectPatchFromList(index, li) {
  selectedMemorySlot = index;
  updateRestoreButtonState();
  status(`Loading patch ${index}…`);
  try {
    const loaded = await device.downloadPatchFromMemorySlot(index);
    if (!loaded) { status(`Patch ${index} came back empty.`, true); return; }
    device.uploadPatchToCurrentPatch(loaded); // pushes to the pedal's edit buffer, fires currentPatchChanged
    [...els.patchList.children].forEach((c) => c.classList.remove("active"));
    li.classList.add("active");
    els.patchNumber.textContent = String(index).padStart(2, "0");
    status("Ready.");
  } catch (e) {
    status(`Could not load patch ${index}: ${e.message}`, true);
  }
}

// --- Signal chain rendering ------------------------------------------------

function renderChain(patch) {
  els.chain.innerHTML = "";
  selectedSlot = null;
  els.detail.classList.add("hidden");
  if (!patch) return;

  els.patchName.value = patch.name || "";
  els.patchTempo.textContent = patch.tempo ?? "--";

  const settings = patch.effectSettings || [];
  els.crcIndicator.textContent = `${settings.length} effect${settings.length === 1 ? "" : "s"}`;

  settings.forEach((eff, i) => {
    if (i > 0) {
      const wire = document.createElement("div");
      wire.className = "wire";
      els.chain.appendChild(wire);
    }
    const info = effectInfo(eff.id);
    const label = info?.screenName || info?.name || "Effect " + eff.id.toString(16);
    const mod = document.createElement("div");
    mod.className = "module draggable" + (eff.enabled ? " enabled" : "");
    mod.dataset.slot = String(i);
    mod.draggable = true;
    mod.innerHTML =
      `<div class="module-body">${iconSvgFor(currentModelByte, eff.id, info)}<div class="module-led"></div></div>` +
      `<div class="module-label">${escapeHtml(label)}</div>` +
      `<button class="module-delete" title="Remove effect">×</button>`;
    mod.addEventListener("click", () => selectEffect(patch, i));

    // Delete button
    mod.querySelector(".module-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteEffect(patch, i);
    });

    // Drag and drop for reordering within the chain
    mod.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-chain-slot", String(i));
      e.dataTransfer.effectAllowed = "move";
      mod.classList.add("dragging");
    });

    mod.addEventListener("dragend", () => {
      mod.classList.remove("dragging");
      hideChainDropHighlights();
    });

    mod.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-chain-slot")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      mod.classList.add("drag-over");
    });

    mod.addEventListener("dragleave", () => {
      mod.classList.remove("drag-over");
    });

    mod.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromSlot = parseInt(e.dataTransfer.getData("application/x-chain-slot"), 10);
      const toSlot = parseInt(mod.dataset.slot, 10);
      if (!isNaN(fromSlot) && !isNaN(toSlot) && fromSlot !== toSlot) {
        reorderEffect(patch, fromSlot, toSlot);
      }
      mod.classList.remove("drag-over");
    });

    els.chain.appendChild(mod);
  });

  updateLibraryState();
}

function deleteEffect(patch, slot) {
  if (!patch?.effectSettings) return;
  const info = effectInfo(patch.effectSettings[slot].id);
  patch.deleteEffectInSlot(slot);
  renderChain(patch);
  status(`Removed ${info?.name || "effect"} from chain.`);
}

function reorderEffect(patch, fromSlot, toSlot) {
  if (!patch?.effectSettings) return;
  if (toSlot < 0 || toSlot >= patch.effectSettings.length) return;
  if (fromSlot === toSlot) return;

  // Move effect by slicing it out and inserting at the new position
  const effect = patch.effectSettings[fromSlot];
  patch.effectSettings.splice(fromSlot, 1);
  patch.effectSettings.splice(toSlot, 0, effect);

  // Update IDs array to match
  if (patch.ids !== null) {
    const id = patch.ids[fromSlot];
    // Shift IDs
    if (fromSlot < toSlot) {
      for (let i = fromSlot; i < toSlot; i++) {
        patch.ids[i] = patch.ids[i + 1];
      }
    } else {
      for (let i = fromSlot; i > toSlot; i--) {
        patch.ids[i] = patch.ids[i - 1];
      }
    }
    patch.ids[toSlot] = id;
  }

  renderChain(patch);
  // Update selection to follow the moved effect
  if (selectedSlot === fromSlot) {
    selectEffect(patch, toSlot);
  } else if (selectedSlot === toSlot) {
    selectEffect(patch, fromSlot);
  }
}

function hideChainDropHighlights() {
  els.chain.querySelectorAll(".module.drag-over").forEach(m => m.classList.remove("drag-over"));
  els.chain.querySelectorAll(".wire.drag-over").forEach(w => w.classList.remove("drag-over"));
}

// --- Effect Library -------------------------------------------------------

const CATEGORY_ORDER = [
  "dynamics", "filter", "drive", "amp", "modulation",
  "pitch", "synth", "sfx", "delay", "reverb", "fx",
];

const CATEGORY_LABELS = {
  dynamics: "Dynamics",
  filter: "Filter",
  drive: "Drive",
  amp: "Amp",
  modulation: "Modulation",
  pitch: "Pitch",
  synth: "Synth",
  sfx: "SFX",
  delay: "Delay",
  reverb: "Reverb",
  fx: "Other",
};

function populateLibrary() {
  els.libraryContent.innerHTML = "";
  if (!effectMap || Object.keys(effectMap).length === 0) return;

  // Group effects by category
  const byCategory = {};
  for (const [hexId, info] of Object.entries(effectMap)) {
    const id = parseInt(hexId, 16);
    const category = categorize(currentModelByte, id, info.name);
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push({ id, info });
  }

  // Sort effects within each category by name
  for (const category of Object.keys(byCategory)) {
    byCategory[category].sort((a, b) => a.info.name.localeCompare(b.info.name));
  }

  // Render categories in order
  for (const category of CATEGORY_ORDER) {
    const effects = byCategory[category];
    if (!effects || effects.length === 0) continue;

    const catEl = document.createElement("div");
    catEl.className = "lib-category";

    const nameEl = document.createElement("div");
    nameEl.className = "lib-category-name";
    nameEl.textContent = CATEGORY_LABELS[category] || category;
    catEl.appendChild(nameEl);

    const effectsEl = document.createElement("div");
    effectsEl.className = "lib-category-effects";

    for (const { id, info } of effects) {
      const effEl = document.createElement("div");
      effEl.className = "lib-effect";
      effEl.draggable = true;
      effEl.dataset.effectId = String(id);

      const iconSvg = iconSvgFor(currentModelByte, id, info);
      effEl.innerHTML =
        `<div class="lib-effect-icon">${iconSvg}</div>` +
        `<div class="lib-effect-name" title="${escapeHtml(info.name)}">${escapeHtml(info.screenName || info.name)}</div>`;

      // Drag events for library items
      effEl.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-effect-id", String(id));
        e.dataTransfer.effectAllowed = "copy";
        effEl.classList.add("dragging");
      });

      effEl.addEventListener("dragend", () => {
        effEl.classList.remove("dragging");
        hideDropIndicator();
        updateLibraryState();
      });

      effectsEl.appendChild(effEl);
    }

    catEl.appendChild(effectsEl);
    els.libraryContent.appendChild(catEl);
  }

  updateLibraryState();
}

function updateLibraryState() {
  const patch = device?.currentPatch;
  const maxEffects = patch?.maxNumEffects ?? device?.maxNumEffects ?? 6;
  const currentCount = patch?.effectSettings?.length ?? 0;
  els.library.classList.toggle("full", currentCount >= maxEffects);
}

function setupChainDropZone() {
  // Make the chain a drop zone for new effects from the library
  els.chain.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-effect-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    showDropIndicator(e);
  });

  els.chain.addEventListener("dragleave", (e) => {
    // Only hide if we're leaving the chain entirely (not entering a child)
    if (!els.chain.contains(e.relatedTarget)) {
      hideDropIndicator();
    }
  });

  els.chain.addEventListener("drop", (e) => {
    e.preventDefault();
    const effectId = parseInt(e.dataTransfer.getData("application/x-effect-id"), 10);
    if (isNaN(effectId)) return;

    const patch = device?.currentPatch;
    if (!patch) return;

    const maxEffects = patch.maxNumEffects;
    if (patch.effectSettings.length >= maxEffects) {
      status(`Maximum ${maxEffects} effects reached.`, true);
      hideDropIndicator();
      return;
    }

    const dropIndex = getDropIndex(e);
    addEffectToPatch(patch, effectId, dropIndex);
    hideDropIndicator();
  });
}

function showDropIndicator(e) {
  hideDropIndicator(); // clear any existing

  const indicator = document.createElement("div");
  indicator.className = "chain-drop-indicator active";
  indicator.id = "chain-drop-indicator";

  const dropIndex = getDropIndex(e);
  const modules = [...els.chain.querySelectorAll(".module")];

  if (dropIndex <= 0) {
    els.chain.prepend(indicator);
  } else if (dropIndex >= modules.length) {
    els.chain.appendChild(indicator);
  } else {
    // Insert before the module at dropIndex
    const targetModule = modules.find(m => Number(m.dataset.slot) === dropIndex);
    if (targetModule) {
      els.chain.insertBefore(indicator, targetModule);
    } else {
      els.chain.appendChild(indicator);
    }
  }
}

function hideDropIndicator() {
  const indicator = document.getElementById("chain-drop-indicator");
  if (indicator) indicator.remove();
}

function getDropIndex(e) {
  // Find the position in the chain where the effect should be inserted
  const modules = [...els.chain.querySelectorAll(".module")];
  if (modules.length === 0) return 0;

  // Get the mouse position relative to the chain
  const mouseX = e.clientX;

  // Find the module that the mouse is over
  for (let i = 0; i < modules.length; i++) {
    const rect = modules[i].getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (mouseX < midX) {
      return i;
    }
  }

  // Mouse is past all modules, insert at the end
  return modules.length;
}

async function addEffectToPatch(patch, effectId, slot) {
  const info = effectInfo(effectId);
  const numParams = info?.parameters?.length ?? 0;

  // Dynamically import EffectSettings from ZoomPatch
  const { EffectSettings } = await import("./lib/ZoomPatch.js");

  // Create EffectSettings with default parameter values
  const settings = new EffectSettings(numParams);
  settings.enabled = true;
  settings.id = effectId;

  // Set default parameter values from the effect mapping
  if (info?.parameters) {
    for (let i = 0; i < info.parameters.length; i++) {
      const param = info.parameters[i];
      settings.parameters[i] = param.default ?? 0;
    }
  }

  patch.addEffectInSlot(slot, settings);
  renderChain(patch);
  updateLibraryState();
  status(`Added ${info?.name || "effect"} to chain.`);
}

function selectEffect(patch, slot) {
  selectedSlot = slot;
  [...els.chain.querySelectorAll(".module")].forEach((m) => {
    m.classList.toggle("selected", Number(m.dataset.slot) === slot);
  });

  const eff = patch.effectSettings[slot];
  const info = effectInfo(eff.id);
  els.detail.classList.remove("hidden");
  els.detailName.textContent = info?.name || `Effect 0x${eff.id.toString(16)}`;

  els.detailBypass.checked = eff.enabled;
  els.detailBypass.onchange = () => {
    device.setEffectParameterForCurrentPatch(slot, 0, els.detailBypass.checked ? 1 : 0);
    document.querySelector(`.module[data-slot="${slot}"]`)?.classList.toggle("enabled", els.detailBypass.checked);
  };

  renderKnobs(eff, info, slot);
}

function renderKnobs(eff, info, slot) {
  els.detailKnobs.innerHTML = "";
  // eff.parameters is a fixed-size array (padded to the pedal's max
  // parameter slots) - it's NOT the number of real parameters for this
  // specific effect. The effect map's own parameter list is the true
  // count. Effects we don't have a map for (fallback) still show
  // whatever the live patch reports, since that's all we know.
  const paramCount = info?.parameters?.length ?? eff.parameters.length;
  for (let paramIndex = 0; paramIndex < paramCount; paramIndex++) {
    const value = eff.parameters[paramIndex];
    const paramInfo = info?.parameters?.[paramIndex];
    const max = paramInfo?.max ?? 127;
    const name = paramInfo?.name ?? `Param ${paramIndex + 1}`;
    const isUndocumented = /^hidden/i.test(name);

    const unit = document.createElement("div");
    unit.className = "knob-unit" + (isUndocumented ? " undocumented" : "");
    unit.title = isUndocumented
      ? "This is a real, controllable parameter that thammer's reverse-engineering found in the sysex protocol, but its actual function was never identified - likely because it's not shown on the pedal's own display either. Safe to experiment with; just know that neither this app nor the pedal can currently tell you what it does."
      : "";
    unit.innerHTML =
      `<div class="knob" data-param="${paramIndex}" data-max="${max}"></div>` +
      `<div class="knob-name">${escapeHtml(name)}</div>` +
      `<div class="knob-value">${escapeHtml(displayValue(paramInfo, value))}</div>`;
    els.detailKnobs.appendChild(unit);

    const knobEl = unit.querySelector(".knob");
    setKnobVisual(knobEl, value, max);
    wireKnobDrag(knobEl, slot, paramIndex, max, paramInfo);
  }
}

function displayValue(paramInfo, value) {
  if (paramInfo?.values && paramInfo.values[value] !== undefined) return paramInfo.values[value];
  return String(value);
}

function setKnobVisual(knobEl, value, max) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const angle = -135 + (270 * (max > 0 ? value / max : 0)); // -135deg..+135deg sweep
  knobEl.style.setProperty("--pct", pct.toFixed(1));
  knobEl.style.setProperty("--angle", `${angle.toFixed(1)}deg`);
}

function wireKnobDrag(knobEl, slot, paramIndex, max, paramInfo) {
  let dragging = false;
  let startY = 0;
  let startValue = 0;

  const onMove = (ev) => {
    if (!dragging) return;
    const deltaY = startY - ev.clientY; // dragging up increases value
    const range = 150; // px of drag for full sweep
    const deltaValue = Math.round((deltaY / range) * max);
    const newValue = Math.max(0, Math.min(max, startValue + deltaValue));
    setKnobVisual(knobEl, newValue, max);
    const valueEl = knobEl.parentElement.querySelector(".knob-value");
    valueEl.textContent = displayValue(paramInfo, newValue);
    device.setEffectParameterForCurrentPatch(slot, paramIndex + 2, newValue);
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  knobEl.addEventListener("pointerdown", (ev) => {
    dragging = true;
    startY = ev.clientY;
    startValue = device.currentPatch.effectSettings[slot].parameters[paramIndex];
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function updateKnobDisplay(paramNumber, value) {
  const paramIndex = paramNumber - 2;
  if (paramIndex < 0) return; // 0 = enable/bypass, 1 = effect id - not a knob
  const knobEl = els.detailKnobs.querySelector(`.knob[data-param="${paramIndex}"]`);
  if (!knobEl) return;
  const max = Number(knobEl.dataset.max);
  setKnobVisual(knobEl, value, max);
  const info = device?.currentPatch ? effectInfo(device.currentPatch.effectSettings[selectedSlot].id) : null;
  const paramInfo = info?.parameters?.[paramIndex];
  knobEl.parentElement.querySelector(".knob-value").textContent = displayValue(paramInfo, value);
}

// --- Transport: sync / save / load / backup --------------------------------

async function syncToPedal() {
  if (!device?.currentPatch) return;
  status("Syncing to pedal…");
  try {
    device.uploadPatchToCurrentPatch(device.currentPatch);
    status("Synced.");
  } catch (e) {
    status("Sync failed: " + e.message, true);
  }
}

function patchToBytes(patch) {
  // Clone the patch if it's frozen (e.g., from device.patchList) to avoid
  // "Cannot assign to read only property" errors in buildPTCFChunk/buildMSDataBuffer
  const p = Object.isFrozen(patch) ? patch.clone() : patch;
  return p.PTCF !== null ? p.buildPTCFChunk(device.ptcfNameLength) : p.buildMSDataBuffer();
}

async function savePatch() {
  if (!device?.currentPatch) return;
  const data = patchToBytes(device.currentPatch);
  if (!data) { status("Could not serialize this patch.", true); return; }
  const name = (device.currentPatch.name || "patch").trim().replace(/[^\w.-]+/g, "_");
  const result = await window.fileAPI.saveFile({
    defaultPath: `${name}.zpatch`,
    data,
    binary: true,
    filters: [{ name: "Zoom Patch", extensions: ["zpatch"] }],
  });
  if (!result.canceled) status(`Saved to ${result.filePath}`);
}

async function loadPatch() {
  if (!device) return;
  const result = await window.fileAPI.openFile({
    binary: true,
    filters: [{ name: "Zoom Patch", extensions: ["zpatch"] }],
  });
  if (result.canceled) return;
  try {
    const { ZoomPatch } = await import("./lib/ZoomPatch.js");
    const patch = ZoomPatch.fromPatchData(result.data);
    device.uploadPatchToCurrentPatch(patch);
    status(`Loaded ${result.filePath}`);
  } catch (e) {
    status("Could not load that file: " + e.message, true);
  }
}

async function backupAll() {
  if (!device) return;
  const dirResult = await window.fileAPI.openDirectory();
  if (dirResult.canceled) return;

  status("Backing up all patches…");
  try {
    await device.updatePatchListFromPedal();
    const patches = device.patchList;
    for (let i = 0; i < patches.length; i++) {
      status(`Backing up [${i + 1}/${patches.length}]…`);
      const patch = patches[i] ?? (await device.downloadPatchFromMemorySlot(i));
      if (!patch) continue;
      const data = patchToBytes(patch);
      if (!data) continue;
      const name = (patch.name || `patch_${i}`).trim().replace(/[^\w.-]+/g, "_");
      await window.fileAPI.writeFileInDir({
        dirPath: dirResult.dirPath,
        fileName: `${String(i).padStart(2, "0")}_${name}.zpatch`,
        data,
        binary: true,
      });
    }
    status(`Backed up ${patches.length} patches to ${dirResult.dirPath}`);
  } catch (e) {
    status("Backup failed: " + e.message, true);
  }
}

async function restoreToSlot() {
  if (!device || selectedMemorySlot === null) return;
  const result = await window.fileAPI.openFile({
    binary: true,
    filters: [{ name: "Zoom Patch", extensions: ["zpatch"] }],
  });
  if (result.canceled) return;

  status(`Restoring patch to slot ${String(selectedMemorySlot).padStart(2, "0")}…`);
  try {
    const { ZoomPatch } = await import("./lib/ZoomPatch.js");
    const patch = ZoomPatch.fromPatchData(result.data);
    if (!patch) {
      status("Could not parse patch file.", true);
      return;
    }
    const success = await device.uploadPatchToMemorySlot(patch, selectedMemorySlot);
    if (success) {
      device.uploadPatchToCurrentPatch(patch);
      const item = els.patchList.children[selectedMemorySlot];
      if (item) {
        const nameEl = item.querySelector(".p-name");
        if (nameEl) nameEl.textContent = patch.name || "(empty)";
      }
      status(`Restored patch to slot ${String(selectedMemorySlot).padStart(2, "0")}.`);
    } else {
      status(`Failed to restore patch to slot ${String(selectedMemorySlot).padStart(2, "0")}.`, true);
    }
  } catch (e) {
    status("Could not restore patch: " + e.message, true);
  }
}

// --- Wire up buttons ---------------------------------------------------

els.btnConnect.addEventListener("click", connect);
els.btnSync.addEventListener("click", syncToPedal);
els.btnRestore.addEventListener("click", restoreToSlot);
els.btnSave.addEventListener("click", savePatch);
els.btnLoad.addEventListener("click", loadPatch);
els.btnBackup.addEventListener("click", backupAll);

// Set up the chain as a drop zone for the effect library
setupChainDropZone();

els.patchName.addEventListener("change", () => {
  if (!device?.currentPatch) return;
  device.currentPatch.name = els.patchName.value;
  // Name edits are sent character-by-character on real hardware (see the
  // "Name edited" message in zoom-explorer's protocol notes) - not wired
  // up yet. For now this updates the local patch object; use Sync to
  // Pedal to push the whole patch, name included.
});
