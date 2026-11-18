# building-viewer

Draco + WebP で圧縮した建物モデルを three.js で表示し、camera-controls で操作するビューア。
左上メニューから俯瞰・エントランス・見上げ・東西南北の各面へ、カメラをプリセット位置へ移動できる。

## Live demo

[Open the Building Viewer on GitHub Pages](https://pxgrid-labs.github.io/building-viewer/)

## モデル

建物「FANTASY ART DECO ARCHITECTURE CLASSIC 01」
https://www.cgtrader.com/free-3d-models/exterior/sci-fi-exterior/fantasy-art-deco-architecture-classic-01
https://www.cgtrader.com/items/6602546/download-page

- 配布モデル（`FC1.glb` 約 114MB）を `@gltf-transform/cli` で圧縮し、`public/building.draco.glb`（約 1.5MB）として同梱。
- 圧縮内容: テクスチャを WebP 化（baseColor 4096² / normal・metallicRoughness 1024²）、ジオメトリを Draco 圧縮。

### 植栽（`public/tree.glb`）

建物の周囲に配置している樹木。
「Shapespark Low Poly Plants Kit」より。
https://www.cgtrader.com/free-3d-models/plant/bush/shapespark-low-poly-plants-kit-free-low-poly-3d-model

### 環境マップ（`public/env.ktx2`）

PBR ライティング（IBL）と背景に使用している全天球 HDRI。
Poly Haven（CC0）より。
https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky

- 配布 HDRI（1024×512 の `.hdr`, 約 1.4MB）を Basis Universal で **UASTC HDR 4x4 → KTX2**（BC6H 相当）に圧縮し、`public/env.ktx2`（約 600KB）として同梱。HDR のダイナミックレンジを保ったまま軽量化。
- 元 `.hdr` はリポジトリに含めない（サイズ削減のため）。再エンコードは上記リンクから HDRI を取得して:
  ```bash
  brew install basis_universal
  basisu -hdr -mipmap -linear -y_flip env.hdr -output_file public/env.ktx2
  ```
- 読み込みは `KTX2Loader`。basis transcoder は `import.meta.url` 参照の同梱コンフィグが無いため `public/basis/`（`basis_transcoder.js` / `.wasm`）に配置し `setTranscoderPath()` で参照。
- 背景は `scene.environment`（PMREM）を流用。three の equirect→cube 変換は圧縮テクスチャで空が黒くなるため、PMREM 済みの環境を背景に使って回避している。
