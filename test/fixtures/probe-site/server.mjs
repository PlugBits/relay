// kin-probe.test.mjs 用のモック kintone サイト。
// node:http だけで組んだ最小サーバー: /login(フォーム→cookie)・
// /k/<app>/show・/k/<app>/・/k/admin/app/<app>/plugin/config・/k/v1/records.json。
// 各画面は「kintone もどき」(kintone-mock.js)を読み込み、window.kintone を
// 少し遅れて代入し、登録された handler を app.record.*.show 等で呼ぶ。
// detail では customize.js が console.error と TypeError を起こす。
import http from 'node:http';
import { randomBytes } from 'node:crypto';

// window.kintone は(実機と同じく)少し遅れて代入される。<script src> での
// 読み込みはネットワーク待ちの間に他の setTimeout が先に走ることがあるので、
// 'kintoneready' という一発イベントではなく「準備できたら呼ぶ/もう準備できて
// いたら即呼ぶ」キュー(__onKintoneReady)にして、登録のタイミング競合を避ける。
const KINTONE_MOCK_JS = `
(function () {
  var ready = false;
  var queue = [];
  window.__onKintoneReady = function (cb) {
    if (ready) cb(); else queue.push(cb);
  };
  function makeKintone() {
    var handlers = {};
    var events = {
      on: function (types, handler) {
        var list = Array.isArray(types) ? types : [types];
        for (var i = 0; i < list.length; i++) {
          (handlers[list[i]] = handlers[list[i]] || []).push(handler);
        }
      },
    };
    return {
      events: events,
      _fire: function (type) {
        var ev = { type: type };
        var hs = handlers[type] || [];
        for (var i = 0; i < hs.length; i++) hs[i](ev);
      },
    };
  }
  setTimeout(function () {
    window.kintone = makeKintone();
    ready = true;
    while (queue.length) queue.shift()();
  }, 0);
})();
`;

// detail 用カスタマイズ: 無害なイベントを先に登録して発火させ、その後
// app.record.detail.show で console.error → TypeError を起こす。
const CUSTOMIZE_JS = `
window.__onKintoneReady(function () {
  kintone.events.on('app.record.detail.process.proceed', function (event) {
    return true;
  });
  kintone.events.on('app.record.detail.show', function (event) {
    console.error('customize: 金額 のチェックに失敗');
    var record = {};
    throw new TypeError('record.金額 is undefined');
  });
});
`;

function loginHtml(error) {
  return `<!doctype html><html><body>
${error ? `<div class="error">${error}</div>` : ''}
<form method="post" action="/login">
  <input type="text" name="username" />
  <input type="password" name="password" />
  <button type="submit" class="login-button">Login</button>
</form>
</body></html>`;
}

function detailHtml() {
  return `<!doctype html><html><head>
<link rel="stylesheet" href="/static/missing.css">
</head><body>
<img src="/favicon.ico" width="1" height="1" alt="">
<script src="/static/kintone-mock.js"></script>
<script src="/static/customize.js"></script>
<script>
window.__onKintoneReady(function () {
  kintone._fire('app.record.detail.process.proceed');
  kintone._fire('app.record.detail.show');
});
</script>
</body></html>`;
}

function indexHtml() {
  return `<!doctype html><html><body>
<script src="/static/kintone-mock.js"></script>
<script>
window.__onKintoneReady(function () {
  kintone.events.on('app.record.index.show', function (event) {});
  kintone._fire('app.record.index.show');
});
</script>
</body></html>`;
}

function configHtml(pluginId) {
  // 設定画面もどき: 項目名(label)とボタン(role=button)。kintone のクラス名は使わない
  return `<!doctype html><html><body>config for plugin ${pluginId || ''}
<label for="cfg-field">対象フィールド</label><input id="cfg-field">
<button type="button">保存</button><button type="button">キャンセル</button>
</body></html>`;
}

// 追加画面もどき: label for の入力欄・ラベルが label でない(span)入力欄と select・ダイアログ・保存ボタン。
// handler を同じ type に2回登録して(handlers=2)1回発火する。保存は /__save に送って完了ページへ移る。
function editHtml(app) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main>
<h1>レコードの追加</h1>
<div><label for="f-part">品番</label><input id="f-part"></div>
<div><span>数量</span><div><input id="f-qty"></div></div>
<div><span>区分</span><div><select id="f-kind"><option value="">--</option><option value="RM-401">RM-401</option><option value="RM-402">RM-402</option></select></div></div>
<div id="note" style="display:none">未登録</div>
<button type="button" id="b-save">保存</button>
<button type="button" id="b-del">削除</button>
<button type="button" id="b-tidy">マスターを整える</button>
<span>TEST-V08</span>
</main>
<div id="ovl" style="display:none;position:fixed;inset:0;z-index:10;background:rgba(255,255,255,.97)">
  <p>整える</p>
  <button type="button" id="b-po">TEST-V08</button>
  <div id="pick" style="display:none"><select id="s-merge"><option value="">--</option><option value="rm401">RM-401 新規ワッシャー</option></select></div>
  <p id="picked"></p>
