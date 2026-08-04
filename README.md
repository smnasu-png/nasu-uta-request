# 照瑚なす 歌のリクエスト表 🍆

歌枠で歌った曲を **1曲1行** にまとめた、リスナーのリクエスト用リストです。

**▶ 公開ページ: https://smnasu-png.github.io/nasu-uta-request/**

- 同じ曲は1つに集約（表記ゆれ・タイポも統合）し、歌った回数を表示
- 曲名・アーティストで検索、🍆おすすめ／定番／レア曲フィルタ
- 「コピー」ボタンでリクエスト文をコピー → 配信チャットに貼るだけ
- 各曲から過去の歌唱アーカイブ（タイムスタンプ付き）へ直接ジャンプ
- `songs.csv` でスプレッドシートとしても利用可能

## データ元

[照瑚なすさん歌みた検索](https://arnie-pj.github.io/nasu-utamita/)（created by ani さん）の
タイムスタンプ記録（[arnie-pj/nasu-utamita](https://github.com/arnie-pj/nasu-utamita) の `database`）を利用しています。

毎日 06:00 JST に GitHub Actions が元データの更新を取り込みます（`.github/workflows/update.yml`）。

## 仕組み

| ファイル | 役割 |
|---|---|
| `database` | 元データのスナップショット（ani さんのリポジトリから取得） |
| `scripts/build.mjs` | パース → 表記ゆれ統合 → 検証アサーション → `data.js` / `songs.csv` 生成 |
| `scripts/fetch_titles.mjs` | 動画タイトルを noembed.com から取得（キャッシュ済みはスキップ） |
| `video_titles.json` | 動画タイトルのキャッシュ |
| `index.html` | ページ本体（静的・依存なし） |

手動更新する場合:

```bash
curl -fsSL https://raw.githubusercontent.com/arnie-pj/nasu-utamita/main/database -o database
node scripts/fetch_titles.mjs
node scripts/build.mjs
```

`build.mjs` は集計の整合性チェック（タイムスタンプ行の完全な収支・重複キー検出など）に失敗すると exit 1 で止まります。
