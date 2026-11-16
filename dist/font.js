import { BASELINE, GROUPS, PEN_WIDTH, drawingKey, formsFor, joins } from "./glyphs.js";

const UNITS = 1000;
const DRAWING_SCALE = 4.3;
const CHECKSUM = 0xb1b0afba;

class Writer {
  bytes = [];

  u8(value) { this.bytes.push(value & 255); return this; }
  u16(value) { return this.u8(value >>> 8).u8(value); }
  u32(value) { return this.u16(value >>> 16).u16(value); }
  tag(value) {
    for (const character of value) this.u8(character.charCodeAt(0));
    return this;
  }
  append(bytes) {
    for (const byte of bytes) this.bytes.push(byte);
    return this;
  }
  finish() { return Uint8Array.from(this.bytes); }
  get length() { return this.bytes.length; }
}

function range(points, axis) {
  return points.reduce(([min, max], point) => [
    Math.min(min, point[axis]), Math.max(max, point[axis])
  ], [Infinity, -Infinity]);
}

function bounds(contours) {
  const points = contours.flat();
  if (!points.length) return [0, 0, 0, 0];

  const [left, right] = range(points, 0);
  const [bottom, top] = range(points, 1);
  return [left, bottom, right, top];
}

function writeBounds(writer, box) {
  for (const coordinate of box) writer.u16(coordinate);
}

function makeOutline(strokes, radius) {
  const contours = [];
  for (const stroke of strokes) {
    let previous;
    for (const [x, y] of stroke) {
      const point = [x * DRAWING_SCALE, (BASELINE - y) * DRAWING_SCALE];
      if (previous) {
        const dx = point[0] - previous[0];
        const dy = point[1] - previous[1];
        const length = Math.hypot(dx, dy);
        if (length < 1) continue;
        const nx = -dy * radius / length;
        const ny = dx * radius / length;
        contours.push([
          [previous[0] + nx, previous[1] + ny],
          [point[0] + nx, point[1] + ny],
          [point[0] - nx, point[1] - ny],
          [previous[0] - nx, previous[1] - ny]
        ]);
      }
      contours.push(Array.from({ length: 12 }, (_, index) => {
        const angle = -index * Math.PI / 6;
        return [point[0] + radius * Math.cos(angle), point[1] + radius * Math.sin(angle)];
      }));
      previous = point;
    }
  }
  return contours;
}

function makeGlyph(strokes, form) {
  const { left, right } = joins(form);
  const contours = makeOutline(strokes, PEN_WIDTH / 2 * DRAWING_SCALE);
  const [minX] = bounds(contours);
  const side = left ? -8 : 48;
  const shifted = contours.map(contour => contour.map(([x, y]) => [
    Math.round(x - minX + side), Math.round(y)
  ]));
  const box = bounds(shifted);
  return { contours: shifted, box, advance: Math.max(60, box[2] + (right ? -8 : 48)) };
}

function writeGlyph(glyph) {
  const writer = new Writer();
  if (!glyph.contours.length) return writer;

  writer.u16(glyph.contours.length);
  writeBounds(writer, glyph.box);
  let endPoint = -1;
  for (const contour of glyph.contours) {
    endPoint += contour.length;
    writer.u16(endPoint);
  }
  writer.u16(0);
  // On-curve point flags. OVERLAP_SIMPLE enables union of stroke contours.
  for (let index = 0; index <= endPoint; index++) writer.u8(index === 0 ? 0x41 : 1);
  const points = glyph.contours.flat();
  for (const axis of [0, 1]) {
    let last = 0;
    for (const point of points) {
      writer.u16(point[axis] - last);
      last = point[axis];
    }
  }
  return writer;
}

function makeCmap(characters) {
  const mapping = [...characters].sort(([left], [right]) => left - right);
  mapping.push([0xffff, 0]);
  const segments = mapping.length;
  const power = 2 ** Math.floor(Math.log2(segments));
  const table = new Writer().u16(0).u16(2)
    .u16(0).u16(3).u32(20)
    .u16(3).u16(1).u32(20);
  table.u16(4).u16(16 + segments * 8).u16(0)
    .u16(segments * 2).u16(power * 2).u16(Math.log2(power)).u16(segments * 2 - power * 2);
  for (const [code] of mapping) table.u16(code);
  table.u16(0);
  for (const [code] of mapping) table.u16(code);
  for (const [code, id] of mapping) table.u16(id - code);
  for (const _ of mapping) table.u16(0);
  return table;
}

