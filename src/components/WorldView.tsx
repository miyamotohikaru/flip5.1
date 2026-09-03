"use client";
// 世界（three.js）を載せる画面と、その前後の「言葉と画面」の司令塔。
// World からは on("progress" | "ready" | "enter" | "flip" | "frame") と、少数の操作だけを使う。
// React の state は毎フレーム更新しない（frame は 500ms に 1 回に間引く）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { World, Stats } from "@/engine/world";
import type { WeatherPresetName } from "@/engine/core/env";
import { extras } from "@/engine/ui/controlsApi";
import Landing from "./Landing";
import Blackboard from "./Blackboard";
import NowFormula from "./NowFormula";
import Hud from "./Hud";
import FormulaOverlay from "./FormulaOverlay";
import WorldLabels from "./WorldLabels";
import PhotoMode, { type PhotoHandle } from "./PhotoMode";
import About from "./About";
import Lab from "./Lab";
import Joystick from "./Joystick";

type Phase = "loading" | "ready" | "in";
type Hint = "on" | "fade" | "off";

/** 操作ヒントを出しておく時間（作者の指示で 8 秒 → 40 秒。読む前に消えていた） */
const HINT_MS = 40000;
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
  // 定点撮影（?shot=）は HUD を消すが、世界の中の数式のふだは「画の中身」なので残す
  const [keepLabels, setKeepLabels] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [about, setAbout] = useState(false);
  const [board, setBoard] = useState(false); // 黒板をぜんぶ見る
  const [lab, setLab] = useState(false);
  const [locked, setLocked] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [hint, setHint] = useState<Hint>("off");
  const [isMobile, setIsMobile] = useState(false);
  const [compact, setCompact] = useState(false);
  const [auto, setAuto] = useState(false);
  const [gyro, setGyro] = useState<"none" | "off" | "on">("none");
  const phaseRef = useRef<Phase>("loading");
  const aboutRef = useRef(false);
  const boardRef = useRef(false);
  phaseRef.current = phase;
  aboutRef.current = about;
  boardRef.current = board;

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
      setKeepLabels(!!w.params.shot);
      setShowStats(w.params.stats);
      if (w.params.lab) setLab(true);
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
      w.on("enter", () => {
        setPhase("in");
        // ドラッグ中はカーソルを「掴んだ形」にする
        const km = (w!.controls as unknown as { km?: { onDragChange?: (d: boolean) => void } }).km;
        if (km) km.onDragChange = (d) => setGrabbing(d);
        const c = w!.controls as unknown as { onPointerLockChange?: (on: boolean) => void };
        c.onPointerLockChange = (on) => setLocked(on);
      });
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

  const toggleLab = useCallback(() => setLab((v) => !v), []);
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
      if (boardRef.current) return; // 黒板を読んでいる間は入場のキーを効かせない
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
        case "KeyL":
          if (phaseRef.current === "in") toggleLab();
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
  }, [enter, toggleMute, openAbout, toggleLab]);

  // 携帯では実験室を開いている間、下中央の「裏返す」を隠す（CSS が .lab-open を見る）
  useEffect(() => {
    document.body.classList.toggle("lab-open", lab);
    return () => document.body.classList.remove("lab-open");
  }, [lab]);

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
  // マウス固定（PointerLock）の切り替え。既定はドラッグで見回す方式。
  const onLock = () => {
    const c = worldRef.current?.controls;
    if (!c) return;
    c.setPointerLock(!c.pointerLockMode);
    setLocked(c.pointerLockMode);
  };

  const inWorld = phase === "in";
  const overlays = inWorld && !nohud;
  const labelsOn = inWorld && (!nohud || keepLabels);
  const paused = false; // ドラッグで見回す方式が既定になったので「クリックで操作にもどる」は出さない

  return (
    <div className="world">
      <canvas ref={canvasRef} className={grabbing ? "grabbing" : ""} />

      {!landingGone && (
        <Blackboard phase={phase} isMobile={isMobile} full={board} onClose={() => setBoard(false)} />
      )}

      {!landingGone && (
        <Landing phase={phase} progress={progress} heightmapRes={heightmapRes} isMobile={isMobile} onEnter={enter} onAbout={openAbout} onBoard={() => setBoard(true)} />
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
          lock={locked}
          onLock={onLock}
          gyro={gyro}
          lab={lab}
          onLab={toggleLab}
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
      <NowFormula world={world} active={overlays} compact={compact} />
      <WorldLabels world={world} active={labelsOn} compact={compact} maxLabels={compact || isMobile ? 1 : 0} />
      {isMobile && <Joystick world={world} active={overlays} />}
      <PhotoMode ref={photoRef} world={world} />
      <Lab world={world} open={overlays && lab} onClose={() => setLab(false)} sourceLines={sourceLines} isMobile={isMobile} />
      <About open={about} onClose={closeAbout} sourceLines={sourceLines} isMobile={isMobile} world={world} />
    </div>
  );
}
