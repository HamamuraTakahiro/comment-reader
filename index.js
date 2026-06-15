#!/usr/bin/env node
'use strict';

/*
 * comment-reader
 * Spooncast のライブ配信に流れてくるコメントを macOS の `say` で読み上げる。
 *
 * 仕組み:
 *   1. Playwright で実ブラウザ(Chromium)を起動
 *   2. ブラウザが配信ページで受信する WebSocket フレームを傍受
 *   3. フレーム中のチャットイベントから「ユーザー名」と「本文」を抽出
 *   4. 順番にキューイングして `say` で読み上げ
 *
 * 使い方:
 *   node index.js                      # ブラウザを開く→自分でログイン&配信を開く
 *   node index.js <配信URL>            # 指定URLを直接開く
 *   DEBUG=1 node index.js              # 受信した全フレームを表示(スキーマ調査用)
 *   VOICE=Kyoko RATE=200 node index.js # 音声/速度を指定
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---- 設定 ---------------------------------------------------------------
const START_URL = process.argv[2] || 'https://www.spooncast.net/jp/';
const VOICE = process.env.VOICE || 'Kyoko (Enhanced)';
const RATE = process.env.RATE || '200';            // say の話速(語/分)
// 音量(0.0〜1.0)。既定は0.5(半分)。実行中に数字キーで変更可能。
const VOLUME = (() => {
  const v = parseFloat(process.env.VOLUME);
  if (Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
})();
let currentVolume = VOLUME;
const DEBUG = process.env.DEBUG === '1';
const MUTE = process.env.MUTE === '1';             // 音声を出さずログのみ
const READ_NICKNAME = process.env.NO_NICKNAME !== '1';
const READ_HEARTS = process.env.NO_HEARTS !== '1';   // ハート(無料いいね)を読み上げる
const READ_PRESENTS = process.env.NO_PRESENTS !== '1'; // Spoon投げ/有料いいね等のプレゼントを読み上げる
const READ_JOINS = process.env.NO_JOINS !== '1';       // 入室を読み上げる
const READ_LEAVES = process.env.NO_LEAVES !== '1';     // 退室を読み上げる(リスナー一覧の差分で検出)
const LISTENER_POLL_MS = Math.max(3000, parseInt(process.env.LISTENER_POLL_MS, 10) || 12000); // 一覧取得間隔
// 特別読み上げするアイテム(itemId → 読み上げ文)。未登録のアイテムはidを付けて読み上げる。
const SPECIAL_ITEMS = {
  34: '貴重な粗品をありがと！',          // 心ばかりの粗品
  35: '貴重なルーレットハートありがと！', // ルーレットハート
};

// ---- 呼び名DB (userId → 呼び名) ----------------------------------------
// 「〜と呼んで」コメントで登録。登録ユーザーは その呼び名で(さん抜きで)読む。
const CALLNAMES_FILE = path.join(__dirname, 'callnames.json');
let callNames = {};
try { callNames = JSON.parse(fs.readFileSync(CALLNAMES_FILE, 'utf8')) || {}; } catch (_) { callNames = {}; }
function saveCallNames() {
  try { fs.writeFileSync(CALLNAMES_FILE, JSON.stringify(callNames, null, 2)); } catch (e) {
    console.error('呼び名DBの保存に失敗:', e.message);
  }
}

// コメントから「〜と呼んで」を検出し呼び名を抽出する(無ければ null)
function extractCallName(text) {
  if (!text) return null;
  const m = text.match(/(.+?)\s*(?:って|と|で)\s*呼んで/);
  if (!m) return null;
  let name = m[1];
  // 先頭の定型句(私のこと/これからは 等)を繰り返し除去
  let prev;
  do {
    prev = name;
    name = name
      .replace(/^(?:これから(?:は)?|今日から|もう|ぜひ|是非|やっぱり?|私|僕|俺|わたし|あたし|自分|あだ名|ニックネーム|名前)/u, '')
      .replace(/^(?:の)?(?:こと|事)/u, '')
      .replace(/^(?:を|は|で|って|、|・)/u, '')
      .trim();
  } while (name !== prev);
  name = name.replace(/[「」『』"'、。!！?？\s]/gu, '').trim();
  if (!name || name.length > 20) return null;
  return name;
}

// イベントの話者を解決: 登録済みなら{呼び名, さん無し}、未登録なら{ニックネーム, さん}
function resolveName(ev) {
  const custom = ev.userId != null ? callNames[ev.userId] : null;
  const name = custom || ev.nickname || null;
  return { name, san: custom ? '' : 'さん' };
}
// 読み上げ対象の WebSocket だけに絞るためのURLフィルタ(部分一致)。空なら全部対象。
const WS_FILTER = process.env.WS_FILTER || '';

// ログイン状態を保持するブラウザプロファイルの保存先
const USER_DATA_DIR = process.env.PROFILE_DIR || path.join(__dirname, '.browser-profile');

// 古いSingletonLockの掃除: ロックの所有プロセスが生きていなければ削除する。
function clearStaleSingletonLock(dir) {
  const lock = path.join(dir, 'SingletonLock');
  let target;
  try { target = fs.readlinkSync(lock); } catch (_) { return; } // リンクが無ければ何もしない
  // 形式: <hostname>-<pid>
  const m = String(target).match(/-(\d+)$/);
  const pid = m ? parseInt(m[1], 10) : null;
  let alive = false;
  if (pid) {
    try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; }
  }
  if (!alive) {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
    console.log('古いブラウザロックを掃除しました');
  } else {
    console.log(`注意: 別のブラウザ(pid ${pid})がプロファイルを使用中です。そのウィンドウを閉じてください。`);
  }
}

// DEBUG時に受信フレームを書き出すログファイル
const FRAME_LOG = path.join(__dirname, 'frames.log');
function logFrame(line) {
  if (!DEBUG) return;
  try { fs.appendFileSync(FRAME_LOG, line + '\n'); } catch (_) {}
}

// ---- 読み上げキュー(直列実行) ------------------------------------------
const queue = [];
let speaking = false;
let muted = MUTE;          // 実行中に切替可能なミュート状態(初期値は環境変数MUTE)
let currentChild = null;   // 再生中の say プロセス

function enqueueSpeak(text) {
  if (!text) return;
  if (muted) return; // ミュート中はログのみ
  queue.push(text);
  pump();
}

function pump() {
  if (speaking || queue.length === 0) return;
  speaking = true;
  const text = queue.shift();
  // 文頭の [[volm N]] で音量を指定(0.0〜1.0)。本文中の "[" はsayコマンド誤認を避けエスケープ。
  const safe = text.replace(/[\[\]]/g, ' ');
  const child = spawn('say', ['-v', VOICE, '-r', String(RATE), `[[volm ${currentVolume}]] ${safe}`]);
  currentChild = child;
  const done = () => { if (currentChild === child) currentChild = null; speaking = false; pump(); };
  child.on('exit', done);
  child.on('error', (e) => { console.error('say 実行エラー:', e.message); done(); });
}

// ミュート状態に関係なく必ず読み上げる(オン/オフのアナウンス用)
function forceSpeak(text) {
  queue.push(text);
  pump();
}

// 読み上げのオン/オフ切替。OFFにしたら待機中のキューと再生中の音声も止める。
// 切替はリスナーにも分かるよう音声でもアナウンスする。
function toggleMute() {
  muted = !muted;
  if (muted) {
    queue.length = 0;
    if (currentChild) { try { currentChild.kill(); } catch (_) {} }
    console.log('🔇 読み上げ: OFF');
    forceSpeak('コメント読み上げをオフにしました');
  } else {
    console.log('🔊 読み上げ: ON');
    forceSpeak('コメント読み上げをオンにしました');
  }
}

// 読み上げの途中キャンセル。再生中の音声を止め、待機中のキューも破棄(ミュートにはしない)。
function cancelSpeech() {
  queue.length = 0;
  if (currentChild) { try { currentChild.kill(); } catch (_) {} }
  console.log('⏭️ 読み上げをキャンセルしました');
}

// ---- フレーム解析 -------------------------------------------------------
// socket.io ("42[...]") / sockjs ("a[...]") / 素のJSON を JS オブジェクト配列に。
function parseFrame(payload) {
  if (typeof payload !== 'string') return [];
  const s = payload.trim();
  if (!s) return [];

  // sockjs: a["...","..."]  各要素がさらにJSON文字列
  if (s[0] === 'a' && s[1] === '[') {
    try {
      const arr = JSON.parse(s.slice(1));
      return arr.flatMap((item) => safeParse(item)).filter(Boolean);
    } catch (_) { /* fallthrough */ }
  }

  // socket.io: 先頭の数字(パケット種別)を剥がす  例: 42["event",{...}]
  const m = s.match(/^\d+/);
  if (m) {
    const rest = s.slice(m[0].length);
    if (rest && (rest[0] === '[' || rest[0] === '{')) {
      const v = safeParse(rest);
      return v ? [v] : [];
    }
  }

  const v = safeParse(s);
  return v ? [v] : [];
}

