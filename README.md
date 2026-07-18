# 日陰ルート提案 PoC

東京・大手町駅周辺(半径300m)で出発地と目的地を指定すると、指定日時の太陽位置から建物の影を推定し、「日陰優先ルート」と「最短距離ルート」を地図上に比較表示するスマートフォン向けWebアプリです。GitHub Pagesでの静的公開を前提としています。

## ローカルでの動かし方

```bash
npm install
npm run dev
```

コマンド実行後に表示されるローカルURL(例: `http://localhost:5173/shade-route/`)にスマートフォンの画面幅(375〜430px程度)でアクセスしてください。ブラウザの開発者ツールでデバイスエミュレーションを使うと確認しやすいです。

## GitHub Pagesへのデプロイ手順

1. ビルドして `gh-pages` ブランチに公開します。

   ```bash
   npm run build
   npm run deploy
   ```

   `npm run deploy` は `predeploy`(`npm run build`)を自動実行したのち、`dist/` の内容を `gh-pages` ブランチにpushします。

2. GitHubリポジトリの **Settings → Pages** を開き、**Source** を `Deploy from a branch`、ブランチを `gh-pages` / `/(root)` に設定します。

3. 数分後に `https://<ユーザー名>.github.io/shade-route/` で公開されます。

   - `vite.config.ts` の `base: '/shade-route/'` はリポジトリ名が `shade-route` であることを前提にしています。フォークしてリポジトリ名を変更する場合はこの値も合わせて変更してください。

## データについて

- `public/data/buildings.geojson`: PLATEAU 千代田区3D都市モデル(建築物データ)由来の建物footprint(ポリゴン)+高さ属性。大手町駅周辺300m以内、68件。
- `public/data/roads.geojson`: OSM Overpass API由来の歩行者道路網(LineString)。664件。

両ファイルとも**ビルド前のローカル作業で事前生成し、リポジトリに同梱**しています。アプリの実行時にPLATEAUやOverpassなど外部APIへは一切アクセスせず、同梱された静的GeoJSONファイルのみを読み込む設計です(GitHub Pagesは静的ホスティングのみのため)。

## 主な機能

- Leaflet + OpenStreetMapタイルによる地図表示、道路網の重畳表示
- `suncalc` による太陽高度・方位角の計算と、それに基づく簡易シャドウポリゴン(建物footprint頂点を太陽と反対方向に投影した凸包)の表示
- ページ読み込み時に「現在の日付・時刻(1時間単位に丸め)」を既定値として影を自動計算。日付・時刻(1時間刻み)は手動でも変更可能で、変更すると影とルートを再計算
- 地図タップで出発地→目的地を指定(タップ地点は最寄りの道路網にスナップ)
- 道路網グラフ上でのDijkstra探索による「最短距離ルート」と、日向区間にペナルティを課した「日陰優先ルート」の比較表示(距離・日陰区間の割合を表示)

## 技術スタック

Vite + TypeScript(素のDOM操作)、Leaflet、SunCalc、Turf.js
