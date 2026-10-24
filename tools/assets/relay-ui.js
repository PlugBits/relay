/*
 * relay-ui.js - kintone プラグイン本体(desktop.js / mobile.js)が使う軽量の共通部品。
 * プラグイン作成 mod の一部(MIT License)。kin-scaffold がプラグインにそのまま写し、
 * manifest で desktop.js / mobile.js より先に読み込む。見た目は同梱の
 * 51-modern-default.css(kintoneplugin-* クラス)に任せる。
 *
 * 決まり:
 *  - kintone の内部 DOM に触らない。querySelector で kintone 側の要素を探さない・
 *    kintone のクラス名に依存しない。使うのは公式 API が返す要素
 *    (kintone.app.getHeaderMenuSpaceElement / getHeaderSpaceElement /
 *    kintone.app.record.getHeaderMenuSpaceElement / kintone.mobile.app.getHeaderSpaceElement)
 *    と、自分で作った要素だけ。パネルは自分の要素を document.body に足す。
 *  - 画面にブランド・製品名・会社名を出さない。色は足さない。独自 CSS はレイアウト
 *    (位置・幅・余白・z-index・白背景と 1px の枠)だけ。色・影・角丸・文字サイズは持たない。
 *  - 利用者のデータは textContent で入れる(innerHTML に値を入れない)。
 *  - 依存なし。グローバルは window.RelayUI だけ。既に同じか新しい版があれば上書きしない。
 *
 * API: version / headerButton / band / notice / clearNotice / panel / togglePanel
 * 置き場の要素が取れない時は何もせず null を返す(例外を投げない)。同じ id は更新して返す。
 */