</div>
<div id="dlg" role="dialog" aria-label="確認" style="display:none;border:1px solid #333;padding:8px">
  <p>本当に削除しますか?</p>
  <button type="button" id="b-yes">はい</button><button type="button" id="b-no">キャンセル</button>
</div>
<script src="/static/kintone-mock.js"></script>
<script>
var q = document.getElementById('f-qty'), part = document.getElementById('f-part');
part.addEventListener('input', function () {
  document.getElementById('note').style.display = part.value === 'ZZ-999' ? 'block' : 'none';
});
document.getElementById('b-tidy').onclick = function () { document.getElementById('ovl').style.display = 'block'; };
document.getElementById('b-po').onclick = function () { document.getElementById('pick').style.display = 'block'; };
document.getElementById('s-merge').onchange = function (e) { document.getElementById('picked').textContent = '統合先: ' + e.target.value; };
document.getElementById('b-del').onclick = function () { document.getElementById('dlg').style.display = 'block'; };
document.getElementById('b-no').onclick = function () { document.getElementById('dlg').style.display = 'none'; };
document.getElementById('b-yes').onclick = function () { document.getElementById('dlg').style.display = 'none'; };
document.getElementById('b-save').onclick = function () {
  fetch('/__save', { method: 'POST', body: JSON.stringify({ part: part.value, qty: q.value, kind: document.getElementById('f-kind').value }) })
    .then(function () { location.href = '/k/${app}/done#record=43'; });
};
window.__onKintoneReady(function () {
  kintone.events.on('app.record.create.show', function () {});
  kintone.events.on('app.record.create.show', function () {});
  kintone._fire('app.record.create.show');
});
</script>
</body></html>`;
}

function doneHtml() {
  return '<!doctype html><html><body><main><h1>レコードの詳細</h1><p>保存しました</p></main></body></html>';
}

export function createProbeSite({ username, password, appId = '1', emptyRecordsAppId = null }) {
  const sessions = new Set();
  const saved = []; // /__save に送られた値(テストが見る)

  function sendHtml(res, status, html) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  function sendJs(res, status, js) {
    res.writeHead(status, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(js);
  }
  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });
  }

  const server = http.createServer(async (req, res) => {
    let u;
    try {
      u = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end('bad url');
      return;
    }
    const p = u.pathname;

    if (p === '/login' && req.method === 'GET') return sendHtml(res, 200, loginHtml());
    if (p === '/login' && req.method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      if (params.get('username') === username && params.get('password') === password) {
        const sid = randomBytes(8).toString('hex');
        sessions.add(sid);
        res.writeHead(302, { Location: '/', 'Set-Cookie': `kinProbeSession=${sid}; Path=/` });
        res.end();
        return;
      }
      return sendHtml(res, 200, loginHtml('ユーザー名またはパスワードが違います'));
    }
    if (p === '/') return sendHtml(res, 200, '<!doctype html><html><body>top</body></html>');
    if (p === '/static/kintone-mock.js') return sendJs(res, 200, KINTONE_MOCK_JS);
    if (p === '/static/customize.js') return sendJs(res, 200, CUSTOMIZE_JS);
    if (p === '/static/missing.css') {
      res.writeHead(404, { 'Content-Type': 'text/css' });
      res.end('not found');
      return;
    }
    if (p === '/k/v1/records.json') {
      const app = u.searchParams.get('app');
      if (emptyRecordsAppId && app === String(emptyRecordsAppId)) {
        return sendJson(res, 200, { records: [] });
      }
      return sendJson(res, 200, { records: [{ $id: { type: '__ID__', value: '42' } }] });
    }
    if (p === `/k/admin/app/${appId}/plugin/config`) return sendHtml(res, 200, configHtml(u.searchParams.get('pluginId')));
    if (p === '/__save' && req.method === 'POST') {
      try {
        saved.push(JSON.parse(await readBody(req)));
      } catch {
        // 壊れた本文は無視
      }
      return sendJson(res, 200, { ok: true });
    }
    if (p === `/k/${appId}/edit`) return sendHtml(res, 200, editHtml(appId));
    if (p === `/k/${appId}/done`) return sendHtml(res, 200, doneHtml());
    if (p === `/k/${appId}/show`) return sendHtml(res, 200, detailHtml());
    if (p === `/k/${appId}/`) return sendHtml(res, 200, indexHtml());

    res.writeHead(404);
    res.end('not found');
  });

  return {
    saved,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve(`http://127.0.0.1:${port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
