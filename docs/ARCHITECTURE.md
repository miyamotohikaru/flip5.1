# 数式の絶景（MATHSCAPE）— 設計契約書

こす.くまの「ふりっぷ」シリーズの1本。**画像・3Dモデル・音声ファイルを1つも使わず、
数式（コード）だけで AAA 級の一人称風景を描く**。訪れた人が「裏返す」と、風景が数式の姿に
なって、本当に素材ゼロだと確かめられる。制作: こす.くま × Claude Fable 5.1。

- 本番 URL（予定）: https://flip5.1.vercel.app/
- 技術: Next.js 16 (App Router) + TypeScript + three.js r185（WebGL2、R3F は使わない）
- 品質の物差し: **Red Dead Redemption 2 / Horizon / 最近の Call of Duty の屋外シーン**。
  批評エージェントが「AAA のスクリーンショットと並べて見分けがつくか」を採点する。

## 絶対のルール

1. **素材ゼロ。** `public/` に画像・モデル・音声・フォントを置かない。`fetch` で外から取らない。
   テクスチャは全て実行時に GLSL / Canvas / TypedArray で生成する。音は WebAudio の合成だけ。
   （例外: ファビコンとOG画像だけは「風景の外」なので置いてよい。それ以外は禁止）
2. **決定的。** 世界の生成に `Math.random` を使わない。`core/noise.ts` の `hash2` / `noise2` か、
   GLSL の `flip_hash*` を使う。同じ URL は誰が開いても同じ風景になる。
3. **自分の担当フォルダの外を勝手に書き換えない。** `src/engine/core/` への変更は
   「追加のみ」「既存の関数の意味を変えない」を守り、報告に必ず書く。他モジュールの中身は触らない。
   どうしても必要なら、報告書に「core にこう足してほしい」と書く（統合担当が反映する）。
4. **高さは1つの真実から。** 地形の高さは CPU では `heightAt(x, z)`、GPU では `flip_height(xz)`
   （ハイトマップ）だけを使う。地形シェーダで頂点を勝手に上下させない（草・木・水・当たり判定が全部ずれる）。
5. **消さない・戻さない。** 既存の機能を壊す変更は禁止。困ったら報告書に書く。
6. **動く状態で終える。** `npm run typecheck` と `npm run build` が通り、`node tools/shoot.mjs` で
   全定点が撮れ、コンソールに WebGL のエラー／警告が出ないこと。
7. **自分の目で確かめる。** 変更のたびに `tools/shoot.mjs` で撮って、画像を Read して見る。
   「たぶん動く」で終えない。携帯（`--mobile`）も撮る。

## 動かし方

```
npm ci                      # 初回だけ
npm run dev                 # http://localhost:3051 （worktree では --port を変える。下記）
npm run typecheck
npm run build
node tools/shoot.mjs <名前> --shot golden        # 定点1枚 → shots/<名前>.png
node tools/shoot.mjs <名前> --all                 # 全定点
node tools/shoot.mjs <名前> --url "/?t=6&w=mist&pos=0,400&look=20,5"
node tools/shoot.mjs <名前> --shot golden --mobile  # iPhone 相当
FLIP_URL=http://localhost:3052 node tools/shoot.mjs ...   # 別ポートのサーバーを撮る
node tools/shotjs.mjs <名前> --url "/?shot=golden" --js "window.__flip.water.mesh.visible=false"   # 任意の JS を流してから撮る（切り分け用）
node tools/perf.mjs                               # 負荷計測: high で 10 秒歩き回り、frameMs／実効 fps／calls／tris／メモリの表
node tools/perf.mjs --q mid                       # 段階を指定（mid = iPhone の負荷値の代用）
node tools/perf.mjs --mobile                      # iPhone 相当（390×844 @3、UA も iPhone）
node tools/perf.mjs --seconds 20 --flip --url "/?t=12&w=rain"   # 秒数／途中で裏返す／任意 URL。--json で JSON も
```

`tools/perf.mjs` は「rAF の間隔」で実効 fps を出す（CPU 側の frameMs は GPU の待ちを含まないので、
重さは rAF 間隔の方を見る）。`window.__flip.controls` にキー状態を注入して W → 旋回 → 走り → 後退 → 横歩きを行う。
統合後の負荷確認はこれで行い、high の rAF 間隔 95% が 16.7ms、mid が 33ms を超えないことを目安にする。