function safeParse(x) {
  if (typeof x !== 'string') return typeof x === 'object' ? x : null;
  try { return JSON.parse(x); } catch (_) { return null; }
}

// ---- イベント抽出 (Spoon専用) ------------------------------------------
// Spoonのフレームは次の構造:
//   { command:"MESSAGE", payload:{ body:"<JSON文字列>", ... }, timestamp:... }
//   body をパースすると { eventName:"...", eventPayload:{...} }
// 読み上げ対象のイベントを {kind, ...} の形で out に push する。
//   kind:'chat'    … 視聴者コメント        (ChatMessage)
//   kind:'heart'   … ハート(無料いいね)     (LiveFreeLike)
//   kind:'present' … Spoon等のプレゼント投げ (LivePresent 等)
function extractEvents(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.command !== 'MESSAGE' || !node.payload || typeof node.payload.body !== 'string') return;

  const body = safeParse(node.payload.body);
  if (!body || !body.eventName || !body.eventPayload) return;

  const ep = body.eventPayload;
  const ts = node.timestamp;
  const pickNick = (o) => (o && typeof o.nickname === 'string' && o.nickname.trim() ? o.nickname.trim() : null);
  const pickId = (...os) => {
    for (const o of os) {
      if (o && (typeof o.id === 'number' || typeof o.id === 'string')) return o.id;
      if (o && (typeof o.userId === 'number' || typeof o.userId === 'string')) return o.userId;
    }
    return null;
  };

  switch (body.eventName) {
    case 'ChatMessage': {
      const text = typeof ep.message === 'string' ? ep.message.trim() : '';
      if (!text) return;
      out.push({ kind: 'chat', nickname: pickNick(ep.generator), userId: pickId(ep.generator, ep), text, ts });
      return;
    }
    case 'LiveFreeLike': {
      // ハート(無料いいね): { nickname, count }
      const nickname = pickNick(ep) || pickNick(ep.generator);
      const count = Number(ep.count) || 1;
      out.push({ kind: 'heart', nickname, userId: pickId(ep, ep.generator), count, ts });
      return;
    }
    case 'LiveDonation': {
      // Spoon投げ: { nickname, amount(スプーン数), combo(コンボ数), donationMessage }
      const nickname = pickNick(ep) || pickNick(ep.generator);
      const amount = Number(ep.amount) || null;
      const combo = Number(ep.combo) || 1;
      const message = typeof ep.donationMessage === 'string' && ep.donationMessage.trim()
        ? ep.donationMessage.trim() : null;
      out.push({ kind: 'present', nickname, userId: pickId(ep, ep.generator), amount, combo, message, eventName: body.eventName, ts });
      return;
    }
    case 'LivePaidLike': {
      // 有料いいね(スタンプ): { nickname, amount(スプーン数), combo }
      const nickname = pickNick(ep) || pickNick(ep.generator);
      const amount = Number(ep.amount) || null;
      const combo = Number(ep.combo) || 1;
      out.push({ kind: 'present', nickname, userId: pickId(ep, ep.generator), amount, combo, message: null, eventName: body.eventName, ts });
      return;
    }
    case 'LiveItemUse': {
      // アイテム使用: { nickname, itemId, effectType, amount, combo }
      // itemId 34 は「心ばかりの粗品」ギフト。effectType "LIKE" はハート。それ以外はアイテム(プレゼント扱い)。
      const nickname = pickNick(ep) || pickNick(ep.generator);
      const userId = pickId(ep, ep.generator);
      const combo = Number(ep.combo) || 1;
      const phrase = SPECIAL_ITEMS[ep.itemId];
      if (phrase) {
        out.push({ kind: 'gift', nickname, userId, phrase, ts });
      } else {
        // 未登録のアイテムは、どのアイテムか分かるよう itemId を付けて読み上げる
        out.push({ kind: 'heart', nickname, userId, count: combo, itemId: ep.itemId, ts });
      }
      return;
    }
    case 'RoomJoin': {
      // 入室: eventPayload.generator.nickname が入室したユーザー
      const nickname = pickNick(ep.generator) || pickNick(ep);
      if (!nickname) return;
      out.push({ kind: 'join', nickname, userId: pickId(ep.generator, ep), ts });
      return;
    }
    case 'LiveMetaUpdate': {
      // 配信メタ更新。現在のリスナー数(memberCount)変化を退室検出のトリガに使う。
      if (ep.memberCount != null) out.push({ kind: 'meta', memberCount: Number(ep.memberCount) });
      return;
    }
    default: {
      // 上記以外のプレゼント系イベントの保険(将来Spoon側でイベント名が増えた場合)。
      // eventName に Present/Spoon/Sticker/Gift/Combo を含むものはベストエフォートで拾う。
      // ただし投げ物定義(DonationTray)等の "投げ本体ではない" イベントは除外。
      if (/present|spoon|sticker|gift|combo|donation/i.test(body.eventName)
          && !/tray|list|config|setting|init/i.test(body.eventName)) {
        const nickname = pickNick(ep.generator) || pickNick(ep.author) || pickNick(ep.user) || pickNick(ep);
        // spoon数/個数らしき数値を候補キーから拾う
        const num = (...keys) => {
          for (const k of keys) {
            const v = ep[k];
            if (typeof v === 'number' && v > 0) return v;
          }
          return null;
        };
        const amount = num('amount', 'spoon', 'spoonCount', 'spoonAmount', 'price', 'totalAmount', 'value');
        const combo = num('combo', 'comboCount', 'count', 'quantity', 'comboNum');
        // 送り主も金額も取れない=実際の投げではない可能性が高いのでスキップ
        if (!nickname && !amount) return;
        out.push({ kind: 'present', nickname, amount, combo, eventName: body.eventName, ts, raw: ep });
      }
      return;
    }
  }
}