function makeNames(name) {
  const safeAsciiName = name.normalize("NFKD").replace(/[^a-z0-9]+/gi, "").slice(0, 40);
  const postScriptName = (safeAsciiName || "Dastkhat") + "-Regular";
  const strings = [
    [1, name], [2, "Regular"], [3, postScriptName + ";1.0"],
    [4, name], [5, "Version 1.0"], [6, postScriptName]
  ];
  const storage = new Writer();
  const header = new Writer().u16(0).u16(strings.length).u16(6 + 12 * strings.length);
  for (const [id, value] of strings) {
    header.u16(3).u16(1).u16(0x409).u16(id).u16(value.length * 2).u16(storage.length);
    for (let index = 0; index < value.length; index++) storage.u16(value.charCodeAt(index));
  }
  return header.append(storage.bytes);
}

function offsets(chunks, prefixLength) {
  const index = new Writer();
  let offset = prefixLength;
  for (const chunk of chunks) {
    index.u16(offset);
    offset += chunk.length;
  }
  return index;
}

function makeGSUB(substitutions) {
  const features = Object.keys(substitutions).sort().filter(key => substitutions[key].length);
  if (!features.length) return undefined;

  const lookups = features.map(feature => {
    const pairs = substitutions[feature].sort(([left], [right]) => left - right);
    const table = new Writer().u16(1).u16(0).u16(1).u16(8);
    table.u16(2).u16(6 + pairs.length * 2).u16(pairs.length);
    for (const [, replacement] of pairs) table.u16(replacement);
    table.u16(1).u16(pairs.length);
    for (const [base] of pairs) table.u16(base);
    return table;
  });

  const arabic = new Writer().u16(4).u16(0)
    .u16(0).u16(0xffff).u16(features.length);
  features.forEach((_, index) => arabic.u16(index));
  const scripts = new Writer().u16(1).tag("arab").u16(8).append(arabic.bytes);

  const featureList = new Writer().u16(features.length);
  features.forEach((tag, index) => featureList.tag(tag).u16(2 + features.length * 6 + index * 6));
  features.forEach((_, index) => featureList.u16(0).u16(1).u16(index));

  const lookupList = new Writer().u16(lookups.length).append(offsets(lookups, 2 + lookups.length * 2).bytes);
  for (const lookup of lookups) lookupList.append(lookup.bytes);
  return new Writer().u32(0x00010000)
    .u16(10).u16(10 + scripts.length).u16(10 + scripts.length + featureList.length)
    .append(scripts.bytes).append(featureList.bytes).append(lookupList.bytes);
}

function makeOS2(characters, ascent, descent, average) {
  const codes = [...characters.keys()];
  const writer = new Writer().u16(4).u16(average)
    .u16(400).u16(5).u16(0)
    .u16(650).u16(600).u16(0).u16(75)
    .u16(650).u16(600).u16(0).u16(320)
    .u16(49).u16(258).u16(0);
  writer.append(new Uint8Array(10)).u32(1 | (1 << 13)).u32(0).u32(0).u32(0);
  return writer.tag("DSTK").u16(0x40)
    .u16(Math.min(...codes)).u16(Math.max(...codes))
    .u16(ascent).u16(descent).u16(0).u16(ascent).u16(-descent)
    .u32(1 << 6).u32(0)
    .u16(440).u16(650).u16(0).u16(32).u16(1);
}

function sumWords(bytes) {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    sum = (sum + (
      ((bytes[index] ?? 0) << 24) |
      ((bytes[index + 1] ?? 0) << 16) |
      ((bytes[index + 2] ?? 0) << 8) |
      (bytes[index + 3] ?? 0)
    )) >>> 0;
  }
  return sum;
}