worktree で作業するときは `npx next dev --turbopack --port 30XX` で自分専用のポートを使い、
`FLIP_URL` でそのポートを撮る。`node_modules` は本体から**複製**する
（`cp -Rc /Users/miyamotohikaru/13dev_flip5.1/node_modules node_modules`。APFS のクローンなので数秒・容量ほぼゼロ）。
**symlink は Turbopack が「ルートの外を指す」と拒否する**ので使わない。

URL パラメータ（`src/engine/core/params.ts`）:
`?auto=1` 入口を飛ばす ／ `?nohud=1` ／ `?freeze=1` 時間停止 ／ `?t=17.5` 時刻 ／
`?w=clear|cloudy|mist|rain|storm` ／ `?pos=x,z[,y]` ／ `?look=yaw,pitch`（度）／
`?flip=1&flipr=300` 裏返しの波の半径 ／ `?q=low|mid|high|ultra` ／ `?shot=<定点名>` ／
`?stats=1` 負荷表示 ／ `?dbg=noref,nocopy,notrans,nopost` 段階を飛ばす（調査用）／
`?seed=12345` 世界のシード（既定 20271337 ＝ 今の谷）／ `?lab=1` 実験室を開いて始める ／
`?p=terrain.amp:1.4,sky.mie:2` 実験室のつまみ（`src/engine/lab/params.ts`）。

### シード（`core/seed.ts`）
**全部の乱数はひとつの数から生える。** `setSeed(n)` / `getSeed()` / `subSeed(用途)` / `seedOffset(用途, i)`。
用途は terrain（地形の置換表・角度の表）/ noise（共通ノイズの置換表）/ place（配置のハッシュの塩）/
sky（雲の天気マップ）/ water（波のスペクトル）/ audio（音の乱数）。
**`seedOffset()` は既定のシードでは 0 を返す**ので、手で置いたノイズの定数に足しても今の絵は変わらない。
シードは `core/seed.ts` の読み込み時に URL から決まる（`core/params.ts` が module scope で `startPosition()` を
呼ぶより先でないといけない）。Worker には `controls/bake.ts` が毎回 `seed` と地形のつまみを渡す。

定点（`SHOTS`）: golden / noon / dawn / cloudy / rain / storm / night / sunset_water / forest / ridge /
flip_half / flip_full。批評はこの12枚＋携帯2枚で行う。

## 世界

- 座標: three.js（Y up、メートル）。原点＝湖の中心。湖面 y=0。ハイトマップは 4096m 四方。
- プレイヤーは南岸（+Z）から北（−Z）を向いて始まり、湖越しに山脈を見る。
- 太陽: 6時 東(+X) → 12時 南(+Z、背中側) → 18時 西(−X)。`Env.sunDirection(hour)`。
- 標高の目安: 湖 0 / 岸の草地 1〜10 / 針葉樹の斜面 10〜400 / 岩 300〜 / 雪 450〜 / 最高 ~700。
- 歩ける半径 1500m（`WORLD.walkRadius`）。

## モジュールと担当（`src/engine/`）

| フォルダ | 役割 | 状態 |
|---|---|---|
| `core/` | Env（時刻・天気・裏返し・共有 uniforms）、ハイトマップ、GLSL チャンク、パイプライン、CSM 影、品質段階、URL | 土台済み（統合担当が管理） |
| `sky/` | 大気散乱（空の色・空気遠近）、体積雲、太陽・月・星、時刻による光の色、半球光、環境マップ | 土台のみ |
| `terrain/` | 地形メッシュ（クリップマップ）、地面の材質（岩・草・雪・砂・濡れ）、裏返し表現 | 土台のみ |
| `water/` | 湖（映り込み・屈折・波・岸の泡・雨の波紋・水中）、裏返し表現 | 土台のみ |
| `vegetation/` | 草（GPU配置・風・影）、針葉樹（LOD・インポスター・風）、岩・小石、裏返し表現 | 空 |
| `weather/` | 雨（筋・しぶき・波紋）、霧のむら、稲光、花粉・蛍・埃、風の見え方 | 空 |
| `post/` | HDR→ブルーム→ゴッドレイ→SMAA→AO→被写界深度→色調→粒子→写真モード | 土台のみ |
| `audio/` | WebAudio 合成: 風・雨・雷・波・足音・鳥・虫・環境音・UI 音・裏返しの音 | 空 |
| `controls/` | 一人称操作、タッチ、負荷に応じた動的解像度、性能監視 | 土台のみ |
| `src/components/` | 入口・HUD・裏返しの数式オーバーレイ・写真モード UI・読み込み画面 | 土台のみ |

## 契約（全員が守る API）

