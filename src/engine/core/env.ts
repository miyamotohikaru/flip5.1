// 世界の状態。時刻・太陽・天気・「裏返し」の進み具合。
// 全モジュールはここを読む。全マテリアルは env.uniforms を共有する（同じオブジェクト参照）。
import * as THREE from "three";
import { clamp, fbm2, smoothstep } from "./noise";
import { WORLD, type Heightmap } from "./heightfield";

export type WeatherPresetName = "clear" | "cloudy" | "mist" | "rain" | "storm";

export type Weather = {
  /** 雲量 0..1 */
  cloud: number;
  /** 雨の強さ 0..1 */
  rain: number;
  /** 霧の濃さ 0..1（アトモスフィアの基準密度への倍率に使う） */
  fog: number;
  /** 風速 m/s */
  wind: number;
  /** 風向（xz 平面、正規化） */
  windDir: THREE.Vector2;
  /** 濡れ 0..1（雨のあとにゆっくり乾く） */
  wetness: number;
  /** 嵐 0..1（雷・強風・暗い空） */
  storm: number;
  /** 突風 0..1（時間ノイズ。風速が強いほど激しい。天気モジュールが定義、Env.update が毎フレーム計算） */
  gust: number;
};

/** 稲光の状態（天気モジュールが毎フレーム更新。音・空・地形が読む） */
export type Lightning = {
  /** 閃光 0..1（0→1→減衰。複数ストロークでちらつく） */
  flash: number;
  /** 直近の落雷の時刻（env.time 秒）。まだ無ければ -1e9 */
  lastStrikeTime: number;
  /** 落雷地点（world、y は地面）。稲妻の上端は position.y + cloudHeight */
  position: THREE.Vector3;
  /** 落雷の通し番号（新しい落雷で +1。音担当はこれの変化で雷鳴を鳴らす） */
  strikeIndex: number;
  /** 稲妻の上端（雲底）の高さ（world y） */
  cloudHeight: number;
};

export const WEATHER_PRESETS: Record<WeatherPresetName, Omit<Weather, "windDir" | "wetness" | "gust">> = {
  clear: { cloud: 0.18, rain: 0, fog: 0.22, wind: 2.0, storm: 0 },
  cloudy: { cloud: 0.62, rain: 0, fog: 0.35, wind: 3.5, storm: 0 },
  mist: { cloud: 0.4, rain: 0, fog: 1.0, wind: 0.8, storm: 0 },
  rain: { cloud: 0.85, rain: 0.7, fog: 0.6, wind: 5.0, storm: 0.15 },
  storm: { cloud: 1.0, rain: 1.0, fog: 0.7, wind: 11.0, storm: 1 },
};

export type QualityTier = "low" | "mid" | "high" | "ultra";

export class Env {
  /** 時刻（0〜24 時） */
  hour = 17.35;
  /** 時刻の自動進行（実時間1秒あたり何時間進むか）。0 で停止。 */
  hourSpeed = 0;
  /** 経過秒（アニメーション用。freeze 中は止まる） */
  time = 0;
  /** 何フレーム目か */
  frame = 0;
  freeze = false;

  weather: Weather = {
    ...WEATHER_PRESETS.clear,
    windDir: new THREE.Vector2(1, 0.25).normalize(),
    wetness: 0,
    gust: 0,
  };
  /** 天気の目標（プリセット切替はここに入れて、update で滑らかに寄せる） */
  weatherTarget: Omit<Weather, "windDir" | "wetness" | "gust"> = { ...WEATHER_PRESETS.clear };
  /** 稲光（天気モジュールが更新） */
  lightning: Lightning = { flash: 0, lastStrikeTime: -1e9, position: new THREE.Vector3(), strikeIndex: -1, cloudHeight: 700 };

  /** 裏返し 0..1。flipRadius は「数式の波」が広がった半径（m） */
  flip = 0;
  flipTarget = 0;
  flipRadius = 0;
  flipCenter = new THREE.Vector3();

  /** 太陽（方向は「太陽のある向き」＝光の来る向き）。色は放射輝度（強さ込み） */
  sunDir = new THREE.Vector3(0, 1, 0);
  sunColor = new THREE.Color(1, 1, 1);
  sunIntensity = 1;
  /** 月 */
  moonDir = new THREE.Vector3(0, -1, 0);
  moonColor = new THREE.Color(0.6, 0.7, 1.0);
  moonIntensity = 0;
  /** 空の平均色（半球ライトの目安）。空モジュールが毎フレーム更新する */
  skyAmbient = new THREE.Color(0.4, 0.55, 0.8);
  groundAmbient = new THREE.Color(0.2, 0.18, 0.14);
  /** 露出（トーンマップの前段） */
  exposure = 1.0;

