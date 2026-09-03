"use client";
// HUD。細く、上品に。風景の邪魔をしない。
// 左上: 題字と「画像 0 枚 ／ 3Dモデル 0 個 ／ 音源 0 個」（この作品の看板。本当に 0）
// 右上: ふりっぷする／写真／音／？、天気 5 種、時刻スライダー
// 下  : 操作ヒント（初回だけ 8 秒）
import { useState } from "react";
import type { Stats } from "@/engine/world";
import type { WeatherPresetName } from "@/engine/core/env";

const WEATHERS: { key: WeatherPresetName; label: string }[] = [
  { key: "clear", label: "晴れ" },
  { key: "cloudy", label: "くもり" },
  { key: "mist", label: "霧" },
  { key: "rain", label: "雨" },
  { key: "storm", label: "嵐" },
];

export type HudProps = {
  hour: number;
  weather: WeatherPresetName;
  flip: boolean;
  muted: boolean;
  stats: Stats | null;
  showStats: boolean;
  isMobile: boolean;
  /** 操作ヒント（入場から 8 秒だけ on、そのあと fade → off） */
  hint: "on" | "fade" | "off";
  /** パソコンでマウスが解放されている（Esc の後） */
  paused: boolean;
  /** マウス固定（PointerLock）が入っている */
  lock: boolean;
  gyro: "none" | "off" | "on";
  /** 実験室が開いているか */
  lab: boolean;
  onLab: () => void;
  onFlip: () => void;
  onPhoto: () => void;
  onMute: () => void;
  onAbout: () => void;
  onGyro: () => void;
  onLock: () => void;
  onHour: (h: number) => void;
  onWeather: (w: WeatherPresetName) => void;
};

export default function Hud(p: HudProps) {
  const [dragging, setDragging] = useState(false);
  const hh = Math.floor(p.hour), mm = Math.min(59, Math.floor((p.hour - hh) * 60 + 1e-4));
  const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

  return (
    <div className="hud">
      <div className="hud-tl">
        <div className="hud-title">数式の絶景</div>
        <div className="hud-count" aria-label="画像 0 枚、3Dモデル 0 個、音源 0 個">
          <span>画像 <b>0</b> 枚</span>
          <span className="sep"> ／ </span>
          <span>3Dモデル <b>0</b> 個</span>
          <span className="sep"> ／ </span>
          <span>音源 <b>0</b> 個</span>
        </div>
      </div>

      <div className="hud-tr">
        <div className="row">
          <button className={`btn flip ${p.flip ? "on" : ""}`} onClick={p.onFlip} aria-pressed={p.flip} aria-label={p.flip ? "もどす（F）" : "ふりっぷする（F）"}>
            {p.flip ? "もどす" : "ふりっぷする"}
          </button>
          <button className="btn" onClick={p.onPhoto} aria-label="写真を撮る（P）">
            写真
          </button>
          <button className={`btn ${p.muted ? "dim" : ""}`} onClick={p.onMute} aria-pressed={!p.muted} aria-label={p.muted ? "音を出す（M）" : "音を消す（M）"}>
            {p.muted ? "音 OFF" : "音 ON"}
          </button>
          {!p.isMobile && (
            <button className={`btn ${p.lock ? "on" : ""}`} onClick={p.onLock} aria-pressed={p.lock} aria-label={p.lock ? "マウスの固定をやめる" : "マウスを固定して見回す"}>
              マウス固定
            </button>
          )}
          <button className={`btn ${p.lab ? "on" : ""}`} onClick={p.onLab} aria-pressed={p.lab} aria-label="数式のつまみをいじる（L）">
            いじる
          </button>
          <button className="btn icon" onClick={p.onAbout} aria-label="この風景について">
            ？
          </button>
        </div>

        <div className={`row ${p.isMobile && p.flip ? "hide-on-flip" : ""}`}>
          <div className="seg" role="radiogroup" aria-label="天気">
            {WEATHERS.map((w) => (
              <button key={w.key} role="radio" aria-checked={p.weather === w.key} onClick={() => p.onWeather(w.key)}>
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <div className={`row time ${dragging ? "dragging" : ""} ${p.isMobile && p.flip ? "hide-on-flip" : ""}`}>
          <span className="clock" aria-hidden>
            {clock}
          </span>
          <input
            type="range"
            min={0}
            max={24}
            step={0.05}
            value={p.hour}
            aria-label={`時刻 ${clock}`}
            aria-valuetext={clock}
            onChange={(e) => p.onHour(Number(e.target.value))}
            onPointerDown={() => setDragging(true)}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onBlur={() => setDragging(false)}
          />
        </div>
      </div>

      {p.isMobile && (
        <button className={`flip-thumb ${p.flip ? "on" : ""}`} onClick={p.onFlip} aria-pressed={p.flip} aria-label={p.flip ? "もどす" : "ふりっぷする"}>
          {p.flip ? "もどす" : "ふりっぷする"}
        </button>
      )}

      <div className="reticle" aria-hidden />

      {p.lock && <div className="hud-paused">Esc でマウスを出す</div>}

      {p.hint !== "off" && (
        <div className={`hud-hint ${p.hint === "fade" ? "fade" : ""}`} aria-hidden>
          {p.isMobile
            ? "左で歩く ／ 右で見回す"
            : "ドラッグで見回す ／ WASD 歩く ／ Shift 走る ／ F ふりっぷ ／ P 写真 ／ H 表示を消す"}
        </div>
      )}

      <div className="hud-br">
        {p.showStats && p.stats && (
          <div className="stats">
            {p.stats.tier} ／ {p.stats.width}×{p.stats.height} ／ {p.stats.frameMs.toFixed(1)} ms ／ {p.stats.drawCalls} calls ／ {(p.stats.triangles / 1000).toFixed(0)}k tris
          </div>
        )}
        {p.isMobile && p.gyro !== "none" && (
          <button className={`btn ${p.gyro === "on" ? "on" : ""}`} onClick={p.onGyro} aria-pressed={p.gyro === "on"} aria-label="ジャイロで見回す">
            ジャイロ {p.gyro === "on" ? "ON" : "OFF"}
          </button>
        )}
      </div>
    </div>
  );
}
