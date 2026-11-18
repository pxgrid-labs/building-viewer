# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install     # 依存はリポジトリルートで一括インストール (pnpm ワークスペース, 初回のみ)
pnpm dev         # 開発サーバ (vite, ポート未固定)
pnpm build       # vite 本番ビルド → dist/
pnpm preview     # ビルド成果物のプレビュー
```

- テストランナー・リンタ・型チェックは未設定。検証は `pnpm build` とブラウザ実機確認で行う。
- Vanilla JS + Vite + Three.js。`vite.config.js` は `base: './'`（他デモと統一）。

## スタック

- **three** `^0.185.1` / **camera-controls** `^3.1.2` / **vite** `^8.2.0`
- エントリは `src/main.js`（単一ファイル）。UI は素の DOM（`index.html` の左上メニュー）。

## ファイル構成

- `src/main.js` — 全ロジック。レンダラ / IBL / GLB ロード / 地面・植栽 / カメラプリセット / メニュー結線。
- `index.html` — canvas + 左上メニュー（プリセット切替ボタン）+ ローディング + 操作ヒント。
- `public/building.draco.glb` — 表示モデル（Draco + WebP 圧縮済み、約 1.5MB）。
- `public/tree.glb` — 植栽（Shapespark Low Poly Plants Kit, CGTrader 無料）。約 210KB。
- `public/env.ktx2` — 環境マップ（HDR / UASTC HDR→BC6H, 約 600KB）。Poly Haven「kloofendal_48d_partly_cloudy_puresky」CC0。
- `public/basis/` — KTX2Loader 用の basis transcoder（`basis_transcoder.js` / `.wasm`）。**KTX2 は DRACO と違い import.meta.url 同梱コンフィグが無い**ため public に置いて `setTranscoderPath()` で参照。
- DRACO デコーダは **public に置かない**。`DRACO_GLTF_CONFIG`（three 同梱・`import.meta.url` 参照）を
  `setDecoderPath()` に渡し、Vite が `dist/assets/` へ自動バンドルする。CDN も手コピーも不要。

## モデル (building.draco.glb)

- **Y-up**。bbox: min `(-17.70, -0.018, -18.10)` / max `(17.68, 70.53, 17.28)`。高さ約 70、幅/奥行 約 35、底面 y≈0。
- 単一メッシュ・単一マテリアル（PBR: baseColor / normal / metallicRoughness）。
- **方位の規約**（コード内で使用）: `+X = 東 / -X = 西 / +Z = 南 / -Z = 北`。**エントランスは +Z（南）面**。
- テクスチャは **baseColor=4096² / normal・MR=1024²、すべて WebP(q80)**。

### 圧縮パイプライン（元は FC1.glb 約 114MB → 1.5MB）

`@gltf-transform/cli`（`npx --yes @gltf-transform/cli`）で作成。手順:
`dedup → prune → resize（baseColor 4096 / それ以外 1024, パターン指定）→ webp → draco`。
- draco は z-fighting 回避のため `--quantize-position 16 --quantize-normal 12 --quantize-texcoord 14`。
- `optimize` 一発は `simplify`/`join` が走り形状破壊・z-fighting を招くため使わない（`glb-compress` スキル参照）。
- グローバル `gltf-transform` shim は Node 18 固定のことがある。`npx --yes @gltf-transform/cli` が安全。

## 環境マップ・シーン

- **IBL**: `KTX2Loader` で `public/env.ktx2`（UASTC HDR / BC6H）を読み、`PMREMGenerator.fromEquirectangular()` → `scene.environment`。
  RGBELoader/`.hdr` からの移行。HDR レンジ維持で 1.4MB→約 600KB。エンコードは Basis Universal:
  ```bash
  brew install basis_universal
  basisu -hdr -mipmap -linear -y_flip env.hdr -output_file public/env.ktx2
  ```
  元 `.hdr` はリポジトリに含めない（再エンコード時は Poly Haven から取得）。
- **背景**: `scene.background = scene.environment`（PMREM を流用）。
  ⚠️ **圧縮テクスチャを直接 `scene.background` にすると空が黒くなる**。three の equirect→cube 変換（`WebGLCubeUVMaps.getCube` → `fromEquirectangularTexture`）が BC6H ソースで黒を返すため。PMREM は正しく読めるのでそれを背景に使って回避。生 `.hdr` なら直接背景に使えるが、圧縮では不可。
- **地面**: 薄緑草色 `0x8faa63` の円盤 `CircleGeometry( 200, 96 )` を `-90°` X 回転で水平化、`y = box.min.y - 0.02`（z-fighting 回避）。
- **植栽**: `tree.glb`（bbox 高さ約4.1 / 底面 y≈0）を建物外周にリング状に `clone()` 配置。位置は小ジッター（整列重視）、Y 回転ランダム、スケール微変動。**エントランス（+Z 南面）正面は通路としてギャップ**を空ける。

## カメラプリセット (`buildPresets` / `moveTo`)

GLB ロード後に bbox からプリセットを算出（`buildPresets(box)`）。メニュー順（`index.html`）:
**俯瞰 / エントランス / 見上げ / 南面 / 東面 / 西面 / 北面**。

### プリセットは「camera-controls を直接呼ぶ関数」

各プリセットは `( enableTransition ) => Promise`（rest で解決）で、`buildPresets` 内で camera-controls のメソッドを直接叩く。
以前の `{ type, pos, tgt }` データ + `moveTo` 内 `type` 分岐は廃止（統一の意味があるのは face のみ）。ファクトリ3種:
- **`lookAt(px,py,pz, tx,ty,tz)`** → `setLookAt`。明示的な pos+tgt が読みやすい **overview**（初期表示・ゆるい3/4）のみ。
- **`orbit(tx,ty,tz, azimuth, polar, distance)`** → `setTarget` + `dollyTo` + `rotateTo`。**entrance / lookup**。
  注視点＋角度＋小さい距離で指定（pos/tgt を分けない）。**返り値に `.fps = true` を付与**（= FPS プリセット）。
- **`face(azimuth)`** → `rotateTo(方位, 90°)` + `fitToBox(box, padding)`。南/東/西/北。
- いずれも各 `*To` 直後に **`normalizeRotations()`** → 蓄積方位を最近傍等価角へ寄せ、常に**最短経路（≤180°）**で回転。

### FPS モード（`preset.fps === true` = entrance / lookup）

カメラと注視点が近接する一人称プリセット。`moveTo` で以下を切替:
- **ドラッグ反転＋低速**: `azimuthRotateSpeed = polarRotateSpeed = 負の小さい値`（負値で上下左右反転＝マウスルック的、絶対値<1 で低速）。非 FPS は `1`。数値は好みで調整中。
- **polar 制限なし**: 底面覗き防止の `maxPolarAngle` を掛けない（真上を越えて自由に見回せる）。
- **距離固定**: `minDistance = maxDistance = distance`。

### moveTo の要点（順序が重要）

1. **移動開始時にロック解除**: `minDistance=DISTANCE_MIN` / `maxDistance=DISTANCE_MAX` / `maxPolarAngle=Math.PI`。
   解除しないと次の遷移が距離・極角でクランプされフレーミングが壊れる。
2. 回転速度（FPS 反転）を設定 → `moveToken`（連打ガード）→ メニュー active 反映 → `await preset( enableTransition )`。
3. await 後トークンが変わっていれば古い移動は何もしない。
4. 完了後のロック:
   - **FPS**: 距離固定＋polar 無制限（上記）。
   - **非 FPS**: 距離制限を緩め、`minDistance = min( boundingSphere.radius, distance )` ～ `maxDistance = distance`（建物の外接球まで寄れる）。
     **底面覗き防止**: `maxPolarAngle = acos( clamp( -target.y / distance, -1, 1 ) )`（`camera.y ≥ 0` を保つ限界）。

## 操作（camera-controls）

- **パン（truck）は無効**: `mouseButtons.right = ACTION.NONE` / `touches.two = TOUCH_DOLLY` / `touches.three = ACTION.NONE`。
- **`dollyToCursor` は無効**（デフォルト false）。ズームは注視点方向へ。
- 操作は回転＋ズームのみ。ヒント文言（`index.html` の `#hint`）も「ドラッグ: 回転　ホイール / ピンチ: ズーム」に更新済み。

## 注意事項

- **Draco デコーダの渡し方（three.js 推奨・0.185+）**:
  `import { DRACOLoader, DRACO_GLTF_CONFIG } from '.../DRACOLoader.js'` → `dracoLoader.setDecoderPath( DRACO_GLTF_CONFIG )`。
  `setDecoderPath` は文字列パスと `{ js, wasm }` config オブジェクトの両対応で、`DRACO_GLTF_CONFIG` は後者。
  `import.meta.url` で同梱デコーダ（`libs/draco/gltf/`）を指すため Vite が自動バンドル。
  → **CDN（gstatic）や `public/draco` 手コピー、`vite-plugin-static-copy` はいずれも不要**（walk-through デモと同方式）。
  設定し忘れるとモデルが読めない。WebP テクスチャ（`EXT_texture_webp`）は three ネイティブ対応で追加設定不要。
- 非推奨の `THREE.Clock` は使わず **`Timer`**（three 本体から `import { Timer } from 'three'`）を使用。
- `favicon.ico` の 404 はブラウザ自動要求で無害。
