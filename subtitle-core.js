/*!
 * subtitle-core.js — dependency-free subtitle parsing/conversion engine.
 * Formats: SRT, WebVTT, SBV (YouTube). Plus plain-text transcript export
 * and a minimal ZIP (store) writer for batch downloads.
 * Runs in the browser and in Node (UMD) so the exact same code is unit-tested.
 * (c) 2026 BitBleep Studio — MIT license.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SubtitleCore = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- timestamps ---------------- */

  // Accepts "HH:MM:SS,mmm", "HH:MM:SS.mmm", "MM:SS.mmm", "H:MM:SS.mm" etc.
  function parseTimestamp(str) {
    var m = String(str).trim().match(/^(?:(\d{1,4}):)?([0-5]?\d):([0-5]?\d)[.,](\d{1,3})$/);
    if (!m) return null;
    var h = parseInt(m[1] || '0', 10);
    var min = parseInt(m[2], 10);
    var s = parseInt(m[3], 10);
    var ms = parseInt((m[4] + '00').slice(0, 3), 10);
    return ((h * 60 + min) * 60 + s) * 1000 + ms;
  }

  function pad(n, w) {
    n = String(n);
    while (n.length < w) n = '0' + n;
    return n;
  }

  // sep: ',' for SRT, '.' for VTT/SBV. padHours: 2 for SRT/VTT, 1 for SBV.
  function formatTimestamp(ms, sep, padHours) {
    if (ms < 0) ms = 0;
    ms = Math.round(ms);
    var h = Math.floor(ms / 3600000);
    var min = Math.floor(ms / 60000) % 60;
    var s = Math.floor(ms / 1000) % 60;
    var frac = ms % 1000;
    return pad(h, padHours) + ':' + pad(min, 2) + ':' + pad(s, 2) + sep + pad(frac, 3);
  }

  /* ---------------- detection ---------------- */

  var SBV_LINE = /^\d{1,2}:\d{2}:\d{2}\.\d{3},\d{1,2}:\d{2}:\d{2}\.\d{3}\s*$/m;

  function normalize(text) {
    return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  function detectFormat(text) {
    var t = normalize(text).trim();
    if (!t) return null;
    if (/^WEBVTT([ \t\n]|$)/.test(t)) return 'vtt';
    if (t.indexOf('-->') !== -1) return 'srt'; // headerless cue lists parse fine via the SRT path
    if (SBV_LINE.test(t)) return 'sbv';
    return null;
  }

  /* ---------------- parsing ---------------- */
  // Cue: { start: ms, end: ms, text: string, settings: string }

  function parseCueTimingLine(line) {
    var parts = line.split('-->');
    if (parts.length !== 2) return null;
    var start = parseTimestamp(parts[0]);
    var rest = parts[1].trim();
    var sp = rest.search(/\s/);
    var endStr = sp === -1 ? rest : rest.slice(0, sp);
    var settings = sp === -1 ? '' : rest.slice(sp).trim();
    var end = parseTimestamp(endStr);
    if (start === null || end === null) return null;
    return { start: start, end: end, settings: settings };
  }

  // Handles SRT and (headerless) VTT-style cue blocks.
  function parseBlocks(text, opts) {
    opts = opts || {};
    var blocks = text.split(/\n{2,}/);
    var cues = [];
    var skipped = 0;
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i].trim();
      if (!block) continue;
      if (opts.vtt && /^(NOTE|STYLE|REGION)(\s|$)/.test(block)) continue;
      var lines = block.split('\n');
      var tIdx = -1;
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf('-->') !== -1) { tIdx = j; break; }
      }
      if (tIdx === -1) { skipped++; continue; }
      var timing = parseCueTimingLine(lines[tIdx]);
      if (!timing) { skipped++; continue; }
      cues.push({
        start: timing.start,
        end: timing.end,
        settings: timing.settings,
        text: lines.slice(tIdx + 1).join('\n')
      });
    }
    return { cues: cues, skipped: skipped };
  }

  function parseSRT(text) {
    return parseBlocks(text, { vtt: false });
  }

  function parseVTT(text) {
    // Drop the header section (everything up to the first blank line).
    var body = text;
    var headerEnd = text.indexOf('\n\n');
    if (/^WEBVTT/.test(text)) {
      body = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
    }
    return parseBlocks(body, { vtt: true });
  }

  function parseSBV(text) {
    var blocks = text.split(/\n{2,}/);
    var cues = [];
    var skipped = 0;
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i].trim();
      if (!block) continue;
      var lines = block.split('\n');
      var m = lines[0].trim().match(/^(\d{1,2}:\d{2}:\d{2}\.\d{3}),(\d{1,2}:\d{2}:\d{2}\.\d{3})$/);
      if (!m) { skipped++; continue; }
      var start = parseTimestamp(m[1]);
      var end = parseTimestamp(m[2]);
      if (start === null || end === null) { skipped++; continue; }
      cues.push({ start: start, end: end, settings: '', text: lines.slice(1).join('\n') });
    }
    return { cues: cues, skipped: skipped };
  }

  // -> { format, cues, skipped } ; throws Error on undetectable input
  function parse(rawText) {
    var text = normalize(rawText);
    var format = detectFormat(text);
    if (!format) throw new Error('Could not detect subtitle format (expected SRT, WebVTT or SBV).');
    var r = format === 'vtt' ? parseVTT(text) : format === 'sbv' ? parseSBV(text) : parseSRT(text);
    return { format: format, cues: r.cues, skipped: r.skipped };
  }

  /* ---------------- transforms ---------------- */

  function stripTags(s) {
    return s
      .replace(/<[^>\n]*>/g, '')      // <i>, <b>, <font ...>, <v Speaker>, <c.class>
      .replace(/\{\\[^}\n]*\}/g, '')  // ASS override tags like {\an8}
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^[ \t]+|[ \t]+$/gm, '');
  }

  // opts: { shiftMs: number, stripTags: bool, removeEmpty: bool }
  // Cues that end at/before 0 after a negative shift are dropped (counted in `dropped`).
  function transform(cues, opts) {
    opts = opts || {};
    var shift = opts.shiftMs || 0;
    var out = [];
    var dropped = 0;
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      var start = c.start + shift;
      var end = c.end + shift;
      if (end <= 0) { dropped++; continue; }
      if (start < 0) start = 0;
      var text = c.text;
      if (opts.stripTags) text = stripTags(text);
      if (opts.removeEmpty && text.trim() === '') { dropped++; continue; }
      out.push({ start: start, end: end, settings: c.settings, text: text });
    }
    return { cues: out, dropped: dropped };
  }

  /* ---------------- serialization ---------------- */

  function toSRT(cues) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      out.push((i + 1) + '\n' +
        formatTimestamp(c.start, ',', 2) + ' --> ' + formatTimestamp(c.end, ',', 2) + '\n' +
        c.text);
    }
    return out.join('\n\n') + (out.length ? '\n' : '');
  }

  function toVTT(cues) {
    var out = ['WEBVTT'];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      var line = formatTimestamp(c.start, '.', 2) + ' --> ' + formatTimestamp(c.end, '.', 2);
      if (c.settings) line += ' ' + c.settings;
      out.push(line + '\n' + c.text);
    }
    return out.join('\n\n') + '\n';
  }

  function toSBV(cues) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      out.push(formatTimestamp(c.start, '.', 1) + ',' + formatTimestamp(c.end, '.', 1) + '\n' + c.text);
    }
    return out.join('\n\n') + (out.length ? '\n' : '');
  }

  function toTXT(cues) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var t = stripTags(cues[i].text).trim();
      if (t) out.push(t);
    }
    return out.join('\n') + (out.length ? '\n' : '');
  }

  var EXT = { srt: 'srt', vtt: 'vtt', sbv: 'sbv', txt: 'txt' };

  function serialize(cues, format) {
    if (format === 'srt') return toSRT(cues);
    if (format === 'vtt') return toVTT(cues);
    if (format === 'sbv') return toSBV(cues);
    if (format === 'txt') return toTXT(cues);
    throw new Error('Unknown output format: ' + format);
  }

  // High-level one-shot: raw text in -> { output, inputFormat, cueCount, skipped, dropped }
  function process(rawText, opts) {
    opts = opts || {};
    var parsed = parse(rawText);
    var t = transform(parsed.cues, opts);
    return {
      output: serialize(t.cues, opts.outputFormat || 'vtt'),
      inputFormat: parsed.format,
      cueCount: t.cues.length,
      skipped: parsed.skipped,
      dropped: t.dropped
    };
  }

  /* ---------------- minimal ZIP writer (method 0 = store) ---------------- */

  var CRC_TABLE = (function () {
    var table = new Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function u16(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF); }
  function u32(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }

  // files: [{ name: string, data: Uint8Array }] -> Uint8Array (valid .zip, stored)
  function buildZip(files, date) {
    date = date || new Date();
    var dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    var dosDate = (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    var enc = new TextEncoder();
    var local = [];
    var central = [];
    var offset = 0;
    for (var i = 0; i < files.length; i++) {
      var name = enc.encode(files[i].name);
      var data = files[i].data;
      var crc = crc32(data);
      var lh = [];
      u32(lh, 0x04034B50); u16(lh, 20); u16(lh, 0x0800); u16(lh, 0);
      u16(lh, dosTime); u16(lh, dosDate);
      u32(lh, crc); u32(lh, data.length); u32(lh, data.length);
      u16(lh, name.length); u16(lh, 0);
      var lhBytes = new Uint8Array(lh.length + name.length + data.length);
      lhBytes.set(lh, 0); lhBytes.set(name, lh.length); lhBytes.set(data, lh.length + name.length);
      local.push(lhBytes);

      var ch = [];
      u32(ch, 0x02014B50); u16(ch, 20); u16(ch, 20); u16(ch, 0x0800); u16(ch, 0);
      u16(ch, dosTime); u16(ch, dosDate);
      u32(ch, crc); u32(ch, data.length); u32(ch, data.length);
      u16(ch, name.length); u16(ch, 0); u16(ch, 0); u16(ch, 0); u16(ch, 0);
      u32(ch, 0); u32(ch, offset);
      var chBytes = new Uint8Array(ch.length + name.length);
      chBytes.set(ch, 0); chBytes.set(name, ch.length);
      central.push(chBytes);

      offset += lhBytes.length;
    }
    var cdSize = 0;
    for (i = 0; i < central.length; i++) cdSize += central[i].length;
    var eocd = [];
    u32(eocd, 0x06054B50); u16(eocd, 0); u16(eocd, 0);
    u16(eocd, files.length); u16(eocd, files.length);
    u32(eocd, cdSize); u32(eocd, offset); u16(eocd, 0);

    var total = offset + cdSize + eocd.length;
    var zip = new Uint8Array(total);
    var pos = 0;
    for (i = 0; i < local.length; i++) { zip.set(local[i], pos); pos += local[i].length; }
    for (i = 0; i < central.length; i++) { zip.set(central[i], pos); pos += central[i].length; }
    zip.set(eocd, pos);
    return zip;
  }

  return {
    parseTimestamp: parseTimestamp,
    formatTimestamp: formatTimestamp,
    detectFormat: detectFormat,
    parse: parse,
    transform: transform,
    stripTags: stripTags,
    serialize: serialize,
    process: process,
    crc32: crc32,
    buildZip: buildZip,
    EXT: EXT
  };
}));
