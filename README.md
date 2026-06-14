# comment-reader

Spooncast のライブ配信に流れてくるコメントを、macOS の音声合成（`say`）で読み上げるツールです。
ユーザー名がある場合は「○○さん。」と読んだうえでコメント本文を読み上げます。

## 仕組み

Playwright で実ブラウザ（Chrome）を起動し、配信ページがやり取りする **WebSocket フレームを傍受**して
コメント（ユーザー名＋本文）を抽出 → 順番にキューイングして `say` で読み上げます。
DOM セレクタに依存しないため、Spoon 側の画面変更に比較的強い作りです。

読み上げ対象は `wss://jp-wala.spooncast.net/ws` に流れる以下の構造のフレームから抽出します:

```
{ "command":"MESSAGE", "payload":{ "body":"<JSON文字列>" }, "timestamp":... }
  body = { "eventName":"...", "eventPayload":{...} }
```

| eventName | 種別 | 読み上げ内容 |
|-----------|------|--------------|
| `ChatMessage` | コメント | 「○○さん。 本文」 |
| `LiveFreeLike` | ハート(無料いいね) | 「○○さん、ハート(×N)」 |
| `LiveItemUse` (effectType=`LIKE`) | アイテム系ハート | 「○○さん、ハート(×N)」 |
| `LiveDonation` | Spoon投げ | 「○○さん、Nスプーン(×M)！(メッセージ)」 |
| `LivePaidLike` | 有料いいね(スタンプ) | 「○○さん、Nスプーン(×M)！」 |
| `RoomJoin` | 入室 | 「○○さんが入室しました」 |

`LiveDonation` / `LivePaidLike` の `eventPayload` は `{ nickname, amount(スプーン数), combo(コンボ数) }`。
`RoomJoin` は `eventPayload.generator.nickname` が入室したユーザー。
将来イベント名が増えた場合に備え、`present`/`spoon`/`sticker`/`gift`/`combo`/`donation` を含む
未知のeventNameもベストエフォートでプレゼント扱いします（`extractEvents()` 内）。

入室通知やランキング更新などのシステムイベントは無視します。
ログイン状態は `.browser-profile/` に保存され、次回以降は維持されます。

## 必要環境

- macOS（`say` コマンドを使用）
- Node.js 18+
- 依存関係のインストール: `npm install`

## 使い方

```bash
# ブラウザを起動 → 自分でログインして見たい配信を開くと、自動でコメントを読み上げ
node index.js

# 配信URLを直接指定して開く
node index.js "https://www.spooncast.net/jp/live/xxxxxxxx"
```

ブラウザのウィンドウを閉じるか `Ctrl+C` で終了します。

## オプション（環境変数）

| 変数 | 既定値 | 説明 |
|------|--------|------|
| `VOICE` | `Kyoko` | 読み上げ音声（`say -v '?'` で一覧確認可） |
| `RATE` | `200` | 話速（語/分） |
| `NO_NICKNAME` | `0` | `1` でユーザー名を読まず本文のみ |
| `NO_HEARTS` | `0` | `1` でハート(無料いいね)を読み上げない |
| `NO_PRESENTS` | `0` | `1` でSpoon投げ/有料いいねを読み上げない |
| `NO_JOINS` | `0` | `1` で入室を読み上げない |
| `MUTE` | `0` | `1` で音声を出さずログ表示のみ |
| `HEADLESS` | `0` | `1` でブラウザ画面を表示しない（ログイン不要な配信の動作確認用） |
| `WS_FILTER` | （空） | 対象 WebSocket の URL 部分一致フィルタ |
| `PROFILE_DIR` | `.browser-profile` | ログイン情報を保存するプロファイルの場所 |
| `DEBUG` | `0` | `1` で受信フレームを表示し `frames.log` / `network.log` に保存 |

例:

```bash
VOICE=Kyoko RATE=230 node index.js
NO_NICKNAME=1 node index.js
MUTE=1 node index.js          # 読み上げず、流れるコメントをログだけ確認
```

## コメントが読み上げられないとき

Spoon の WebSocket メッセージ構造が変わった可能性があります。
配信を開いた状態で次を実行すると、受信フレームが `frames.log` に保存されます。

```bash
DEBUG=1 node index.js
```

コメント送信時のフレーム（`eventName":"ChatMessage"` を含む行）の構造が変わっていれば、
`index.js` の `extractComments()` を実構造に合わせて調整してください。
