import { BASELINE, FORMS, GROUPS, MAX_POINTS, PAPER_HEIGHT, PEN_WIDTH, drawingKey, formsFor } from "./glyphs.js";
import { makeFont } from "./font.js";

const $ = id => document.getElementById(id);
const storageKey = "dastkhat.v1";
const numerals = new Intl.NumberFormat("fa-IR", { useGrouping: false });
const groupOrder = Object.keys(GROUPS);
const allCharacters = Object.values(GROUPS).flat();
const icons = "http://www.w3.org/2000/svg";
const drawing = $("drawing");
const context = drawing.getContext("2d");
const formList = $("forms");
const glyphList = $("glyphs");
const sample = $("sample");
const missingDialog = $("missing-dialog");
const undoHistory = new Map();

const settings = readProject();
const drawings = settings.drawings ?? {};
let character = allCharacters.includes(settings.character) ? settings.character : "ب";
let group = groupOrder.find(key => GROUPS[key].includes(character));
let form = formsFor(character).includes(settings.form) ? settings.form : "isol";
let showGuide = settings.showGuide !== false;
let pointer;
let draft = [];
let previewTimer;
let previewRevision = 0;
let loadedFont;
let toastTimer;
let pendingWarning;

function readProject() {
  try {
    const result = JSON.parse(localStorage.getItem(storageKey));
    if (result && typeof result === "object") return result;
  } catch {
    // A fresh project remains available when local storage is inaccessible.
  }
  return {};
}

function saveProject() {
  const state = $("save-status");
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      drawings, character, form, showGuide, sample: sample.value,
      size: $("preview-size").value, name: $("font-name").value
    }));
    state.classList.remove("failed");
    state.lastChild.textContent = "ذخیره در این دستگاه";
  } catch {
    state.classList.add("failed");
    state.lastChild.textContent = "ذخیره در مرورگر در دسترس نیست";
  }
}

function icon(name) {
  const svg = document.createElementNS(icons, "svg");
  const use = document.createElementNS(icons, "use");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", "#icon-" + name);
  svg.append(use);
  return svg;
}

function hasDrawing(letter, shape) {
  return Boolean(drawings[drawingKey(letter, shape)]?.length);
}

function missingForms(letter) {
  return formsFor(letter).filter(shape => !hasDrawing(letter, shape));
}

function renderLibrary() {
  for (const tab of document.querySelectorAll("[data-group]")) {
    const selected = tab.dataset.group === group;
    tab.setAttribute("aria-selected", selected);
    tab.tabIndex = selected ? 0 : -1;
  }
  glyphList.setAttribute("aria-labelledby", group + "-tab");
  const focusedLetter = glyphList.contains(document.activeElement) && document.activeElement.dataset.glyph;
  const list = GROUPS[group];
  glyphList.replaceChildren(...list.map(letter => {
    const button = document.createElement("button");
    const forms = formsFor(letter);
    const filled = forms.filter(shape => hasDrawing(letter, shape)).length;
    const complete = filled === forms.length;
    button.type = "button";
    button.className = "glyph";
    button.dataset.glyph = letter;
    button.textContent = letter;
    button.setAttribute("aria-current", letter === character);
    const status = complete ? "، کامل" : filled ? "، در حال تکمیل" : "";
    button.setAttribute("aria-label", letter + status);
    if (complete) {
      const check = document.createElement("span");
      check.className = "completion";
      check.append(icon("check"));
      button.append(check);
    } else if (filled) {
      const dot = document.createElement("span");
      dot.className = "started";
      button.append(dot);
    }
    return button;
  }));
  if (focusedLetter) {
    [...glyphList.children].find(button => button.dataset.glyph === focusedLetter)?.focus({ preventScroll: true });
  }
  const done = list.filter(letter => formsFor(letter).some(shape => hasDrawing(letter, shape))).length;
  $("progress").max = list.length;
  $("progress").value = done;
  $("progress-label").textContent = numerals.format(done) + " از " + numerals.format(list.length);
}

function ghostLetter() {
  const joiner = "\u200d";
  return (form === "fina" || form === "medi" ? joiner : "") + character +
    (form === "init" || form === "medi" ? joiner : "");
}

