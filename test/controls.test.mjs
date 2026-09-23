// Widget tests for renderer/ui/controls.js - the knobs, drop-downs and
// switches shared by the Zoom chain view and the Bass POD Pro fixed panel.
//
//   node --test test/
//
// controls.js is DOM code, so this file brings its own very small DOM: just
// the handful of things the widgets touch (createElement, classList, dataset,
// style.setProperty, addEventListener). No jsdom, no browser, no Electron -
// the repo has no test dependencies and this keeps it that way.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildActionUnit,
  buildKnobUnit,
  buildSelectUnit,
  buildToggleUnit,
  clamp,
  setKnobVisual,
} from "../renderer/ui/controls.js";

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { for (const n of names) this.names.add(n); }
  remove(...names) { for (const n of names) this.names.delete(n); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = { values: {}, setProperty(key, value) { this.values[key] = String(value); } };
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
  }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  // The widgets set classes both ways - className = "..." and classList.add()
  // - so the two have to stay in step, exactly as they do in a real DOM.
  get className() { return [...this.classList.names].join(" "); }
  set className(value) { this.classList.names = new Set(String(value).split(/\s+/).filter(Boolean)); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  /** Pretend the user did something to this element. */
  fire(type, event = {}) { this.listeners.get(type)?.({ target: this, ...event }); }
  // Only the one innerHTML shape the widgets use: a flat run of empty divs.
  set innerHTML(html) {
    this.children = [];
    for (const match of String(html).matchAll(/<div class="([^"]+)"><\/div>/g)) {
      const child = new FakeElement("div");
      child.classList.add(match[1]);
      this.appendChild(child);
    }
  }
  get innerHTML() { return this.children.map((c) => `<div class="${[...c.classList.names][0]}"></div>`).join(""); }
  querySelectorAll(selector) { return this._walk(selector); }
  querySelector(selector) { return this._walk(selector)[0]; }
  _walk(selector) {
    const className = selector.replace(/^\./, "");
    const found = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.classList.contains(className)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

const fakeWindow = {
  listeners: new Map(),
  addEventListener(type, listener) { this.listeners.set(type, listener); },
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); },
  fire(type, event) { this.listeners.get(type)?.(event); },
};

globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
globalThis.window = fakeWindow;

const AMP_MODELS = Array.from({ length: 16 }, (_, i) => ({ name: `Model ${i}`, modeled: `Amp ${i}` }));


test("knob: the shared arc maths put the middle of the range at 0 degrees", () => {
  const knob = new FakeElement("div");
  setKnobVisual(knob, 0, 126);
  assert.equal(knob.style.values["--pct"], "0.0");
  assert.equal(knob.style.values["--angle"], "-135.0deg");

  setKnobVisual(knob, 63, 126);
  assert.equal(knob.style.values["--pct"], "50.0");
  assert.equal(knob.style.values["--angle"], "0.0deg");

  setKnobVisual(knob, 126, 126);
  assert.equal(knob.style.values["--pct"], "100.0");
  assert.equal(knob.style.values["--angle"], "135.0deg");
});

test("knob: starts dimmed while the pedal's real value is unknown", () => {
  const knob = buildKnobUnit({ label: "Drive", min: 0, max: 126, value: 0, unset: true });
  assert.equal(knob.el.classList.contains("unset"), true, "shown as an unknown value");
  assert.equal(knob.el.querySelector(".knob-name").textContent, "Drive");
  assert.equal(knob.el.querySelector(".knob-value").textContent, "0");
  assert.equal(knob.el.querySelector(".knob").dataset.max, "126");
});

test("knob: dragging up sends increasing values and clamps at the top of the range", () => {
  const sent = [];
  const knob = buildKnobUnit({ label: "Drive", min: 0, max: 126, value: 0, unset: true, onChange: (v) => sent.push(v) });

  knob.knobEl.fire("pointerdown", { clientY: 100 });
  fakeWindow.fire("pointermove", { clientY: 25 }); // 75px of the 150px sweep = half of 126
  fakeWindow.fire("pointermove", { clientY: -1400 }); // far past the top
  fakeWindow.fire("pointerup", {});

  assert.deepEqual(sent, [63, 126]);
  assert.equal(knob.el.classList.contains("unset"), false, "once moved, the value is known");
  assert.equal(knob.el.querySelector(".knob-value").textContent, "126");
});

test("knob: setValue is display-only, setUnset puts it back to unknown", () => {
  const sent = [];
  const knob = buildKnobUnit({ label: "Bass", min: 0, max: 126, value: 0, unset: true, onChange: (v) => sent.push(v) });
  knob.setValue(40);
  assert.equal(knob.el.querySelector(".knob-value").textContent, "40");
  assert.equal(knob.el.classList.contains("unset"), false);
  assert.deepEqual(sent, [], "reporting the pedal's own value must not be echoed back to it");

  knob.setUnset();
  assert.equal(knob.el.classList.contains("unset"), true);
});

test("select: options are indexed by control value, and picking one sends that index", () => {
  const sent = [];
  const select = buildSelectUnit({ label: "Amp Model", options: AMP_MODELS, unset: true, onChange: (v) => sent.push(v) });

  assert.equal(select.selectEl.children.length, 17, "16 models plus the unknown placeholder");
  assert.equal(select.selectEl.value, "", "starts on the placeholder, not on model 0");
  assert.equal(select.selectEl.children[5].textContent, "Model 4 (Amp 4)");
  assert.equal(select.selectEl.children[5].value, "4", "the option's value is the CC value");

  select.selectEl.value = "";
  select.selectEl.fire("change");
  assert.deepEqual(sent, [], "the placeholder is not a value");

  select.selectEl.value = "5";
  select.selectEl.fire("change");
  assert.deepEqual(sent, [5]);
  assert.equal(select.el.classList.contains("unset"), false);

  select.setValue(11);
  assert.deepEqual(sent, [5], "setValue is display-only");
  assert.equal(select.getValue(), 11);
});

test("toggle: reports the on/off values the hardware expects", () => {
  const sent = [];
  const toggle = buildToggleUnit({ label: "Apply FX to D.I.", value: 0, offValue: 0, onValue: 127, unset: true, onChange: (v) => sent.push(v) });
  assert.equal(toggle.inputEl.checked, false);
  assert.equal(toggle.el.classList.contains("unset"), true);

  toggle.inputEl.checked = true;
  toggle.inputEl.fire("change");
  assert.deepEqual(sent, [127]);
  assert.equal(toggle.el.classList.contains("unset"), false);

  toggle.setValue(0);
  assert.equal(toggle.inputEl.checked, false);
  assert.equal(toggle.getValue(), 0);
});

test("action: a button (Manual, Tuner) fires its handler", () => {
  let clicks = 0;
  const action = buildActionUnit({ label: "Tuner", hint: "PC 37", onClick: () => { clicks++; } });
  assert.equal(action.buttonEl.textContent, "Tuner");
  assert.equal(action.el.querySelector(".control-hint").textContent, "PC 37");
  action.buttonEl.fire("click");
  assert.equal(clicks, 1);
});

test("clamp keeps values inside the control's documented range", () => {
  assert.equal(clamp(200, 0, 126), 126);
  assert.equal(clamp(-5, 0, 126), 0);
  assert.equal(clamp(64, 0, 126), 64);
});