### Env（`core/env.ts`）
毎フレーム `env.update(dt)` が呼ばれ、`env.uniforms` に反映される。**全マテリアルは `env.uniforms` を
同じ参照で持つ**（`bindEnvUniforms(uniforms, env)` か `patchMaterial(...)` を使う）。

| uniform | 型 | 意味 |
|---|---|---|
| `uTime` | float | 経過秒（freeze で停止） |
| `uHour` | float | 時刻 0..24 |
| `uSunDir` / `uSunColor` | vec3 | 太陽の向き（光の来る方向、正規化）／放射輝度（強さ込み・雲で減衰済み） |
| `uMoonDir` / `uMoonColor` | vec3 | 月 |
| `uSkyAmbient` / `uGroundAmbient` | vec3 | 半球光（空モジュールが更新） |
| `uCamPos` | vec3 | カメラ位置 |
| `uFlip` / `uFlipCenter` / `uFlipRadius` | float / vec3 / float | 裏返し（0..1、波の中心、波の半径 m。6000 で全域） |
| `uWind` | vec3 | xy = 風向（正規化）、z = 風速 m/s |
| `uWetness` `uRain` `uFog` `uCloud` `uStorm` | float | 天気 0..1 |
| `uExposure` | float | 露出 |
| `uHeightmap` / `uHeightmapInfo` | sampler2D / vec4 | ハイトマップ（R32F）／(worldSize, 1/worldSize, res, maxHeight) |
| `uLakeLevel` | float | 湖面の高さ |

CPU 側: `env.hour` `env.weather` `env.sunDir` `env.sunColor` `env.sunIntensity` `env.flip` `env.flipRadius`
`env.cameraPos` `env.tier` `env.isMobile` `env.heightmap`。

### GLSL チャンク（`core/chunks.ts` が登録。`#include <...>` で使う）
- `flip_noise`: `flip_hash11/12/13/22/33`, `flip_vnoise(vec2|vec3)`, `flip_gnoise(vec2)`, `flip_snoise(vec3)`,
  `flip_fbm(vec2|vec3, int oct)`, `flip_vfbm(vec2, int)`
- `flip_height`: `float flip_height(vec2 xz)`, `vec3 flip_terrainNormal(vec2 xz, float eps)`
- `flip_atmosphere`: `vec3 flip_skyColor(vec3 dir)`, `vec4 flip_aerial(vec3 worldPos)`（rgb=散乱光, a=透過率）,
  `vec3 flip_applyAerial(vec3 color, vec3 worldPos)`。**全マテリアルは最終色に必ず `flip_applyAerial` を通す**
  （MeshStandardMaterial なら `#include <fog_fragment>` を差し替える）。空モジュールが本体を差し替える
  （`overrideChunk("flip_atmosphere", src)`）。差し替え後も関数名と引数は変えない。
- `flip_flip`: `float flip_mask(vec3 worldPos)`（0=普通,1=数式ビュー）, `flip_edgeGlow`, `flip_line(v, w)`,
  `flip_grid(xz, s)`, 定数 `FLIP_BG`（青黒い紙）`FLIP_LINE`（白青の線）`FLIP_ACCENT`（橙）。
  **数式ビューは「青黒い紙に細い線」で統一**。各モジュールは自分の正体（等高線・波の関数・木の骨組み・
  粒子の座標点・散乱の等値線）を線で描き、`color = mix(color, mathColor, flip_mask(worldPos))` で混ぜる。

### マテリアル
- MeshStandardMaterial を使うものは `patchMaterial(mat, env, hook, { csm: lighting, key })`（`core/patch.ts`）。
  hook の中で `replaceOnce(shader.fragmentShader, "#include <xxx>", "...")` で差し替える。
  影を受けるなら `csm` を渡す（CSM の onBeforeCompile と連結される）。
- 頂点を動かす（風で揺れる草・木）なら `mesh.customDepthMaterial` にも同じ変位を入れて影を合わせる。
- ShaderMaterial は `bindEnvUniforms(uniforms, env)` で共有 uniforms を持つ。
- **GLSL は three.js の既定記法**（`varying` / `texture2D` / `gl_FragColor`）。`glslVersion: GLSL3` は使わない
  （`#include <tonemapping_fragment>` などが壊れる）。

