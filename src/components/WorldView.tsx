"use client";
// 世界（three.js）を載せる画面と、その前後の「言葉と画面」の司令塔。
// World からは on("progress" | "ready" | "enter" | "flip" | "frame") と、少数の操作だけを使う。
// React の state は毎フレーム更新しない（frame は 500ms に 1 回に間引く）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { World, Stats } from "@/engine/world";
import type { WeatherPresetName } from "@/engine/core/env";
import { extras } from "@/engine/ui/controlsApi";
import Landing from "./Landing";
import Hud from "./Hud";
import FormulaOverlay from "./FormulaOverlay";
import PhotoMode, { type PhotoHandle } from "./PhotoMode";
import About from "./About";
import Joystick from "./Joystick";

type Phase = "loading" | "ready" | "in";
type Hint = "on" | "fade" | "off";

/** 操作ヒントを出しておく時間 */
const HINT_MS = 8000;
/** 入口のフェード（CSS の transition と合わせる） */
const FADE_MS = 1100;

export default function WorldView({ sourceLines }: { sourceLines: number | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World | null>(null);
  const photoRef = useRef<PhotoHandle>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [landingGone, setLandingGone] = useState(false);
  const [progress, setProgress] = useState({ step: "", p: 0 });
  const [heightmapRes, setHeightmapRes] = useState(2048);
  const [stats, setStats] = useState<Stats | null>(null);
  const [hour, setHour] = useState(17.35);
  const [weather, setWeather] = useState<WeatherPresetName>("clear");
  const [flip, setFlip] = useState(false);
  const [muted, setMuted] = useState(false);
  const [nohud, setNohud] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [about, setAbout] = useState(false);
  const [locked, setLocked] = useState(false);
  const [hint, setHint] = useState<Hint>("off");
  const [isMobile, setIsMobile] = useState(false);
  const [compact, setCompact] = useState(false);
  const [auto, setAuto] = useState(false);
  const [gyro, setGyro] = useState<"none" | "off" | "on">("none");
  const phaseRef = useRef<Phase>("loading");
  const aboutRef = useRef(false);
  phaseRef.current = phase;
  aboutRef.current = about;

  // 世界を作る
  useEffect(() => {
    let disposed = false;
    let w: World | null = null;
    (async () => {
      const { World } = await import("@/engine/world");
      if (disposed || !canvasRef.current) return;
      w = new World(canvasRef.current);
      worldRef.current = w;
      window.__flip = w;
      setWorld(w);
      setNohud(w.params.nohud);
      setShowStats(w.params.stats);
      setAuto(w.params.auto);
      setIsMobile(w.env.isMobile);
      setHeightmapRes(w.q.heightmapRes);
      setHour(w.env.hour);
      if (w.params.weather) setWeather(w.params.weather);
      if ((w.params.flip ?? 0) > 0.5) setFlip(true);
      w.on("progress", (p) => setProgress(p as { step: string; p: number }));
      w.on("ready", () => {
        const x = extras(w!.controls);
        setGyro(typeof x.enableGyro === "function" ? (x.gyroEnabled ? "on" : "off") : "none");
        setPhase(w!.params.auto ? "in" : "ready");
      });
      w.on("enter", () => setPhase("in"));
      w.on("flip", (f) => setFlip((f as number) > 0.5));
      let last = 0;
      const wantStats = w.params.stats;
      w.on("frame", (s) => {
        const now = performance.now();
        if (now - last < 500) return;
        last = now;
        if (wantStats) setStats({ ...(s as Stats) });
        setHour(w!.env.hour);
      });
      await w.build();
    })();
    return () => {
      disposed = true;
      w?.dispose();
      worldRef.current = null;
    };
  }, []);

  // 世界ができる前の端末判定（入口の操作ヒント用）。できたら env.isMobile が上書きする
  useEffect(() => {
    if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) setIsMobile(true);
    const mq = window.matchMedia("(max-width: 620px)");
    const upd = () => setCompact(mq.matches);
    upd();
    mq.addEventListener("change", upd);
    return () => mq.removeEventListener("change", upd);
  }, []);

  // PointerLock の状態（Esc で解放されたら「クリックで操作にもどる」を出す）
  useEffect(() => {
    const onLock = () => setLocked(document.pointerLockElement === canvasRef.current);
    document.addEventListener("pointerlockchange", onLock);
    return () => document.removeEventListener("pointerlockchange", onLock);
  }, []);

  // 入場: 入口をフェードで外し、ヒントを 8 秒だけ
  useEffect(() => {
    if (phase !== "in") return;
    setHint("on");
    const t1 = window.setTimeout(() => setHint("fade"), HINT_MS);
    const t2 = window.setTimeout(() => setHint("off"), HINT_MS + 1400);
    const t3 = window.setTimeout(() => setLandingGone(true), FADE_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [phase]);

  const enter = useCallback(() => {
    const w = worldRef.current;
    if (!w || !w.ready || phaseRef.current !== "ready") return;
    w.enter(true);
  }, []);

  const toggleMute = useCallback(() => {
    const w = worldRef.current;
    if (!w) return;
    w.audio.setMuted(!w.audio.muted);
    setMuted(w.audio.muted);
  }, []);

  const openAbout = useCallback(() => {
    worldRef.current?.exit();
    setAbout(true);
  }, []);
  const closeAbout = useCallback(() => setAbout(false), []);

  // キーボード
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const w = worldRef.current;
      if (!w || !w.ready || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (aboutRef.current) return; // About は自分で Esc を扱う
      if (e.key === "?") {
        openAbout();
        return;
      }
      switch (e.code) {
        case "KeyF":
          if (phaseRef.current === "in") w.toggleFlip();
          break;
        case "KeyM":
          toggleMute();
          break;
        case "KeyP":
          if (phaseRef.current === "in") void photoRef.current?.take();
          break;
        case "KeyH":
          if (phaseRef.current === "in") setNohud((v) => !v);
          break;
        case "KeyT":
          w.env.hourSpeed = w.env.hourSpeed ? 0 : 0.25;
          break;
        case "Enter":
        case "Space":
          if (phaseRef.current === "ready" && tag !== "BUTTON") {
            e.preventDefault();
            enter();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enter, toggleMute, openAbout]);

  const onHour = (h: number) => {
    setHour(h);
    worldRef.current?.setHour(h);
  };
  const onWeather = (wn: WeatherPresetName) => {
    setWeather(wn);
    worldRef.current?.setWeather(wn);
  };
  const onGyro = async () => {
    const x = extras(worldRef.current?.controls);
    if (!x.enableGyro) return;
    if (gyro === "on") {
      x.disableGyro?.();
      setGyro("off");
      return;
    }
    try {
      const ok = await x.enableGyro();
      setGyro(ok ? "on" : "off");
    } catch {
      setGyro("off");
    }
  };
  // パソコンで Esc の後、画面をクリックしたらマウスを掴み直す
  const onCanvasPointerDown = () => {
    if (phase === "in" && !isMobile && !locked && !about) worldRef.current?.controls.enter();
  };

  const inWorld = phase === "in";
  const overlays = inWorld && !nohud;
  const paused = overlays && !isMobile && !locked && !auto && !about;

  return (
    <div className="world">
      <canvas ref={canvasRef} onPointerDown={onCanvasPointerDown} />

      {!landingGone && (
        <Landing phase={phase} progress={progress} heightmapRes={heightmapRes} isMobile={isMobile} onEnter={enter} onAbout={openAbout} />
      )}

      {overlays && (
        <Hud
          hour={hour}
          weather={weather}
          flip={flip}
          muted={muted}
          stats={stats}
          showStats={showStats}
          isMobile={isMobile}
          hint={hint}
          paused={paused}
          gyro={gyro}
          onFlip={() => worldRef.current?.toggleFlip()}
          onPhoto={() => void photoRef.current?.take()}
          onMute={toggleMute}
          onAbout={openAbout}
          onGyro={() => void onGyro()}
          onHour={onHour}
          onWeather={onWeather}
        />
      )}

      <FormulaOverlay world={world} active={overlays} compact={compact} />
      {isMobile && <Joystick world={world} active={overlays} />}
      <PhotoMode ref={photoRef} world={world} />
      <About open={about} onClose={closeAbout} sourceLines={sourceLines} isMobile={isMobile} />
    </div>
  );
}