// ---- 重複排除 -----------------------------------------------------------
const seen = new Set();
const seenOrder = [];
function isDuplicate(key) {
  if (seen.has(key)) return true;
  seen.add(key);
  seenOrder.push(key);
  if (seenOrder.length > 500) seen.delete(seenOrder.shift());
  return false;
}

// 絵文字を除去する(国旗/異体字セレクタ/ZWJ/キーキャップ含む)
function stripEmoji(s) {
  return s
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\p{Emoji_Modifier}/gu, '')                    // 肌色(スキントーン)修飾子
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')                  // 国旗(地域指示子)
    .replace(/[︀-️‍⃣]/gu, '')            // 異体字セレクタ/ZWJ/キーキャップ
    .replace(/\s+/g, ' ')
    .trim();
}

// 笑い表記(w / 笑)を読み上げ用に変換する。
//   2文字以上の連続 → わらわら / 1文字 → わら
//   w は英単語の一部を誤変換しないよう、前後が英字でない場合のみ対象。
function normalizeLaughter(s) {
  return s
    .replace(/(?<![A-Za-zＡ-Ｚａ-ｚ])[wｗ]{2,}(?![A-Za-zＡ-Ｚａ-ｚ])/g, 'わらわら')
    .replace(/笑{2,}/g, 'わらわら')
    .replace(/(?<![A-Za-zＡ-Ｚａ-ｚ])[wｗ](?![A-Za-zＡ-Ｚａ-ｚ])/g, 'わら')
    .replace(/笑/g, 'わら');
}