  camera = new THREE.PerspectiveCamera(72, 1, 0.08, 9000);
  cameraPos = new THREE.Vector3();

  tier: QualityTier = "high";
  isMobile = false;
  heightmap!: Heightmap;
  /** 水中 0..1（カメラが湖面より下）。水モジュールが毎フレーム更新する。ポスト（水中の霧）・音などが読む */
  underwater = 0;

  /** 全マテリアルで共有する uniforms。参照を渡すこと（コピーしない）。 */
  uniforms = {
    uTime: { value: 0 },
    uHour: { value: 17.35 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonColor: { value: new THREE.Color(0, 0, 0) },
    uSkyAmbient: { value: new THREE.Color() },
    uGroundAmbient: { value: new THREE.Color() },
    uCamPos: { value: new THREE.Vector3() },
    uFlip: { value: 0 },
    uFlipCenter: { value: new THREE.Vector3() },
    uFlipRadius: { value: 0 },
    /** xy = 風向, z = 風速 */
    uWind: { value: new THREE.Vector3(1, 0, 2) },
    uWetness: { value: 0 },
    uRain: { value: 0 },
    uFog: { value: 0.22 },
    uCloud: { value: 0.18 },
    uStorm: { value: 0 },
    /** 突風 0..1（uWind.w 相当。植生・水・雨が揺れの強弱に使う） */
    uGust: { value: 0 },
    /** 稲光の閃光 0..1（空・地形・霧が一瞬白くなる） */
    uLightning: { value: 0 },
    /** 落雷地点（world、y は地面） */
    uLightningPos: { value: new THREE.Vector3(0, 0, 0) },
    uExposure: { value: 1 },
    /** 地形ハイトマップ。xyzw = (worldSize, 1/worldSize, res, maxHeight) */
    uHeightmap: { value: null as THREE.Texture | null },
    uHeightmapInfo: { value: new THREE.Vector4(WORLD.size, 1 / WORLD.size, 1024, WORLD.maxHeight) },
    uLakeLevel: { value: WORLD.lakeLevel },
    /** 水中 0..1（水モジュールが更新） */
    uUnderwater: { value: 0 },
    /**
     * 地形担当が起動時に GPU で焼く補助テクスチャ（RGBA8、texel の対応は uHeightmap と同じ）:
     * rg = 法線 xz（0..1 に符号化）, b = 空の見え方（AO, 谷底で小さい）, a = 谷筋の陰（cavity, 0.5 = 平ら）。
     * flip_height チャンクの flip_terrainNormalBaked / flip_terrainAO / flip_terrainCavity で読む。
     */
    uTerrainAux: { value: null as THREE.Texture | null },
    /**
     * 地平角マップ（RGBA8 × 2、1024²）: 8方位（+X から +Z 回りに 45° 刻み。A = 0..3, B = 4..7）の
     * 地平の仰角 / (π/2)。flip_terrainSunVis(xz, dir) で「山の影」（太陽・月がその地点から見えるか）を出す。
     * 地形・木・草・水など、どのモジュールも使ってよい。
     */
    uTerrainHorizonA: { value: null as THREE.Texture | null },
    uTerrainHorizonB: { value: null as THREE.Texture | null },
    /** 高さの3成分（heightfield.ts の Heightmap.parts）。裏返しの「数式の足し算」表示に使う */
    uHeightParts: { value: null as THREE.Texture | null },
  };

  setWeather(name: WeatherPresetName) {
    this.weatherTarget = { ...WEATHER_PRESETS[name] };
  }

  /** 太陽の位置を時刻から出す。6時 東(+X) → 12時 南(+Z) → 18時 西(−X)。 */
  static sunDirection(hour: number, out: THREE.Vector3): THREE.Vector3 {
    const phi = ((hour - 6) / 12) * Math.PI;
    const maxElev = (63 * Math.PI) / 180;
    const elev = maxElev * Math.sin(phi);
    // 南中時に少し傾け、真上を通らないようにする
    const az = phi;
    out.set(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az) * 0.85 + 0.15 * Math.cos(elev));
    return out.normalize();
  }