function renderEditor() {
  const index = allCharacters.indexOf(character);
  $("editor-heading").textContent = "«" + character + "» را بنویس";
  drawing.setAttribute("aria-label", "کادر نوشتن " + character + "، شکل " + FORMS[form]);
  $("glyph-badge").textContent = ghostLetter();
  $("previous").disabled = index === 0;
  $("next-label").textContent = index + 1 < allCharacters.length
    ? "بعدی: " + allCharacters[index + 1]
    : "خروجی فونت";
  $("guide").setAttribute("aria-pressed", showGuide);
  $("drawing-instruction").textContent = form === "isol"
    ? "با ماوس، انگشت یا قلم روی کادر بنویس."
    : "محل اتصال حرف را روی خط کرسی بکش.";
  const focusedForm = formList.contains(document.activeElement) && document.activeElement.dataset.form;
  formList.replaceChildren(...formsFor(character).map(shape => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.form = shape;
    button.textContent = FORMS[shape];
    button.setAttribute("aria-pressed", shape === form);
    if (hasDrawing(character, shape)) {
      const check = icon("check");
      check.classList.add("form-done");
      button.append(check);
    }
    return button;
  }));
  if (focusedForm) {
    [...formList.children].find(button => button.dataset.form === focusedForm)?.focus({ preventScroll: true });
  }
  const key = drawingKey(character, form);
  $("clear").disabled = !drawings[key]?.length;
  $("undo").disabled = !undoHistory.get(key)?.length && !drawings[key]?.length;
  paint();
}

function select(letter, shape = "isol") {
  if (pointer !== undefined || !allCharacters.includes(letter)) return;
  character = letter;
  group = groupOrder.find(category => GROUPS[category].includes(letter));
  form = shape;
  renderLibrary();
  renderEditor();
  saveProject();
}

function navigate(offset) {
  const index = allCharacters.indexOf(character) + offset;
  if (allCharacters[index]) select(allCharacters[index]);
}

function showMissingWarning({ heading, note, details, target, continueLabel, onContinue }) {
  $("missing-heading").textContent = heading;
  $("missing-note").textContent = note;
  $("missing-items").replaceChildren(...details.map(detail => {
    const item = document.createElement("li");
    item.textContent = detail;
    return item;
  }));
  $("continue-missing").hidden = !onContinue;
  $("continue-missing").textContent = continueLabel ?? "";
  pendingWarning = { target, onContinue };
  missingDialog.returnValue = "";
  missingDialog.showModal();
}

missingDialog.addEventListener("close", () => {
  const { target, onContinue } = pendingWarning;
  pendingWarning = undefined;
  if (missingDialog.returnValue === "review") select(...target);
  else if (missingDialog.returnValue === "continue") onContinue?.();
});

function advance() {
  if (pointer !== undefined) return;
  if (allCharacters.at(-1) === character) {
    requestExport();
    return;
  }
  const missing = missingForms(character);
  if (!missing.length) {
    navigate(1);
    return;
  }
  showMissingWarning({
    heading: "نویسه هنوز کامل نشده",
    note: "شکل‌های باقی‌مانده برای «" + character + "»",
    details: missing.map(shape => FORMS[shape]),
    target: [character, missing[0]],
    continueLabel: "رفتن به نویسهٔ بعدی",
    onContinue: () => navigate(1)
  });
}

function dimensions() {
  const width = drawing.clientWidth;
  const height = drawing.clientHeight;
  return {
    width, height,
    x: width / 2,
    scale: Math.min(width / 380, height / PAPER_HEIGHT),
    baseline: height * BASELINE / PAPER_HEIGHT
  };
}

