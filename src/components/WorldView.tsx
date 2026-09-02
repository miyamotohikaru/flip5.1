"use client";
// 世界（three.js）を載せる画面。入口と HUD もここ。UI 担当が作り込む土台。
import { useEffect, useRef, useState, useCallback } from "react";
import MobileBreak from "./MobileBreak";
import type { World, Stats } from "@/engine/world";
import type { WeatherPresetName } from "@/engine/core/env";

type Phase = "loading" | "ready" | "in";

export default function WorldView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [hour, setHour] = useState(17.35);
  const [weather, setWeather] = useState<WeatherPresetName>("clear");
  const [flip, setFlip] = useState(false);
  const [muted, setMuted] = useState(false);
  const [nohud, setNohud] = useState(false);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    let disposed = false;
    let world: World | null = null;
    (async () => {
      const { World } = await import("@/engine/world");
      if (disposed || !canvasRef.current) return;
      world = new World(canvasRef.current);
      worldRef.current = world;
      window.__flip = world;
      setNohud(world.params.nohud);
      setShowStats(world.params.stats);
      setHour(world.env.hour);
      world.on("progress", (p) => setProgress((p as { step: string }).step));
      world.on("ready", () => setPhase(world!.params.auto ? "in" : "ready"));
      world.on("enter", () => setPhase("in"));
      world.on("flip", (f) => setFlip((f as number) > 0.5));
      let last = 0;
      world.on("frame", (s) => {
        const now = performance.now();
        if (now - last > 500) {
          last = now;
          setStats({ ...(s as Stats) });
          setHour(world!.env.hour);
        }
      });
      await world.build();
    })();
    return () => {
      disposed = true;
      world?.dispose();
      worldRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const w = worldRef.current;
      if (!w || !w.ready) return;
      if (e.code === "KeyF") w.toggleFlip();
      if (e.code === "KeyM") { w.audio.setMuted(!w.audio.muted); setMuted(w.audio.muted); }
      if (e.code === "KeyP") void photo();
      if (e.code === "KeyH") setNohud((v) => !v);
      if (e.code === "KeyT") { w.env.hourSpeed = w.env.hourSpeed ? 0 : 0.25; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enter = useCallback(() => {
    worldRef.current?.enter(true);
  }, []);

  const photo = useCallback(async () => {
    const w = worldRef.current;
    if (!w) return;
    const blob = await w.takePhoto();
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `suushiki-no-zekkei-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, []);

  const onHour = (h: number) => {
    setHour(h);
    worldRef.current?.setHour(h);
  };
  const onWeather = (w: WeatherPresetName) => {
    setWeather(w);
    worldRef.current?.setWeather(w);
  };

  const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
  const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

  return (
    <div className="world">
      <canvas ref={canvasRef} />

      <div className={`landing ${phase === "in" ? "hidden" : ""}`}>
        <div className="landing-head">
          <span>こす.くま ／ ふりっぷ</span>
          <span>MATHSCAPE</span>
        </div>
        <div className="landing-body">
          <h1 className="landing-title">数式の絶景</h1>
          <p className="landing-lead">
            この風景の中に、画像は1枚もありません。<br />
            3Dモデルも、音のファイルも、<MobileBreak />1つもありません。<br />
            山も、湖も、木も、雲も、雨の音も、<MobileBreak />全部、<strong>数式</strong>です。<br />
            裏返すと、確かめられます。
          </p>
          <button className="enter" onClick={enter} disabled={phase !== "ready"}>
            {phase === "ready" ? "入る" : "計算中"}
          </button>
          <div className="progress">{phase === "ready" ? "" : progress}</div>
        </div>
        <div className="landing-foot">
          <span>
            パソコン: WASD で歩く ／ マウスで見回す ／ F で裏返す ／ P で写真<br />
            携帯: 左側で歩く ／ 右側で見回す
          </span>
          <span>制作: こす.くま × Claude Fable 5.1</span>
        </div>
      </div>

      {!nohud && phase === "in" && (
        <div className="hud">
          <div className="corner tl">
            <div className="title">数式の絶景</div>
            <div className="count">画像 <b>0</b> 枚 ／ 3Dモデル <b>0</b> 個 ／ 音源 <b>0</b> 個</div>
          </div>
          <div className="corner tr">
            <div className="panel">
              <button className={`flip ${flip ? "on" : ""}`} onClick={() => worldRef.current?.toggleFlip()}>
                {flip ? "もどす" : "裏返す"}
              </button>
              <button onClick={() => void photo()}>写真</button>
              <button className={muted ? "" : "on"} onClick={() => { const w = worldRef.current; if (!w) return; w.audio.setMuted(!w.audio.muted); setMuted(w.audio.muted); }}>
                {muted ? "音 OFF" : "音 ON"}
              </button>
            </div>
            <div className="panel" style={{ marginTop: 8 }}>
              {(["clear", "cloudy", "mist", "rain", "storm"] as WeatherPresetName[]).map((w) => (
                <button key={w} className={weather === w ? "on" : ""} onClick={() => onWeather(w)}>
                  {{ clear: "晴れ", cloudy: "くもり", mist: "霧", rain: "雨", storm: "嵐" }[w]}
                </button>
              ))}
            </div>
            <div className="panel" style={{ marginTop: 8, alignItems: "center" }}>
              <span className="count">{clock}</span>
              <input type="range" min={0} max={24} step={0.05} value={hour} onChange={(e) => onHour(Number(e.target.value))} />
            </div>
          </div>
          <div className="corner bl hint">WASD 歩く ／ Shift 走る ／ F 裏返す ／ P 写真 ／ H 表示を消す</div>
          <div className="corner br">
            {showStats && stats && (
              <div className="stats">
                {stats.tier} ／ {stats.width}×{stats.height} ／ {stats.frameMs.toFixed(1)} ms ／ {stats.drawCalls} calls ／ {(stats.triangles / 1000).toFixed(0)}k tris
              </div>
            )}
          </div>
          <div className="reticle" />
        </div>
      )}
    </div>
  );
}