### レイヤーと描画順（`core/pipeline.ts`）
```
LAYER.OPAQUE(0)  不透明（既定）        → sceneRT
LAYER.SKY(3)     空（不透明の最後）    → sceneRT
LAYER.MAIN_ONLY(5) 草・小石・粒子など、映り込みに出さないもの（主カメラと影だけが見る）
--- copyScene: sceneRT → copyRT(色) / copyDepthRT(線形深度 R32F)
LAYER.WATER(1)   水面                  → sceneRT（copyRT/copyDepthRT を読める）
LAYER.TRANSPARENT(2) 雨・粒子など      → sceneRT（水の後）
--- post: sceneRT → 画面
```
映り込み（`water.renderReflection`）は OPAQUE+SKY を鏡像カメラで描く。MAIN_ONLY は映らない。
`renderer.toneMapping = AgX`。RT へ描く間はトーンマップされない（線形 HDR）。画面へ出す最後のパスで掛かる。

### 品質段階（`core/quality.ts`）
`env.tier` = low / mid / high / ultra。各モジュールは `q`（QualitySettings）を見て負荷を落とす。
**フレーム予算（high、1600×900、M4 Pro 相当）: 合計 12ms 以下。** 目安: 空+雲 2.5 / 地形 2 /
水（映り込み込み） 2.5 / 植生 3.5 / 天気 1 / ポスト 2.5。mid（iPhone）は合計 28ms 以下で 30fps。
`?stats=1` で `frameMs / calls / tris` が出る。`tools/shoot.mjs` の出力にも出る。

### 裏返し（この作品の芯）
`F` キー／「裏返す」ボタンで `env.flipTarget` が 1 になり、`uFlipRadius` がプレイヤーを中心に
900m/s で広がる（縁は `flip_edgeGlow` で橙に光る）。波が通った場所は数式ビューになる。
もう一度押すと縮んで戻る。**どのモジュールも「自分の正体を線で見せる」表現を持つこと。**

## 報告書の書き方（各担当がタスク終了時に返すもの）
1. 何を作ったか（箇条書き）／どのファイルを触ったか
2. 見た目の確認: 撮った画像のパス（`shots/`）と、自分で見つけた欠点・残課題
3. 負荷: high と mid の frameMs
4. core への要望（あれば）
5. 統合時の注意（他モジュールとぶつかりそうな点）

## 訪れる人の端末を重くしない（作者の指示・2026-09-03）

**この作品は「見に来た人の端末で軽く動く」ことを品質の一部とする。** 見た目のためにここを崩さない。

### 守る数値（本番ビルドで測る。`npm run build` → `npx next start --port 3070` → `FLIP_URL=http://localhost:3070 node tools/perf.mjs`）
| | 目標 | 落第 |
|---|---|---|
| 実効 fps（high・1600×900） | 60 | 45 を下回る |
| 実効 fps（mid・iPhone 相当） | 60（最低 30） | 30 を下回る |
| CPU の frameMs（95%） | 3ms 以下 | 8ms 超 |
| 描画呼び出し | high 130 / mid 110 以下 | 200 超 |
| 三角形 | high 130万 / mid 50万 以下 | high 200万 超 |
| 起動（入場できるまで） | 2 秒以下 | 4 秒超 |
| 配信 JS（gzip 後・合計） | 600KB 以下 | 900KB 超 |
| JS ヒープ | high 200MB / mid 80MB 以下 | 400MB 超 |
| GPU テクスチャ | high 100 枚以下 | 150 枚超 |

**2026-09-03 の実測（本番ビルド・M4 Pro）**: high 57.5fps / CPU 2.6ms(95%) / 119 calls / 121万 tris / 起動 1.3s、
mid 60.1fps / CPU 2.2ms / 98 calls / 47万 tris / ヒープ 43MB、JS は gzip 後 0.5MB。**現状は基準を満たしている。**

### やってはいけないこと
- **毎フレームの DOM 更新**（React の state を毎フレーム更新しない。100〜500ms に間引く）
- **画面全体にかかる SVG フィルタを毎フレーム再計算する**（`feTurbulence` は面積に比例して重い。
  一度描いたら畳む、小さなタイルで作って敷き詰める、`will-change` を貼りっぱなしにしない）
- **解像度に比例する処理を増やす**（ポスト処理のパスを足す前に、既存のパスに相乗りできないか考える）
- **常時走る `setInterval`**（rAF に相乗りするか、必要なときだけ動かす）
- **タブが隠れている間も回し続ける**（`visibilitychange` で止める。実装済み）
- **端末を選ばない一律の重さ**（`q.tier` を見て段階的に落とす。low では機能ごと切ってよい）

### 新しい機能を足すときの手順
1. 足す前に `node tools/perf.mjs` で現状を測る
2. 足したあとに同じ条件で測り、**差分**を報告に書く
3. 上の表を超えたら、超えた分を必ず削る（機能を諦めるか、段階を落とす）