(function () {
  'use strict';

  var VERSION = '0.5.0';

  function verNum(v) {
    var p = String(v || '0').split('.');
    return (parseInt(p[0], 10) || 0) * 1e6 + (parseInt(p[1], 10) || 0) * 1e3 + (parseInt(p[2], 10) || 0);
  }
  if (window.RelayUI && verNum(window.RelayUI.version) >= verNum(VERSION)) return;

  var STYLE_ID = 'relay-ui-style';
  var CSS = [
    '.relay-ui-headerbutton{margin:0 8px 0 0;vertical-align:middle}',
    '.relay-ui-band{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;margin:8px 0;padding:0 8px;box-sizing:border-box;max-width:100%}',
    '.relay-ui-band-item{white-space:nowrap}',
    '.relay-ui-band-text{overflow-wrap:anywhere}',
    '.relay-ui-notice{display:block;margin:8px 0;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere}',
    '.relay-ui-panel{position:fixed;top:64px;right:16px;bottom:16px;width:360px;max-width:100%;z-index:10000;display:flex;flex-direction:column;box-sizing:border-box;padding:12px;background:#fff;border:1px solid #e3e7e8;overflow:hidden}',
    '.relay-ui-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px}',
    '.relay-ui-panel-title{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
    '.relay-ui-panel-body{flex:1 1 auto;min-height:0;overflow:auto;overflow-wrap:anywhere}',
    '@media (max-width:480px){.relay-ui-panel{top:0;right:0;bottom:0;left:0;width:100%}}'
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // kind: 'headerMenu' | 'header' | 'recordHeaderMenu'
  function getSpace(kind, opts) {
    opts = opts || {};
    if (opts.space) return opts.space;
    try {
      var k = window.kintone;
      if (!k) return null;
      if (opts.mobile === true) {
        return k.mobile && k.mobile.app && k.mobile.app.getHeaderSpaceElement
          ? k.mobile.app.getHeaderSpaceElement() : null;
      }
      if (kind === 'headerMenu') return k.app.getHeaderMenuSpaceElement();
      if (kind === 'header') return k.app.getHeaderSpaceElement();
      return k.app.record.getHeaderMenuSpaceElement();
    } catch (e) {
      return null;
    }
  }

  // 自分の要素を id で探し、無ければ作って space に足す。
  function mine(id, tag, cls, space) {
    var el = id ? document.getElementById(id) : null;
    if (el && el.getAttribute('data-relay-ui') !== cls) el = null;
    if (!el) {
      el = document.createElement(tag);
      if (id) el.id = id;
      el.setAttribute('data-relay-ui', cls);
    }
    el.className = cls;
    if (el.parentNode !== space) space.appendChild(el);
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function fmt(v) {
    return typeof v === 'number' ? v.toLocaleString() : String(v == null ? '' : v);
  }

  function headerButton(opts) {
    opts = opts || {};
    var space = getSpace('headerMenu', opts);
    if (!space) return null;
    ensureStyle();
    var b = mine(opts.id, 'button', 'kintoneplugin-button-normal relay-ui-headerbutton', space);
    b.type = 'button';
    b.textContent = opts.label == null ? '' : String(opts.label);
    b.onclick = typeof opts.onClick === 'function' ? opts.onClick : null;
    return b;
  }

  function band(opts) {
    opts = opts || {};
    var space = getSpace('header', opts);
    if (!space) return null;
    ensureStyle();
    var el = mine(opts.id, 'div', 'relay-ui-band', space);
    clear(el);
    if (opts.loading) {
      var l = document.createElement('span');
      l.className = 'relay-ui-band-text kintoneplugin-desc';
      l.textContent = '集計中…';
      el.appendChild(l);
    } else if (Array.isArray(opts.items) && opts.items.length) {
      opts.items.forEach(function (it, i) {
        if (i > 0) {
          var dot = document.createElement('span');
          dot.className = 'kintoneplugin-desc';
          dot.textContent = '・';
          el.appendChild(dot);
        }
        var item = document.createElement('span');
        item.className = 'relay-ui-band-item';
        var lab = document.createElement('span');
        lab.className = 'kintoneplugin-label';
        lab.textContent = it.label == null ? '' : String(it.label);
        var val = document.createElement('span');
        val.className = 'kintoneplugin-desc';
        val.textContent = ' ' + fmt(it.value);
        item.appendChild(lab);
        item.appendChild(val);
        el.appendChild(item);
      });
    } else if (opts.text != null) {
      var t = document.createElement('span');
      t.className = 'relay-ui-band-text kintoneplugin-desc';
      t.textContent = String(opts.text);
      el.appendChild(t);
    }
    return el;
  }

  function notice(opts) {
    opts = opts || {};
    var space = getSpace('recordHeaderMenu', opts);
    if (!space) return null;
    ensureStyle();
    var el = mine(opts.id, 'div', 'kintoneplugin-alert relay-ui-notice', space);
    el.setAttribute('data-tone', opts.tone || 'info');
    el.textContent = opts.text == null ? '' : String(opts.text);
    return el;
  }

  function clearNotice(id) {
    var el = id ? document.getElementById(id) : null;
    if (el && el.getAttribute('data-relay-ui') && el.parentNode) el.parentNode.removeChild(el);
  }

  var panels = {};

  function fill(body, content) {
    clear(body);
    if (content == null) return;
    if (typeof content === 'object' && content.nodeType) body.appendChild(content);
    else body.appendChild(document.createTextNode(String(content)));
  }

  function panel(opts) {
    opts = opts || {};
    var id = opts.id || 'relay-ui-panel';
    var cur = panels[id];
    if (cur && cur.el.parentNode) {
      cur.title.textContent = opts.title == null ? '' : String(opts.title);
      fill(cur.body, opts.content);
      cur.onClose = opts.onClose;
      document.body.appendChild(cur.el); // 前に出す
      return cur.api;
    }
    ensureStyle();
    var el = document.createElement('div');
    el.id = id;
    el.className = 'relay-ui-panel';
    el.setAttribute('role', 'dialog');
    var head = document.createElement('div');
    head.className = 'relay-ui-panel-head';
    var title = document.createElement('span');
    title.className = 'relay-ui-panel-title kintoneplugin-label';
    title.textContent = opts.title == null ? '' : String(opts.title);
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'kintoneplugin-button-normal';
    closeBtn.textContent = '閉じる';
    head.appendChild(title);
    head.appendChild(closeBtn);
    var body = document.createElement('div');
    body.className = 'relay-ui-panel-body';
    fill(body, opts.content);
    el.appendChild(head);
    el.appendChild(body);

    var rec = { el: el, body: body, title: title, onClose: opts.onClose };
    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (el.parentNode) el.parentNode.removeChild(el);
      if (panels[id] === rec) delete panels[id];
      if (typeof rec.onClose === 'function') {
        try { rec.onClose(); } catch (e) { /* 呼び出し側の例外は握りつぶす */ }
      }
    }
    function onKey(e) {
      if (e.key === 'Escape' || e.key === 'Esc') close();
    }
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(el);
    rec.api = { el: el, body: body, close: close };
    panels[id] = rec;
    return rec.api;
  }

  function togglePanel(opts) {
    var id = (opts && opts.id) || 'relay-ui-panel';
    var cur = panels[id];
    if (cur && cur.el.parentNode) {
      cur.api.close();
      return null;
    }
    return panel(opts);
  }

  window.RelayUI = {
    version: VERSION,
    headerButton: headerButton,
    band: band,
    notice: notice,
    clearNotice: clearNotice,
    panel: panel,
    togglePanel: togglePanel
  };
})();