function assemble(tables) {
  const names = Object.keys(tables).sort();
  const count = names.length;
  const power = 2 ** Math.floor(Math.log2(count));
  const header = new Writer().u32(0x00010000).u16(count)
    .u16(power * 16).u16(Math.log2(power)).u16((count - power) * 16);
  const data = new Writer();
  const firstOffset = 12 + count * 16;
  let adjustmentOffset;
  for (const name of names) {
    const bytes = tables[name].finish();
    const offset = firstOffset + data.length;
    if (name === "head") adjustmentOffset = offset + 8;
    header.tag(name).u32(sumWords(bytes)).u32(offset).u32(bytes.length);
    data.append(bytes);
    while (data.length % 4 !== 0) data.u8(0);
  }
  const result = header.append(data.bytes).finish();
  new DataView(result.buffer).setUint32(adjustmentOffset, (CHECKSUM - sumWords(result)) >>> 0);
  return result.buffer;
}

const blankGlyph = advance => ({ contours: [], box: [0, 0, 0, 0], advance });
const missingGlyph = {
  contours: [
    [[64, 0], [64, 650], [444, 650], [444, 0]],
    [[112, 48], [396, 48], [396, 602], [112, 602]]
  ],
  box: [64, 0, 444, 650],
  advance: 508
};

export function makeFont(drawings, name) {
  const glyphs = [missingGlyph, blankGlyph(230)];
  const characters = new Map([[32, 1], [0xa0, 1]]);
  const substitutions = { fina: [], init: [], medi: [] };
  for (const character of Object.values(GROUPS).flat()) {
    const ids = {};
    for (const form of formsFor(character)) {
      const strokes = drawings[drawingKey(character, form)];
      if (!strokes?.length) continue;
      ids[form] = glyphs.length;
      glyphs.push(makeGlyph(strokes, form));
    }
    const base = ids.isol ?? Object.values(ids)[0];
    if (base === undefined) continue;
    characters.set(character.codePointAt(0), base);
    if (character === "ک") characters.set(0x643, base);
    if (character === "ی") characters.set(0x64a, base);
    for (const form of Object.keys(substitutions)) {
      if (ids[form] !== undefined && ids[form] !== base) substitutions[form].push([base, ids[form]]);
    }
  }

  const box = bounds(glyphs.map(glyph => [[glyph.box[0], glyph.box[1]], [glyph.box[2], glyph.box[3]]]));
  const ascent = Math.max(820, box[3]);
  const descent = Math.min(-270, box[1]);
  const average = Math.round(glyphs.reduce((sum, glyph) => sum + glyph.advance, 0) / glyphs.length);
  const maxAdvance = Math.max(...glyphs.map(glyph => glyph.advance));
  const minRight = Math.min(...glyphs.map(glyph => glyph.advance - glyph.box[2]));
  const glyf = new Writer();
  const loca = new Writer();
  const hmtx = new Writer();
  let maxPoints = 0;
  let maxContours = 0;
  for (const glyph of glyphs) {
    loca.u32(glyf.length);
    glyf.append(writeGlyph(glyph).bytes);
    if (glyf.length % 2) glyf.u8(0);
    hmtx.u16(glyph.advance).u16(glyph.box[0]);
    maxPoints = Math.max(maxPoints, glyph.contours.reduce((sum, contour) => sum + contour.length, 0));
    maxContours = Math.max(maxContours, glyph.contours.length);
  }
  loca.u32(glyf.length);

  const head = new Writer().u32(0x00010000).u32(0x00010000).u32(0)
    .u32(0x5f0f3cf5).u16(3).u16(UNITS)
    .u32(0).u32(3786912000).u32(0).u32(3786912000);
  writeBounds(head, box);
  head.u16(0).u16(8).u16(2).u16(1).u16(0);
  const hhea = new Writer().u32(0x00010000)
    .u16(ascent).u16(descent).u16(0).u16(maxAdvance).u16(box[0]).u16(minRight)
    .u16(box[2]).u16(1).u16(0).u16(0).append(new Uint8Array(10)).u16(glyphs.length);
  const maxp = new Writer().u32(0x00010000).u16(glyphs.length).u16(maxPoints).u16(maxContours)
    .u16(0).u16(0).u16(1).append(new Uint8Array(16));
  const post = new Writer().u32(0x00030000).u32(0).u16(-75).u16(45).append(new Uint8Array(20));
  const tables = {
    "OS/2": makeOS2(characters, ascent, descent, average),
    cmap: makeCmap(characters), glyf, head, hhea, hmtx, loca, maxp,
    name: makeNames(name), post
  };
  const gsub = makeGSUB(substitutions);
  if (gsub) tables.GSUB = gsub;
  return assemble(tables);
}