// イベント種別ごとに読み上げ文を組み立てる(対象外なら null)
function buildUtterance(ev) {
  // 話者名+「、」を前置。登録済み呼び名なら さん 無し。
  const withNick = (_unused, rest) => {
    if (!READ_NICKNAME) return rest;
    const { name, san } = resolveName(ev);
    if (!name) return rest;
    return san ? `${name} ${san}、${rest}` : `${name}、${rest}`;
  };
  switch (ev.kind) {
    case 'chat': {
      // コメントはユーザー名を読まず本文のみ。
      let body = stripEmoji(ev.text.replace(/\s+/g, ' ').trim());
      // URLは内容を読まず定型文に置換(スラッシュ変換より先に)
      body = body.replace(/https?:\/\/\S+/gi, ' URLのリンクが貼られました ');
      body = normalizeLaughter(body);
      body = body.replace(/\/{2,}/g, 'てれてれ'); // スラッシュ連続 → てれてれ
      body = body.replace(/\s+/g, ' ').trim();
      if (!body) return null; // 絵文字のみ等で本文が空なら読み上げない
      return body;
    }
    case 'heart': {
      if (!READ_HEARTS) return null;
      let c = ev.count > 1 ? `ハート${ev.count}ありがと！` : 'ハートありがと！';
      if (ev.itemId != null) c += `（アイテム${ev.itemId}）`; // アイテム系はidを付けて識別
      return withNick(ev.nickname, c);
    }
    case 'gift': {
      if (!READ_PRESENTS) return null;
      return withNick(ev.nickname, ev.phrase);
    }
    case 'present': {
      if (!READ_PRESENTS) return null;
      let rest = 'プレゼント';
      if (ev.amount && ev.combo && ev.combo > 1) rest = `${ev.amount}スプーン × ${ev.combo}`;
      else if (ev.amount) rest = `${ev.amount}スプーン`;
      let out = withNick(ev.nickname, `${rest}！`);
      if (ev.message) out += ` ${ev.message}`;
      return out;
    }
    case 'join': {
      if (!READ_JOINS) return null;
      const { name, san } = resolveName(ev);
      if (!name) return null;
      return san ? `${name} ${san}が入室しました` : `${name}が入室しました`;
    }
    case 'leave': {
      if (!READ_LEAVES) return null;
      const { name, san } = resolveName(ev);
      if (!name) return null;
      return san ? `${name} ${san}、またね` : `${name}、またね`;
    }
    default:
      return null;
  }
}