  update(dt: number) {
    if (!this.freeze) {
      this.time += dt;
      this.frame++;
      if (this.hourSpeed !== 0) this.hour = (this.hour + this.hourSpeed * dt + 24) % 24;
    }
    // 天気を目標へ寄せる
    const w = this.weather, t = this.weatherTarget;
    const k = 1 - Math.exp(-dt * 0.6);
    w.cloud += (t.cloud - w.cloud) * k;
    w.rain += (t.rain - w.rain) * k;
    w.fog += (t.fog - w.fog) * k;
    w.wind += (t.wind - w.wind) * k;
    w.storm += (t.storm - w.storm) * k;
    // 濡れ: 雨で速く濡れ、ゆっくり乾く
    const wetTarget = clamp(w.rain * 1.4, 0, 1);
    const wk = wetTarget > w.wetness ? 1 - Math.exp(-dt * 0.5) : 1 - Math.exp(-dt * 0.03);
    w.wetness += (wetTarget - w.wetness) * wk;
    // 突風: 時間のノイズ 0..1。風速が強いほど激しく、速く（嵐では更に速い）。決定的（time だけの関数）
    {
      const t = this.time * (0.22 + 0.25 * w.storm);
      const n = fbm2(t, 13.7, 3) * 2.4; // おおよそ [-1, 1] を広げる
      const raw = clamp(0.5 + 0.5 * n, 0, 1);
      const strength = smoothstep(1.0, 12.0, w.wind);
      w.gust = raw * strength;
    }

    // 裏返し: 目標へ寄せつつ、半径を広げる／縮める
    const fk = 1 - Math.exp(-dt * 3.5);
    this.flip += (this.flipTarget - this.flip) * fk;
    const targetRadius = this.flipTarget > 0.5 ? 6000 : 0;
    const speed = 900; // m/s で「数式の波」が広がる
    if (!this.freeze) {
      if (this.flipRadius < targetRadius) this.flipRadius = Math.min(targetRadius, this.flipRadius + speed * dt);
      else if (this.flipRadius > targetRadius) this.flipRadius = Math.max(targetRadius, this.flipRadius - speed * 1.6 * dt);
    }

    // 太陽・月
    Env.sunDirection(this.hour, this.sunDir);
    const s = this.sunDir.y;
    // 高度による色。（空モジュールが上書きしてよい）
    const warm = new THREE.Color(1.0, 0.45, 0.14);
    const white = new THREE.Color(1.0, 0.96, 0.9);
    this.sunColor.copy(warm).lerp(white, smoothstep(-0.02, 0.32, s));
    this.sunIntensity = 4.5 * smoothstep(-0.06, 0.12, s) * (1 - 0.65 * this.weather.cloud) * (1 - 0.5 * this.weather.storm);
    this.moonDir.set(-this.sunDir.x, -this.sunDir.y * 0.8 + 0.1, -this.sunDir.z).normalize();
    this.moonIntensity = 0.08 * smoothstep(0.0, 0.2, this.moonDir.y) * smoothstep(0.05, -0.1, s);

    // 露出（昼は絞り、夜は開く）
    const dayness = smoothstep(-0.12, 0.25, s);
    this.exposure = THREE.MathUtils.lerp(3.2, 0.85, dayness);
    this.syncUniforms();
  }

  /**
   * フィールド → uniforms。update() の最後に呼ばれる。
   * 空モジュールが sunColor / sunIntensity / exposure / skyAmbient を上書きしたあとにも呼ぶ（world.ts）。
   */
  syncUniforms() {
    const w = this.weather;
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uHour.value = this.hour;
    u.uSunDir.value.copy(this.sunDir);
    u.uSunColor.value.copy(this.sunColor).multiplyScalar(this.sunIntensity);
    u.uMoonDir.value.copy(this.moonDir);
    u.uMoonColor.value.copy(this.moonColor).multiplyScalar(this.moonIntensity);
    u.uSkyAmbient.value.copy(this.skyAmbient);
    u.uGroundAmbient.value.copy(this.groundAmbient);
    u.uCamPos.value.copy(this.cameraPos);
    u.uFlip.value = this.flip;
    u.uFlipCenter.value.copy(this.flipCenter);
    u.uFlipRadius.value = this.flipRadius;
    u.uWind.value.set(w.windDir.x, w.windDir.y, w.wind);
    u.uWetness.value = w.wetness;
    u.uRain.value = w.rain;
    u.uFog.value = w.fog;
    u.uCloud.value = w.cloud;
    u.uStorm.value = w.storm;
    u.uGust.value = w.gust;
    u.uLightning.value = this.lightning.flash;
    u.uLightningPos.value.copy(this.lightning.position);
    u.uExposure.value = this.exposure;
    u.uUnderwater.value = this.underwater;
  }
}