function paint() {
  const { width, height, x, baseline, scale } = dimensions();
  if (!width || !height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const pixelsWide = Math.round(width * ratio);
  const pixelsHigh = Math.round(height * ratio);
  if (drawing.width !== pixelsWide || drawing.height !== pixelsHigh) {
    drawing.width = pixelsWide;
    drawing.height = pixelsHigh;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.translate(x, baseline - BASELINE * scale);
  context.scale(scale, scale);
  if (showGuide) drawGhost();
  context.strokeStyle = "#40266f";
  context.fillStyle = context.strokeStyle;
  context.lineWidth = PEN_WIDTH;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of [...(drawings[drawingKey(character, form)] ?? []), draft]) {
    if (!stroke.length) continue;
    context.beginPath();
    if (stroke.length === 1) {
      context.arc(stroke[0][0], stroke[0][1], PEN_WIDTH / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.moveTo(...stroke[0]);
    for (const point of stroke.slice(1)) context.lineTo(...point);
    context.stroke();
  }
}

function drawGhost() {
  context.fillStyle = "#d8c7ef";
  context.strokeStyle = context.fillStyle;
  if (character === "ب" && form === "isol") {
    context.lineWidth = 9;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(95, 110);
    context.bezierCurveTo(116, 147, 64, 153, 23, 155);
    context.bezierCurveTo(-41, 158, -110, 156, -105, 122);
    context.stroke();
    context.beginPath();
    context.ellipse(-9, 183, 7, 6, -.46, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.font = "160px Vazirmatn, sans-serif";
  context.direction = "rtl";
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillText(ghostLetter(), 0, BASELINE, 259);
}

function pointFrom(event) {
  const rect = drawing.getBoundingClientRect();
  const { width, height, baseline, scale } = dimensions();
  const x = Math.max(0, Math.min(width, event.clientX - rect.left));
  const y = Math.max(0, Math.min(height, event.clientY - rect.top));
  return [
    Math.round((x - width / 2) / scale * 10) / 10,
    Math.round((BASELINE + (y - baseline) / scale) * 10) / 10
  ];
}

function commit(strokes) {
  const key = drawingKey(character, form);
  const stack = undoHistory.get(key) ?? [];
  stack.push(drawings[key] ?? []);
  if (stack.length > 20) stack.shift();
  undoHistory.set(key, stack);
  writeDrawing(key, strokes);
}

function writeDrawing(key, strokes) {
  if (strokes.length) drawings[key] = strokes;
  else delete drawings[key];
  saveProject();
  renderLibrary();
  renderEditor();
  schedulePreview();
}

function undo() {
  if (pointer !== undefined) return;
  const key = drawingKey(character, form);
  const stack = undoHistory.get(key);
  if (stack?.length) writeDrawing(key, stack.pop());
  else if (drawings[key]?.length) writeDrawing(key, drawings[key].slice(0, -1));
}

drawing.addEventListener("pointerdown", event => {
  if (pointer !== undefined || event.button !== 0) return;
  const strokes = drawings[drawingKey(character, form)] ?? [];
  if (strokes.reduce((sum, stroke) => sum + stroke.length, 0) >= MAX_POINTS) {
    notify("ظرفیت این طرح پر شده است. برای ادامه بخشی از طرح را واگرد کن.");
    return;
  }
  pointer = event.pointerId;
  draft = [pointFrom(event)];
  drawing.setPointerCapture(pointer);
  paint();
});

function addPoints(event) {
  const strokes = drawings[drawingKey(character, form)] ?? [];
  const space = MAX_POINTS - strokes.reduce((sum, stroke) => sum + stroke.length, 0);
  const events = event.getCoalescedEvents?.();
  for (const input of events?.length ? events : [event]) {
    if (draft.length >= space) break;
    const point = pointFrom(input);
    const last = draft.at(-1);
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= 1.8) draft.push(point);
  }
}

drawing.addEventListener("pointermove", event => {
  if (event.pointerId !== pointer) return;
  addPoints(event);
  paint();
});
drawing.addEventListener("pointerup", event => {
  if (event.pointerId !== pointer) return;
  addPoints(event);
  const stroke = draft;
  draft = [];
  pointer = undefined;
  const key = drawingKey(character, form);
  commit([...(drawings[key] ?? []), stroke]);
});
function cancelStroke(event) {
  if (event.pointerId !== pointer) return;
  pointer = undefined;
  draft = [];
  paint();
}
drawing.addEventListener("pointercancel", cancelStroke);
drawing.addEventListener("lostpointercapture", cancelStroke);

function setPreviewSize() {
  const size = $("preview-size").value;
  $("size-label").textContent = numerals.format(size);
  sample.style.setProperty("--preview-size", size + "px");
}

function schedulePreview() {
  const revision = ++previewRevision;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (Object.keys(drawings).length === 0) {
      sample.style.removeProperty("--preview-font");
      if (loadedFont) document.fonts.delete(loadedFont);
      loadedFont = undefined;
      return;
    }
    const family = "DastkhatPreview" + revision;
    try {
      const font = await new FontFace(family, makeFont(drawings, "Dastkhat Preview")).load();
      if (revision !== previewRevision) return;
      document.fonts.add(font);
      sample.style.setProperty("--preview-font", '"' + family + '", var(--ui)');
      if (loadedFont) document.fonts.delete(loadedFont);
      loadedFont = font;
    } catch (error) {
      console.error("Could not load handwriting preview", error);
      notify("پیش‌نمایش فونت بارگذاری نشد.");
    }
  }, 90);
}

function notify(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
}

function requestExport() {
  if (pointer !== undefined) return;
  const incomplete = groupOrder.map(category => ({
    category,
    letters: GROUPS[category].filter(letter => missingForms(letter).length > 0)
  })).filter(({ letters }) => letters.length > 0);
  if (!incomplete.length) {
    openExport();
    return;
  }
  const firstLetter = incomplete[0].letters[0];
  const canExport = Object.keys(drawings).length > 0;
  showMissingWarning({
    heading: "همهٔ نویسه‌ها کامل نشده‌اند",
    note: canExport
      ? "اگر ادامه بدهی، فونت با شکل‌هایی که تا حالا نوشته‌ای ساخته می‌شود."
      : "برای ساخت فونت، دست‌کم یک شکل را بنویس.",
    details: incomplete.map(({ category, letters }) =>
      $(category + "-tab").textContent + " · " + numerals.format(letters.length) + " نویسهٔ ناقص"),
    target: [firstLetter, missingForms(firstLetter)[0]],
    continueLabel: "ادامه به خروجی",
    onContinue: canExport ? openExport : undefined
  });
}

function openExport() {
  const candidates = allCharacters.filter(letter => formsFor(letter).some(shape => hasDrawing(letter, shape)));
  $("download").disabled = candidates.length === 0;
  const count = numerals.format(candidates.length);
  const total = numerals.format(allCharacters.length);
  $("export-coverage").textContent = candidates.length
    ? count + " نویسه از " + total + " در فونت قرار می‌گیرد."
    : "برای دانلود فونت، دست‌کم یک نویسه را در کادر بنویس.";
  $("export-dialog").showModal();
}

$("export-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!Object.keys(drawings).length) return;
  const value = $("font-name").value.trim();
  const name = value || "دستخط من";
  try {
    const font = makeFont(drawings, name);
    const url = URL.createObjectURL(new Blob([font], { type: "font/ttf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-") + ".ttf";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    saveProject();
    $("export-dialog").close();
    notify("فایل فونت برای دانلود آماده شد.");
  } catch (error) {
    console.error("Could not export handwriting", error);
    notify("ساخت فایل فونت با خطا روبه‌رو شد.");
  }
});

const libraryTabs = document.querySelector(".library-tabs");
libraryTabs.addEventListener("click", event => {
  const tab = event.target.closest("[data-group]");
  if (tab && tab.dataset.group !== group) select(GROUPS[tab.dataset.group][0]);
});
libraryTabs.addEventListener("keydown", event => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  event.stopPropagation();
  const delta = event.key === "ArrowLeft" ? 1 : -1;
  const next = groupOrder[(groupOrder.indexOf(group) + delta + groupOrder.length) % groupOrder.length];
  select(GROUPS[next][0]);
  $(next + "-tab").focus();
});
glyphList.addEventListener("click", event => {
  const button = event.target.closest("[data-glyph]");
  if (button) select(button.dataset.glyph);
});
formList.addEventListener("click", event => {
  const button = event.target.closest("[data-form]");
  if (button) select(character, button.dataset.form);
});

$("guide").addEventListener("click", () => {
  showGuide = !showGuide;
  $("guide").setAttribute("aria-pressed", showGuide);
  saveProject();
  paint();
});
$("undo").addEventListener("click", undo);
$("clear").addEventListener("click", () => { if (pointer === undefined) commit([]); });
$("previous").addEventListener("click", () => navigate(-1));
$("next").addEventListener("click", advance);
$("export").addEventListener("click", requestExport);
$("help").addEventListener("click", () => $("help-dialog").showModal());
for (const close of document.querySelectorAll("[data-close]")) {
  close.addEventListener("click", () => close.closest("dialog").close());
}
$("preview-size").addEventListener("input", () => {
  setPreviewSize();
  saveProject();
});
sample.addEventListener("input", saveProject);

document.addEventListener("keydown", event => {
  if (event.target.closest("input, textarea, dialog, [contenteditable]")) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
    event.preventDefault();
    undo();
  } else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "ArrowLeft") { event.preventDefault(); advance(); }
    if (event.key === "ArrowRight") { event.preventDefault(); navigate(-1); }
  }
});

if (typeof settings.sample === "string") sample.value = settings.sample;
if (settings.size) $("preview-size").value = settings.size;
if (settings.name) $("font-name").value = settings.name;
setPreviewSize();
renderLibrary();
renderEditor();
schedulePreview();
saveProject();
new ResizeObserver(paint).observe(drawing);
document.fonts.ready.then(paint);