// 明らかにコメントでないものを弾く簡易フィルタ
function looksLikeChat(text) {
  if (!text) return false;
  if (text.length > 200) return false;            // 長すぎる=システムpayloadの可能性
  return true;
}

// ---- メイン -------------------------------------------------------------
async function main() {
  console.log('=== comment-reader ===');
  console.log(`音声: ${VOICE} / 速度: ${RATE} / ユーザー名読み上げ: ${READ_NICKNAME ? 'ON' : 'OFF'}`);
  if (DEBUG) {
    try { fs.writeFileSync(FRAME_LOG, ''); } catch (_) {}
    console.log(`[DEBUG] 受信フレームを表示し、${FRAME_LOG} に保存します`);
  }

  // 配信を切らずにツールだけ止められるように、Chromeは独立プロセスとして起動し
  // CDPで「接続」する。Ctrl+Cでツールが終了してもChrome(=配信)は生き残り、
  // 再起動すると生きているChromeに再接続して読み上げを再開できる。
  const CDP_PORT = parseInt(process.env.CDP_PORT, 10) || 9222;
  const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let browser = null;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    console.log('既存のChromeに再接続しました(配信は維持されます)');
  } catch (_) {
    clearStaleSingletonLock(USER_DATA_DIR);
    const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      START_URL,
    ];
    const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 60 && !browser; i++) {
      await sleep(300);
      try { browser = await chromium.connectOverCDP(CDP_ENDPOINT); } catch (_) {}
    }
    if (!browser) { console.error('Chromeへの接続に失敗しました'); process.exit(1); }
    console.log('Google Chrome を起動しました(プロファイル永続化)');
  }

  // CDP接続では既存のデフォルトコンテキストを使う
  const context = browser.contexts()[0] || (await browser.newContext({ locale: 'ja-JP' }));

  const NETWORK_LOG = path.join(__dirname, 'network.log');
  if (DEBUG) { try { fs.writeFileSync(NETWORK_LOG, ''); } catch (_) {} }

  // WebSocket傍受はCDPのNetworkドメインで行う。これなら接続前から開いている
  // ソケット(再接続時の既存チャットWS)のフレームも取得できる。
  async function attachPage(page) {
    try {
      const client = await context.newCDPSession(page);
      await client.send('Network.enable');
      const wsUrl = new Map();
      client.on('Network.webSocketCreated', (e) => {
        wsUrl.set(e.requestId, e.url);
        if (!WS_FILTER || (e.url || '').includes(WS_FILTER)) {
          console.log(`[WS] 接続: ${e.url}`);
          logFrame(`[WS-OPEN] ${e.url}`);
        }
      });
      client.on('Network.webSocketFrameReceived', (e) => {
        const url = wsUrl.get(e.requestId) || '';
        if (WS_FILTER && !url.includes(WS_FILTER)) return;
        const str = e.response && e.response.payloadData;
        if (typeof str !== 'string') return;
        if (DEBUG) logFrame(`[RECV] ${str}`);
        handlePayload(str);
      });
      if (DEBUG) {
        client.on('Network.webSocketFrameSent', (e) => {
          const str = e.response && e.response.payloadData;
          if (typeof str === 'string') logFrame(`[SENT] ${str}`);
        });
      }
    } catch (err) { if (DEBUG) console.log('CDP接続(WS)失敗:', err.message); }

    if (DEBUG) {
      page.on('request', (req) => {
        const u = req.url();
        if (/spoon|live|message|chat|comment|firebase/i.test(u)) {
          try { fs.appendFileSync(NETWORK_LOG, `[${req.method()}] ${u}\n`); } catch (_) {}
        }
      });
    }
  }
  context.on('page', attachPage);

  // 既存ページ(再接続時は配信ページ)を再利用。無ければ新規作成。
  const existing = context.pages();
  const page = existing.length > 0 ? existing[0] : await context.newPage();
  for (const p of existing) await attachPage(p);

  // 1イベントを処理(重複排除→呼び名登録→読み上げ)
  function emitEvent(ev) {
    const id = ev.kind === 'chat' ? ev.text
      : ev.kind === 'heart' ? `heart:${ev.itemId ?? ''}:${ev.count}`
      : ev.kind === 'join' ? 'join'
      : ev.kind === 'leave' ? 'leave'
      : ev.kind === 'gift' ? `gift:${ev.phrase}`
      : `${ev.eventName}:${ev.amount}:${ev.combo}`;
    // 退室は reconcile 側で在室Mapから消すため二重発火しない。再入室→再退室を許すため重複排除しない。
    if (ev.kind !== 'leave') {
      const key = `${ev.kind}::${ev.ts || ''}::${ev.nickname || ''}::${ev.userId || ''}::${id}`;
      if (isDuplicate(key)) return;
    }

    // コメントに「〜と呼んで」があれば呼び名を登録
    if (ev.kind === 'chat' && ev.userId != null) {
      const callName = extractCallName(ev.text);
      if (callName && callNames[ev.userId] !== callName) {
        callNames[ev.userId] = callName;
        saveCallNames();
        console.log(`📝 呼び名を登録: ${ev.nickname || ev.userId} → 「${callName}」`);
        enqueueSpeak(`これから ${callName} と呼びますね`);
      }
    }

    const utterance = buildUtterance(ev);
    if (utterance == null) return; // 種別OFF等で読み上げ対象外

    const icon = ev.kind === 'chat' ? '💬'
      : ev.kind === 'heart' ? '🩷'
      : ev.kind === 'join' ? '👋'
      : ev.kind === 'leave' ? '🚪'
      : ev.kind === 'gift' ? '🎁'
      : '🥄';
    console.log(`${icon} ${ev.nickname ? ev.nickname + ': ' : ''}${utterance}`);
    enqueueSpeak(utterance);
  }

  function handlePayload(payload) {
    let objs;
    try { objs = parseFrame(payload); } catch (_) { return; }
    for (const obj of objs) {
      const found = [];
      extractEvents(obj, found);
      for (const ev of found) {
        if (ev.kind === 'meta') { onMemberCount(ev.memberCount); continue; }
        if (ev.kind === 'chat' && !looksLikeChat(ev.text)) continue;
        // 入室は在室登録しておく(即入室即退室でも一覧差分で拾えるように)
        if (ev.kind === 'join' && ev.userId != null) markPresent(ev.userId, ev.nickname);
        emitEvent(ev);
      }
    }
  }

  // ---- 退室検出: リスナー一覧を定期取得し、いなくなった人を「またね」 ----
  let liveId = null;         // 配信の数値ID(/lives/{id}/ から取得)
  let apiOrigin = 'https://jp-api.spooncast.net';
  let authToken = null;      // APIのAuthorizationヘッダ
  const present = new Map();  // 在室中 Map(userId文字列 → nickname)
  let seeded = false;         // 初回スナップショット取得済みか(初回は退室判定しない)
  const listenersUrl = () => (liveId ? `${apiOrigin}/lives/${liveId}/listeners/` : null);

  function parseListeners(json) {
    const arr = Array.isArray(json) ? json
      : json.results || json.listeners
      || (json.data && (json.data.results || json.data.listeners || json.data)) || [];
    const out = [];
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const u = (it && (it.author || it.user)) || it || {};
      const uid = u.id ?? it.id ?? it.userId;
      const nickname = u.nickname ?? it.nickname ?? null;
      if (uid != null) out.push({ id: String(uid), nickname });
    }
    return out;
  }

  const numify = (id) => (/^\d+$/.test(id) ? Number(id) : id);

  // 入室で在室登録(即入室即退室にも対応するため、一覧取得前に記録しておく)
  function markPresent(userId, nickname) {
    if (userId == null) return;
    present.set(String(userId), nickname || present.get(String(userId)) || null);
  }

  // リスナー一覧スナップショットと在室Mapを突き合わせ、いなくなった人を「またね」
  function reconcile(list) {
    const cur = new Map();
    for (const u of list) cur.set(u.id, u.nickname);
    if (DEBUG) logFrame(`[LISTENERS] n=${cur.size} present=${present.size} ids=${[...cur.keys()].join(',')}`);
    if (seeded) {
      // 在室登録されていて今回の一覧に居ない人 = 退室
      for (const [uid, nick] of [...present]) {
        if (!cur.has(uid)) {
          emitEvent({ kind: 'leave', userId: numify(uid), nickname: nick });
          present.delete(uid);
        }
      }
    }
    // 一覧に居る人は在室として反映(名前も更新)
    for (const [uid, nick] of cur) present.set(uid, nick || present.get(uid) || null);
    seeded = true;
  }

  async function pollListeners() {
    const url = listenersUrl();
    if (!url) { if (DEBUG) logFrame('[LISTENERS] liveId未取得'); return; }
    try {
      const json = await page.evaluate(async ({ u, token }) => {
        const tryFetch = async (opts) => {
          try {
            const r = await fetch(u, opts);
            if (!r.ok) return { __status: r.status };
            return await r.json();
          } catch (e) { return { __error: String(e) }; }
        };
        let res = await tryFetch(token ? { headers: { Authorization: token } } : {});
        if (res && (res.__error || res.__status)) {
          const res2 = await tryFetch({});
          if (!(res2 && (res2.__error || res2.__status))) res = res2;
        }
        return res;
      }, { u: url, token: authToken });
      if (json && json.__error) { if (DEBUG) logFrame(`[LISTENERS] fetch error: ${json.__error}`); return; }
      if (json && json.__status) { if (DEBUG) logFrame(`[LISTENERS] HTTP ${json.__status}`); return; }
      const list = parseListeners(json);
      if (DEBUG) logFrame(`[LISTENERS] live=${liveId} n=${list.length} names=${list.map((x) => x.nickname).join(',')}`);
      reconcile(list);
    } catch (e) { if (DEBUG) logFrame(`[LISTENERS] evaluate error: ${e && e.message}`); }
  }

  // 現在のリスナー数(memberCount)が変化したら、少し待ってから一覧をチェック(退室者特定)
  let lastMemberCount = null;
  let pollScheduled = false;
  function onMemberCount(n) {
    if (n == null || n === lastMemberCount) return;
    if (DEBUG) logFrame(`[META] memberCount ${lastMemberCount} -> ${n}`);
    lastMemberCount = n;
    if (!READ_LEAVES || pollScheduled) return;
    pollScheduled = true;
    setTimeout(() => { pollScheduled = false; pollListeners(); }, 1500);
  }

  if (READ_LEAVES) {
    // 各APIリクエストから配信IDと認証トークンを拾う
    context.on('request', (req) => {
      const u = req.url();
      const m = u.match(/^(https?:\/\/[^/]+)\/lives\/(\d+)\//);
      if (m) {
        apiOrigin = m[1];
        const a = req.headers()['authorization']; if (a) authToken = a;
        if (m[2] !== liveId) { liveId = m[2]; seeded = false; present.clear(); pollListeners(); } // 別配信に移ったら在室リセット
      }
    });
    // ポーリングは行わず、memberCount(人型の数値)が変化したタイミングで一覧取得する
  }

  // 空白ページのときだけ配信ページへ遷移(既に配信を開いている場合は触らない)
  try {
    const cur = (page.url() || '');
    if (!cur || cur === 'about:blank' || cur.startsWith('chrome://')) {
      await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    }
  } catch (e) { console.error('ページ読み込みエラー:', e.message); }

  console.log('\nブラウザで配信を開いてください。コメントを検知すると読み上げます。');
  console.log('※ Ctrl+C / q で終了してもブラウザ(配信)は開いたままです。');
  console.log(`読み上げ: ${muted ? 'OFF' : 'ON'} / 音量: ${Math.round(currentVolume * 100)}%`);
  console.log('[スペース or m] オン/オフ, [c] 途中キャンセル, [0-9] 音量(0〜90%), [q]/Ctrl+C 終了\n');

  // 起動アナウンス(ミュート中でも鳴らす)
  if (!muted) forceSpeak('読み上げを開始します。');

  // Chromeが閉じられた/接続が切れたら終了
  if (browser) {
    browser.on('disconnected', () => process.exit(0));
  }

  // 終了処理: ブラウザは閉じない(配信を継続させる)。CDP接続を切るだけ。
  const shutdown = async () => {
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch (_) {}
    console.log('\n読み上げを終了します（配信・ブラウザはそのまま継続します）');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // キーボード操作: スペース/m で読み上げトグル、q/Ctrl+C で終了
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    try { process.stdin.setRawMode(true); } catch (_) {}
    process.stdin.resume();
    process.stdin.on('keypress', (str, key) => {
      if (!key) return;
      if ((key.ctrl && key.name === 'c') || key.name === 'q') { shutdown(); return; }
      if (key.name === 'space' || key.name === 'm') { toggleMute(); return; }
      if (key.name === 'c' && !key.ctrl) { cancelSpeech(); return; } // 途中キャンセル
      // 数字キー 0〜9 で音量を 0.0〜0.9 に設定(0=無音, 5=50%, 9=90%)
      if (str && /^[0-9]$/.test(str)) {
        currentVolume = Number(str) / 10;
        console.log(`🔊 音量: ${Math.round(currentVolume * 100)}%`);
      }
    });
  }
}

main().catch((e) => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
