/*
 * relay-config.js - kintone プラグイン設定画面(config.js)が使う「基本の部品」。
 * プラグイン作成 mod の一部(MIT License)。kin-scaffold がプラグインにそのまま写し、
 * manifest の config.js より先に読み込む。見た目は同梱の 51-modern-default.css
 * (kintoneplugin-* クラス)だけ。独自の色・影・角丸は足さない。
 *
 * 決まり:
 *  - kintone の内部 DOM に触らない。触るのは自分で作った要素と document.getElementById だけ。
 *  - 利用者のデータは textContent / value で入れる(innerHTML に値を入れない)。console.log しない。
 *  - 依存なし。グローバルは window.RelayConfig だけ。
 *
 * 使い方:
 *   const ctl = RelayConfig.mount(document.getElementById('settings'), {
 *     pluginId: kintone.$PLUGIN_ID,
 *     items: [ { type: 'field', key: 'fieldCode', label: '対象フィールド', required: true } ],
 *     errorEl: document.getElementById('error'),
 *   });
 *   document.getElementById('save').onclick = () => ctl.save();     // 検証 → setConfig
 *   document.getElementById('cancel').onclick = () => ctl.cancel(); // プラグイン一覧へ
 *
 * 項目 type(共通: key / label / desc / required):
 *   field   fieldSelect  1 欄をドロップダウン。types:['NUMBER','CALC'] で型を絞る。subtable(既定 true)。
 *   fields  fieldChecks  複数欄をチェックボックス。min。値は JSON 配列文字列。default:[...]
 *   view    viewSelect   一覧(ビュー)をドロップダウン。先頭に「すべての一覧」('__all__')。値はビュー ID。
 *   views   viewChecks   一覧をチェックボックス。min。default:['__all__']
 *   app     appSelect    アプリを「名前(ID)」で。値はアプリ ID。
 *   options optionChecks 選択肢の欄の選択肢をチェックボックス。of:'別の field 項目の key' か field:'code'。
 *   number  numberInput  min / max / step / default / required
 *   text    textInput    required / default / maxLength / placeholder
 *   rows    rowsTable    追加/削除つきの行。columns:[項目...]。値は行オブジェクトの JSON 配列文字列。min(既定 1)
 * field / fields は <key>__labels(code→label の JSON)も一緒に保存する。
 * 保存値は全部文字列。前回の欄がもう無い時は「(見つかりません: code)」で残し、保存時に止める。
 */
