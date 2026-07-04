/* app.js — DOM glue for the subtitle converter. Logic lives in subtitle-core.js. */
(function () {
  'use strict';
  var core = window.SubtitleCore;
  function $(id) { return document.getElementById(id); }

  var els = {
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    pasteInput: $('paste-input'),
    fileList: $('file-list'),
    outFormat: $('out-format'),
    shift: $('shift-input'),
    stripTags: $('opt-strip'),
    removeEmpty: $('opt-remove-empty'),
    output: $('output'),
    stats: $('stats'),
    copy: $('btn-copy'),
    download: $('btn-download'),
    downloadAll: $('btn-download-all'),
    clear: $('btn-clear'),
    sample: $('btn-sample')
  };

  var state = { files: [], selected: 0, results: [] };

  var FORMAT_LABEL = { srt: 'SRT', vtt: 'WebVTT', sbv: 'SBV', txt: 'Text' };

  function getOpts() {
    var shiftSec = parseFloat(els.shift.value);
    return {
      outputFormat: els.outFormat.value,
      shiftMs: isFinite(shiftSec) ? Math.round(shiftSec * 1000) : 0,
      stripTags: els.stripTags.checked,
      removeEmpty: els.removeEmpty.checked
    };
  }

  function outName(name, fmt) {
    var base = name.replace(/\.(srt|vtt|sbv|sub|txt)$/i, '');
    var candidate = base + '.' + core.EXT[fmt];
    if (candidate.toLowerCase() === name.toLowerCase()) {
      candidate = base + '-converted.' + core.EXT[fmt];
    }
    return candidate;
  }

  function activeInputs() {
    if (state.files.length) return state.files;
    var text = els.pasteInput.value;
    if (text.trim()) return [{ name: 'subtitles', text: text }];
    return [];
  }

  function run() {
    var opts = getOpts();
    var inputs = activeInputs();
    state.results = inputs.map(function (f) {
      try {
        var r = core.process(f.text, opts);
        r.name = outName(f.name, opts.outputFormat);
        return r;
      } catch (e) {
        return { error: e.message, name: f.name };
      }
    });
    if (state.selected >= state.results.length) state.selected = 0;
    render();
  }

  function render() {
    renderFileList();
    var r = state.results[state.selected];
    var hasOutput = r && !r.error;
    els.output.value = hasOutput ? r.output : '';
    els.copy.disabled = !hasOutput;
    els.download.disabled = !hasOutput;
    var okCount = state.results.filter(function (x) { return !x.error; }).length;
    els.downloadAll.hidden = !(state.files.length > 1 && okCount > 1);

    if (!state.results.length) {
      els.stats.textContent = 'Drop subtitle files or paste subtitle text to start.';
      els.stats.className = 'stats';
      return;
    }
    if (r.error) {
      els.stats.textContent = 'Error: ' + r.error;
      els.stats.className = 'stats stats-error';
      return;
    }
    var parts = ['Detected ' + FORMAT_LABEL[r.inputFormat] +
      ' → ' + FORMAT_LABEL[getOpts().outputFormat] +
      ' · ' + r.cueCount + ' cue' + (r.cueCount === 1 ? '' : 's')];
    if (r.skipped) parts.push(r.skipped + ' unreadable block' + (r.skipped === 1 ? '' : 's') + ' skipped');
    if (r.dropped) parts.push(r.dropped + ' cue' + (r.dropped === 1 ? '' : 's') + ' removed');
    els.stats.textContent = parts.join(' · ');
    els.stats.className = 'stats stats-ok';
  }

  function renderFileList() {
    els.fileList.innerHTML = '';
    if (!state.files.length) { els.fileList.hidden = true; return; }
    els.fileList.hidden = false;
    state.files.forEach(function (f, i) {
      var r = state.results[i];
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'file-chip' + (i === state.selected ? ' selected' : '') + (r && r.error ? ' has-error' : '');
      var status = r ? (r.error ? 'unreadable' : FORMAT_LABEL[r.inputFormat] + ' · ' + r.cueCount + ' cue' + (r.cueCount === 1 ? '' : 's')) : '';
      btn.innerHTML = '<span class="chip-name"></span><span class="chip-status"></span>';
      btn.querySelector('.chip-name').textContent = f.name;
      btn.querySelector('.chip-status').textContent = status;
      btn.addEventListener('click', function () { state.selected = i; render(); });
      li.appendChild(btn);
      els.fileList.appendChild(li);
    });
  }

  /* ---------- file loading ---------- */

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    Promise.all(files.map(function (f) {
      return f.text().then(function (t) { return { name: f.name, text: t }; });
    })).then(function (loaded) {
      state.files = state.files.concat(loaded);
      els.pasteInput.value = '';
      state.selected = state.files.length - loaded.length; // first newly added
      run();
    });
  }

  els.fileInput.addEventListener('change', function () {
    addFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    els.dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      els.dropzone.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    els.dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      els.dropzone.classList.remove('dragging');
    });
  });
  els.dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  els.dropzone.addEventListener('click', function (e) {
    if (e.target.closest('label')) return; // the label triggers the input itself
    els.fileInput.click();
  });
  els.dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
  });

  /* ---------- controls ---------- */

  ['input', 'change'].forEach(function (ev) {
    els.pasteInput.addEventListener(ev, function () {
      if (els.pasteInput.value.trim()) { state.files = []; }
      run();
    });
    els.outFormat.addEventListener(ev, run);
    els.shift.addEventListener(ev, run);
    els.stripTags.addEventListener(ev, run);
    els.removeEmpty.addEventListener(ev, run);
  });

  els.clear.addEventListener('click', function () {
    state.files = [];
    state.results = [];
    state.selected = 0;
    els.pasteInput.value = '';
    els.shift.value = '';
    render();
  });

  // Landing pages can preset a format-specific sample via window.PAGE_SAMPLE
  // (defined in an inline <script> before this file loads).
  var SAMPLE = window.PAGE_SAMPLE || '1\n00:00:01,600 --> 00:00:04,080\n<i>Welcome!</i> This is a sample subtitle.\n\n' +
    '2\n00:00:05,000 --> 00:00:07,250\nIt has two lines\nin a single cue.\n\n' +
    '3\n00:00:08,000 --> 00:00:10,500\nConvert, shift, or clean it.\n';
  els.sample.addEventListener('click', function () {
    state.files = [];
    els.pasteInput.value = SAMPLE;
    run();
  });

  /* ---------- copy / download ---------- */

  els.copy.addEventListener('click', function () {
    var text = els.output.value;
    function done() {
      var old = els.copy.textContent;
      els.copy.textContent = 'Copied ✓';
      setTimeout(function () { els.copy.textContent = old; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      els.output.select();
      document.execCommand('copy');
      done();
    }
  });

  function saveBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  els.download.addEventListener('click', function () {
    var r = state.results[state.selected];
    if (!r || r.error) return;
    saveBlob(new Blob([r.output], { type: 'text/plain;charset=utf-8' }), r.name);
  });

  els.downloadAll.addEventListener('click', function () {
    var enc = new TextEncoder();
    var entries = state.results
      .filter(function (r) { return !r.error; })
      .map(function (r) { return { name: r.name, data: enc.encode(r.output) }; });
    if (!entries.length) return;
    var zip = core.buildZip(entries);
    saveBlob(new Blob([zip], { type: 'application/zip' }), 'subtitles-converted.zip');
  });

  render();
})();