(function () {
  'use strict';

  var VERSION = '0.7.0';
  if (window.RelayConfig && window.RelayConfig.version === VERSION) return;

  var ALL_VIEWS = '__all__';
  var OPTION_TYPES = ['DROP_DOWN', 'RADIO_BUTTON', 'CHECK_BOX', 'MULTI_SELECT'];
  var LAYOUT_ONLY = ['GROUP', 'LABEL', 'SPACER', 'HR', 'REFERENCE_TABLE', 'SUBTABLE'];
  var seq = 0;

  // ---------- DOM に依存しない部分(_internal でテストする) ----------

  // fields.json の properties → 平らな一覧。サブテーブルの中の欄は table(表のラベル)つき。
  function parseForm(properties) {
    var list = [];
    var byCode = {};
    Object.keys(properties || {}).forEach(function (k) {
      var p = properties[k];
      var e = { code: p.code || k, label: p.label || p.code || k, type: p.type, table: null, options: optionList(p) };
      list.push(e);
      byCode[e.code] = e;
      if (p.type === 'SUBTABLE' && p.fields) {
        Object.keys(p.fields).forEach(function (ik) {
          var q = p.fields[ik];
          var ie = { code: q.code || ik, label: q.label || q.code || ik, type: q.type, table: e.label, options: optionList(q) };
          list.push(ie);
          byCode[ie.code] = ie;
        });
      }
    });
    return { list: list, byCode: byCode };
  }

  function optionList(p) {
    if (!p || !p.options) return [];
    return Object.keys(p.options)
      .map(function (k) {
        var o = p.options[k];
        return { value: (o && o.label) || k, index: Number(o && o.index) || 0 };
      })
      .sort(function (a, b) { return a.index - b.index; })
      .map(function (o) { return o.value; });
  }

  // 候補: types で絞る(省略は全型。レイアウト用・表そのものは除く)。subtable 既定 true
  function fieldCandidates(form, item) {
    var types = item.types && item.types.length ? item.types : null;
    var withSub = item.subtable !== false;
    return form.list
      .filter(function (e) {
        if (e.table && !withSub) return false;
        if (types) return types.indexOf(e.type) >= 0;
        return LAYOUT_ONLY.indexOf(e.type) < 0;
      })
      .map(function (e) {
        var name = e.label + '(' + e.code + ')';
        return { value: e.code, label: e.label, text: e.table ? e.table + ' › ' + name : name };
      });
  }

  // views.json の views(name→{id,name,index}) → index 順の [{value:id, text:name}]
  function viewList(views) {
    return Object.keys(views || {})
      .map(function (k) { return views[k]; })
      .sort(function (a, b) { return Number(a.index) - Number(b.index); })
      .map(function (v) { return { value: String(v.id), text: v.name }; });
  }

  function parseArr(s) {
    if (Array.isArray(s)) return s.map(String);
    if (typeof s !== 'string' || !s) return [];
    try {
      var j = JSON.parse(s);
      return Array.isArray(j) ? j.map(String) : [];
    } catch (e) {
      return [];
    }
  }

  function parseObjArr(s) {
    if (typeof s !== 'string' || !s) return [];
    try {
      var j = JSON.parse(s);
      return Array.isArray(j) ? j.filter(function (x) { return x && typeof x === 'object'; }) : [];
    } catch (e) {
      return [];
    }
  }

  // 数値の検証。返り値は { value:'確定値', error:null|'文' }
  function checkNumber(item, raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (v === '' && item['default'] !== undefined && item['default'] !== null) v = String(item['default']);
    if (v === '') return { value: '', error: item.required ? '入力してください' : null };
    var n = Number(v);
    if (!isFinite(n)) return { value: v, error: '数値を入力してください' };
    if (typeof item.min === 'number' && n < item.min) return { value: v, error: item.min + ' 以上にしてください' };
    if (typeof item.max === 'number' && n > item.max) return { value: v, error: item.max + ' 以下にしてください' };
    if (typeof item.step === 'number' && item.step > 0) {
      var base = typeof item.min === 'number' ? item.min : 0;
      var q = (n - base) / item.step;
      if (Math.abs(q - Math.round(q)) > 1e-9) return { value: v, error: item.step + ' 刻みで入力してください' };
    }
    return { value: v, error: null };
  }

  function checkText(item, raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v && item.required) return { value: v, error: '入力してください' };
    if (item.maxLength && v.length > item.maxLength) return { value: v, error: item.maxLength + ' 文字以内にしてください' };
    return { value: v, error: null };
  }

  function minOf(item) {
    return typeof item.min === 'number' ? item.min : item.required ? 1 : 0;
  }

  function missingText(v) { return '(見つかりません: ' + v + ')'; }

  // ---------- DOM ----------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function show(e, on) {
    e.hidden = !on;
    e.style.display = on ? '' : 'none';
  }

  // 行の枠: ラベル(+必須印)・説明・コントロール・エラー欄。bare は表のセル用(ラベル無し)
  function frame(item, control, env) {
    var err = el('div', 'kintoneplugin-alert');
    show(err, false);
    var root;
    if (env.bare) {
      root = el('div', 'relay-config-cell');
    } else {
      root = el('div', 'kintoneplugin-row');
      var lab = el('div', 'kintoneplugin-label', item.label || item.key);
      if (item.required || minOf(item) > 0) lab.appendChild(el('span', 'kintoneplugin-require', '*'));
      root.appendChild(lab);
      if (item.desc) root.appendChild(el('div', 'kintoneplugin-desc', item.desc));
    }
    root.appendChild(control);
    root.appendChild(err);
    return {
      el: root,
      setError: function (msg) {
        err.textContent = msg || '';
        show(err, !!msg);
      },
    };
  }

  function selectControl(options, current) {
    var outer = el('div', 'kintoneplugin-select-outer');
    var wrap = el('div', 'kintoneplugin-select');
    var sel = el('select');
    options.forEach(function (o) {
      var op = el('option', null, o.text);
      op.value = o.value;
      sel.appendChild(op);
    });
    wrap.appendChild(sel);
    outer.appendChild(wrap);
    sel.value = current;
    return { outer: outer, select: sel };
  }

  // チェックボックス群。opts: [{value,text,missing}]、checked: 値の配列。get() は選択値
  function checkControl(opts, checked, onChange) {
    var box = el('div');
    var inputs = [];
    opts.forEach(function (o) {
      var id = 'relay-cfg-' + ++seq;
      var wrap = el('div', 'kintoneplugin-input-checkbox');
      var item = el('span', 'kintoneplugin-input-checkbox-item');
      var inp = el('input');
      inp.type = 'checkbox';
      inp.id = id;
      inp.value = o.value;
      inp.checked = checked.indexOf(o.value) >= 0;
      if (onChange) inp.addEventListener('change', onChange);
      var lab = el('label', null, o.text);
      lab.setAttribute('for', id);
      item.appendChild(inp);
      item.appendChild(lab);
      wrap.appendChild(item);
      box.appendChild(wrap);
      inputs.push({ inp: inp, o: o });
    });
    return {
      el: box,
      get: function () {
        return inputs.filter(function (x) { return x.inp.checked; }).map(function (x) { return x.o.value; });
      },
    };
  }

  // 候補に無い前回値を「見つかりません」として足す
  function withMissing(opts, prev) {
    var known = {};
    opts.forEach(function (o) { known[o.value] = true; });
    var out = opts.slice();
    var missing = {};
    prev.forEach(function (v) {
      if (v && !known[v]) {
        out.push({ value: v, text: missingText(v), missing: true });
        missing[v] = true;
        known[v] = true;
      }
    });
    return { opts: out, missing: missing };
  }

  function initial(item, env) {
    var v = env.config[item.key];
    if (v === undefined || v === null) return item['default'] === undefined ? '' : item['default'];
    return v;
  }
  function initialArr(item, env) {
    var v = env.config[item.key];
    if (v === undefined || v === null || v === '') return Array.isArray(item['default']) ? item['default'].map(String) : [];
    return parseArr(v);
  }

  function labelsExtra(item, codes, cands) {
    var map = {};
    codes.forEach(function (c) {
      cands.forEach(function (x) { if (x.value === c) map[c] = x.label; });
    });
    var o = {};
    o[item.key + '__labels'] = JSON.stringify(map);
    return o;
  }

  // --- field ---
  function fieldSelect(item, env) {
    var cands = fieldCandidates(env.data.form, item);
    var cur = String(initial(item, env) || '');
    var opts = [{ value: '', text: '選択してください' }].concat(cands.map(function (c) { return { value: c.value, text: c.text }; }));
    var m = withMissing(opts, cur ? [cur] : []);
    var ctl = selectControl(m.opts, cur);
    ctl.select.addEventListener('change', function () { env.notify(item.key); });
    var f = frame(item, ctl.outer, env);
    return {
      el: f.el,
      value: function () { return ctl.select.value; },
      extras: function () { return labelsExtra(item, ctl.select.value ? [ctl.select.value] : [], cands); },
      check: function () {
        var v = ctl.select.value;
        var msg = null;
        if (!v && item.required) msg = '選択してください';
        else if (v && m.missing[v]) msg = '「' + v + '」は見つかりません。選び直してください';
        f.setError(msg);
        return msg;
      },
    };
  }

  // --- fields ---
  function fieldChecks(item, env) {
    var cands = fieldCandidates(env.data.form, item);
    var base = cands.map(function (c) { return { value: c.value, text: c.text }; });
    var prev = initialArr(item, env);
    var m = withMissing(base, prev);
    var ctl = checkControl(m.opts, prev, function () { env.notify(item.key); });
    var f = frame(item, ctl.el, env);
    return {
      el: f.el,
      value: function () { return JSON.stringify(ctl.get()); },
      extras: function () { return labelsExtra(item, ctl.get(), cands); },
      check: function () {
        var sel = ctl.get();
        var msg = null;
        var bad = sel.filter(function (v) { return m.missing[v]; });
        if (bad.length) msg = '見つかりません: ' + bad.join(', ') + '(チェックを外してください)';
        else if (sel.length < minOf(item)) msg = minOf(item) + ' つ以上選んでください';
        f.setError(msg);
        return msg;
      },
    };
  }

  // --- view ---
  function viewOptions(env) {
    return [{ value: ALL_VIEWS, text: 'すべての一覧' }].concat(env.data.views || []);
  }
  function viewSelect(item, env) {
    var cur = String(initial(item, env) || '');
    var opts = [{ value: '', text: '選択してください' }].concat(viewOptions(env));
    var m = withMissing(opts, cur ? [cur] : []);
    var ctl = selectControl(m.opts, cur);
    ctl.select.addEventListener('change', function () { env.notify(item.key); });
    var f = frame(item, ctl.outer, env);
    return {
      el: f.el,
      value: function () { return ctl.select.value; },
      extras: function () { return {}; },
      check: function () {
        var v = ctl.select.value;
        var msg = null;
        if (!v && item.required) msg = '選択してください';
        else if (v && m.missing[v]) msg = '一覧 ' + v + ' は見つかりません。選び直してください';
        f.setError(msg);
        return msg;
      },
    };
  }

  function viewChecks(item, env) {
    var prev = initialArr(item, env);
    var m = withMissing(viewOptions(env), prev);
    var ctl = checkControl(m.opts, prev, function () { env.notify(item.key); });
    var f = frame(item, ctl.el, env);
    return {
      el: f.el,
      value: function () { return JSON.stringify(ctl.get()); },
      extras: function () { return {}; },
      check: function () {
        var sel = ctl.get();
        var msg = null;
        var bad = sel.filter(function (v) { return m.missing[v]; });
        if (bad.length) msg = '見つかりません: ' + bad.join(', ') + '(チェックを外してください)';
        else if (sel.length < minOf(item)) msg = minOf(item) + ' つ以上選んでください';
        f.setError(msg);
        return msg;
      },
    };
  }

  // --- app ---
  function appSelect(item, env) {
    var cur = String(initial(item, env) || '');
    var apps = (env.data.apps || []).map(function (a) { return { value: String(a.appId), text: a.name + '(' + a.appId + ')' }; });
    var m = withMissing([{ value: '', text: '選択してください' }].concat(apps), cur ? [cur] : []);
    var ctl = selectControl(m.opts, cur);
    ctl.select.addEventListener('change', function () { env.notify(item.key); });
    var f = frame(item, ctl.outer, env);
    return {
      el: f.el,
      value: function () { return ctl.select.value; },
      extras: function () { return {}; },
      check: function () {
        var v = ctl.select.value;
        var msg = null;
        if (!v && item.required) msg = '選択してください';
        else if (v && m.missing[v]) msg = 'アプリ ' + v + ' は見つかりません。選び直してください';
        f.setError(msg);
        return msg;
      },
    };
  }

  // --- options ---
  function optionsOf(env, code) {
    var e = code && env.data.form.byCode[code];
    return e && OPTION_TYPES.indexOf(e.type) >= 0 ? e.options : null;
  }
  function optionChecks(item, env) {
    var holder = el('div');
    var f = frame(item, holder, env);
    var selected = initialArr(item, env);
    var cur = null; // { get, missing }
    var hint = null;

    function sourceCode() {
      if (item.field) return item.field;
      var v = env.getValue(item.of) || '';
      if (v.charAt(0) === '[') v = parseArr(v)[0] || '';
      return v;
    }
    function render() {
      if (cur) selected = cur.get();
      clear(holder);
      cur = null;
      var opts = optionsOf(env, sourceCode());
      if (!opts) {
        hint = el('div', 'kintoneplugin-desc', '先に対象の欄(選択肢のあるフィールド)を選んでください');
        holder.appendChild(hint);
        cur = { get: function () { return selected; }, missing: {} };
        return;
      }
      var m = withMissing(opts.map(function (o) { return { value: o, text: o }; }), selected);
      var c = checkControl(m.opts, selected, null);
      holder.appendChild(c.el);
      cur = { get: c.get, missing: m.missing };
    }
    render();
    if (item.of) env.onChange(item.of, function () { render(); f.setError(''); });
    return {
      el: f.el,
      value: function () { return JSON.stringify(cur.get()); },
      extras: function () { return {}; },
      check: function () {
        var sel = cur.get();
        var msg = null;
        var bad = sel.filter(function (v) { return cur.missing[v]; });
        if (bad.length) msg = '見つかりません: ' + bad.join(', ') + '(チェックを外してください)';
        else if (sel.length < minOf(item)) msg = minOf(item) + ' つ以上選んでください';
        f.setError(msg);
        return msg;
      },
    };
  }

  // --- number / text ---
  function numberInput(item, env) {
    var outer = el('div', 'kintoneplugin-input-outer');
    var inp = el('input', 'kintoneplugin-input-text');
    inp.type = 'text';
    inp.setAttribute('inputmode', 'decimal');
    var cur = env.config[item.key];
    inp.value = cur === undefined || cur === null ? (item['default'] === undefined ? '' : String(item['default'])) : String(cur);
    if (item['default'] !== undefined) inp.placeholder = String(item['default']);
    inp.addEventListener('change', function () { env.notify(item.key); });
    outer.appendChild(inp);
    var f = frame(item, outer, env);
    return {
      el: f.el,
      value: function () { return checkNumber(item, inp.value).value; },
      extras: function () { return {}; },
      check: function () {
        var r = checkNumber(item, inp.value);
        f.setError(r.error);
        return r.error;
      },
    };
  }

  function textInput(item, env) {
    var outer = el('div', 'kintoneplugin-input-outer');
    var inp = el('input', 'kintoneplugin-input-text');
    inp.type = 'text';
    var cur = env.config[item.key];
    inp.value = cur === undefined || cur === null ? (item['default'] === undefined ? '' : String(item['default'])) : String(cur);
    if (item.placeholder) inp.placeholder = item.placeholder;
    if (item.maxLength) inp.setAttribute('maxlength', String(item.maxLength));
    inp.addEventListener('change', function () { env.notify(item.key); });
    outer.appendChild(inp);
    var f = frame(item, outer, env);
    return {
      el: f.el,
      value: function () { return checkText(item, inp.value).value; },
      extras: function () { return {}; },
      check: function () {
        var r = checkText(item, inp.value);
        f.setError(r.error);
        return r.error;
      },
    };
  }

  // --- rows ---
  function makeEnv(data, config, parent) {
    var widgets = {};
    var reg = {};
    var env = {
      data: data,
      config: config,
      bare: false,
      widgets: widgets,
      getValue: function (key) {
        if (widgets[key]) return widgets[key].value();
        if (hasKey(env, key) || !parent) return '';
        return parent.getValue(key);
      },
      onChange: function (key, fn) {
        if (!hasKey(env, key) && parent) return parent.onChange(key, fn);
        (reg[key] = reg[key] || []).push(fn);
      },
      notify: function (key) {
        (reg[key] || []).forEach(function (fn) { fn(); });
      },
      columnKeys: null,
    };
    return env;
  }
  function hasKey(env, key) { return !!(env.columnKeys && env.columnKeys.indexOf(key) >= 0); }

  function rowsTable(item, env) {
    var cols = item.columns || [];
    var minRows = typeof item.min === 'number' ? Math.max(1, item.min) : 1;
    var table = el('table', 'kintoneplugin-table');
    var thead = el('thead');
    var htr = el('tr');
    cols.forEach(function (c) {
      var th = el('th', 'kintoneplugin-table-th');
      var span = el('span', 'title', c.label || c.key);
      if (c.required || minOf(c) > 0) span.appendChild(el('span', 'kintoneplugin-require', '*'));
      th.appendChild(span);
      htr.appendChild(th);
    });
    htr.appendChild(el('th', 'kintoneplugin-table-th-blankspace'));
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el('tbody');
    table.appendChild(tbody);
    var rows = [];
    var f = frame(item, table, env);

    function buildRow(values) {
      var renv = makeEnv(env.data, values, env);
      renv.bare = true;
      renv.columnKeys = cols.map(function (c) { return c.key; });
      var tr = el('tr');
      var ws = [];
      cols.forEach(function (c) {
        var w = build(c, renv);
        renv.widgets[c.key] = w;
        ws.push(w);
        var td = el('td');
        var ctl = el('div', 'kintoneplugin-table-td-control');
        var val = el('div', 'kintoneplugin-table-td-control-value');
        val.appendChild(w.el);
        ctl.appendChild(val);
        td.appendChild(ctl);
        tr.appendChild(td);
      });
      var op = el('td', 'kintoneplugin-table-td-operation');
      var add = el('button', 'kintoneplugin-button-add-row-image');
      add.type = 'button';
      add.title = '行を追加';
      var rm = el('button', 'kintoneplugin-button-remove-row-image');
      rm.type = 'button';
      rm.title = 'この行を削除';
      op.appendChild(add);
      op.appendChild(rm);
      tr.appendChild(op);
      var row = { tr: tr, widgets: ws };
      add.addEventListener('click', function () {
        rows.splice(rows.indexOf(row) + 1, 0, buildRow({}));
        draw();
      });
      rm.addEventListener('click', function () {
        if (rows.length <= minRows) return;
        rows.splice(rows.indexOf(row), 1);
        draw();
      });
      return row;
    }
    function draw() {
      clear(tbody);
      rows.forEach(function (r) { tbody.appendChild(r.tr); });
    }
    var prev = parseObjArr(env.config[item.key]);
    for (var i = 0; i < Math.max(prev.length, minRows); i++) rows.push(buildRow(prev[i] || {}));
    draw();

    return {
      el: f.el,
      value: function () {
        return JSON.stringify(
          rows.map(function (r) {
            var o = {};
            r.widgets.forEach(function (w, i) {
              o[cols[i].key] = w.value();
              var ex = w.extras();
              Object.keys(ex).forEach(function (k) { o[k] = ex[k]; });
            });
            return o;
          }),
        );
      },
      extras: function () { return {}; },
      check: function () {
        var msg = null;
        rows.forEach(function (r) {
          r.widgets.forEach(function (w) {
            var m = w.check();
            if (m && !msg) msg = m;
          });
        });
        f.setError(msg ? '入力を確かめてください(' + msg + ')' : null);
        return msg;
      },
    };
  }

  var PARTS = {
    field: fieldSelect,
    fields: fieldChecks,
    view: viewSelect,
    views: viewChecks,
    app: appSelect,
    options: optionChecks,
    number: numberInput,
    text: textInput,
    rows: rowsTable,
  };
  function build(item, env) {
    var fn = PARTS[item.type];
    if (!fn) throw new Error('RelayConfig: 未対応の type: ' + item.type);
    return fn(item, env);
  }

  // ---------- API 取得 ----------
  function api(path, params) {
    return kintone.api(kintone.api.url(path, true), 'GET', params);
  }
  function scan(items, f) {
    items.forEach(function (it) {
      f(it);
      if (it.columns) scan(it.columns, f);
    });
  }
  function loadApps() {
    var all = [];
    function page(offset) {
      return api('/k/v1/apps.json', { limit: 100, offset: offset }).then(function (r) {
        var a = (r && r.apps) || [];
        all = all.concat(a);
        return a.length < 100 ? all : page(offset + 100);
      });
    }
    return page(0);
  }
  function errText(e) { return e && e.message ? e.message : String(e); }

  // ---------- mount ----------
  function mount(root, opts) {
    var items = opts.items || [];
    var errorEl = opts.errorEl || null;
    var appId = kintone.app.getId();
    var needViews = false;
    var needApps = false;
    scan(items, function (it) {
      if (it.type === 'view' || it.type === 'views') needViews = true;
      if (it.type === 'app') needApps = true;
    });
    var state = { ready: false, widgets: [], env: null };

    function showError(lines) {
      if (!errorEl) return;
      errorEl.textContent = lines.join(' / ');
      show(errorEl, lines.length > 0);
    }

    root.textContent = '読み込み中...';
    var data = { form: null, views: [], apps: [] };
    var jobs = [
      api('/k/v1/app/form/fields', { app: appId }).then(function (r) { data.form = parseForm(r.properties); }).catch(function (e) {
        throw new Error('フィールド一覧を取得できませんでした: ' + errText(e));
      }),
    ];
    if (needViews) {
      jobs.push(
        api('/k/v1/app/views.json', { app: appId }).then(function (r) { data.views = viewList(r.views); }).catch(function (e) {
          throw new Error('一覧(ビュー)を取得できませんでした: ' + errText(e));
        }),
      );
    }
    if (needApps) {
      jobs.push(
        loadApps().then(function (a) { data.apps = a; }).catch(function (e) {
          throw new Error('アプリ一覧を取得できませんでした: ' + errText(e));
        }),
      );
    }
    var ready = Promise.all(jobs).then(
      function () {
        var config = kintone.plugin.app.getConfig(opts.pluginId) || {};
        var env = makeEnv(data, config, null);
        env.columnKeys = items.map(function (i) { return i.key; });
        clear(root);
        items.forEach(function (it) {
          var w = build(it, env);
          env.widgets[it.key] = w;
          state.widgets.push(w);
          root.appendChild(w.el);
        });
        state.env = env;
        state.ready = true;
      },
      function (e) {
        root.textContent = '';
        showError([errText(e)]);
      },
    );

    return {
      ready: ready,
      save: function () {
        if (!state.ready) {
          showError(['設定画面を読み込めていません']);
          return false;
        }
        showError([]);
        var lines = [];
        state.widgets.forEach(function (w, i) {
          var m = w.check();
          if (m) lines.push((items[i].label || items[i].key) + ': ' + m);
        });
        if (lines.length) {
          showError(lines);
          return false;
        }
        var next = {};
        state.widgets.forEach(function (w, i) {
          next[items[i].key] = String(w.value());
          var ex = w.extras();
          Object.keys(ex).forEach(function (k) { next[k] = String(ex[k]); });
        });
        kintone.plugin.app.setConfig(next); // コールバック省略時は kintone がプラグイン一覧へ戻す
        return true;
      },
      cancel: function () {
        window.location.href = '/k/admin/app/' + appId + '/plugin/';
      },
    };
  }

  window.RelayConfig = {
    version: VERSION,
    mount: mount,
    fieldSelect: fieldSelect,
    fieldChecks: fieldChecks,
    viewSelect: viewSelect,
    viewChecks: viewChecks,
    appSelect: appSelect,
    optionChecks: optionChecks,
    numberInput: numberInput,
    textInput: textInput,
    rowsTable: rowsTable,
    _internal: {
      parseForm: parseForm,
      fieldCandidates: fieldCandidates,
      viewList: viewList,
      optionList: optionList,
      checkNumber: checkNumber,
      checkText: checkText,
      parseArr: parseArr,
      withMissing: withMissing,
    },
  };
})();
