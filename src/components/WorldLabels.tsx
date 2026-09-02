"use client";
// 裏返した世界の中に浮かぶ、数式のふだ（この作品の芯のもう半分）。
// 照準のパネルは「見ている 1 か所」を答えるもの。こちらは風景そのものに
// 「山＝この関数」「湖＝この式」「空＝この積分」「木＝この規則」と貼っていく。
//
//   ・位置は裏返しを始めた瞬間に一度だけ決めて、世界に固定する（engine/ui/labels.ts）
//   ・数式の波が通り過ぎた所から順に現れる
//   ・毎フレーム camera.project() で画面座標に直す。遠いほど小さく薄く、近づくと読める
//   ・地形に隠れたら消す（8 点だけの簡易判定、8 回/秒）
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { World } from "@/engine/world";
import { buildLabels, occluded, type WorldLabel } from "@/engine/ui/labels";

type Props = {
  world: World | null;
  /** 入場後で、HUD が隠されていない */
  active: boolean;
  /** 携帯の版面（短い式にする） */
  compact: boolean;
};

const _v = new THREE.Vector3();

export default function WorldLabels({ world, active, compact }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState<WorldLabel[]>([]);
  const built = useRef(false);
  const hidden = useRef<boolean[]>([]);
  const lastOcc = useRef(0);
  /** ふだの箱の寸法と、数式パネルの矩形（150ms に 1 回だけ測る） */
  const bw = useRef<number[]>([]);
  const bh = useRef<number[]>([]);
  const avoid = useRef<{ l: number; t: number; r: number; b: number }[]>([]);
  /** いま照準のパネルが出している種類（同じ種類のふだは二重になるので出さない） */
  const panelKind = useRef<string>("");
  // frame の中から最新の labels を読むための箱（state の反映を待たない）
  const labelsRef = useRef<WorldLabel[]>([]);
  labelsRef.current = labels;

  useEffect(() => {
    if (!world || !active) {
      built.current = false;
      setLabels([]);
      return;
    }
    const off = world.on("frame", () => {
      const env = world.env;
      const on = env.flipRadius > 1 && (env.flip > 0.1 || env.flipTarget > 0.5);
      if (!on) {
        if (built.current) {
          built.current = false;
          setLabels([]);
        }
        return;
      }
      if (!built.current) {
        built.current = true;
        hidden.current = [];
        bw.current = [];
        bh.current = [];
        avoid.current = [];
        panelKind.current = "";
        lastOcc.current = 0;
        setLabels(buildLabels(env, compact));
        return;
      }
      const root = rootRef.current;
      if (!root || root.children.length === 0) return;

      const cam = env.camera;
      const now = performance.now();
      const checkOcc = now - lastOcc.current > 150;
      if (checkOcc) lastOcc.current = now;

      const W = window.innerWidth, H = window.innerHeight;
      const n = labelsRef.current.length;
      // 150ms に 1 回だけ: 遮蔽・ふだの寸法・数式パネルの位置（レイアウトを起こす処理はここにまとめる）
      if (checkOcc) {
        // 避ける矩形: 裏返しの数式パネルと、HUD の左上（題字）・右上（ボタン）
        avoid.current = [];
        panelKind.current = "";
        for (const sel of [".formula.show", ".hud-tl", ".hud-tr", ".flip-thumb", ".hud-br"]) {
          const e = document.querySelector(sel) as HTMLElement | null;
          if (!e) continue;
          if (sel.startsWith(".formula")) {
            for (const k of ["terrain", "lake", "sky"]) if (e.classList.contains(k)) panelKind.current = k;
          }
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) avoid.current.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
        }
        for (let i = 0; i < n; i++) {
          const box = (root.children[i] as HTMLElement | undefined)?.querySelector(".wlabel-box") as HTMLElement | null;
          if (box) {
            bw.current[i] = box.offsetWidth;
            bh.current[i] = box.offsetHeight;
          }
          if (labelsRef.current[i].occlude) hidden.current[i] = occluded(cam.position, labelsRef.current[i].pos);
        }
      }

      // 1 周目: 画面座標・距離・大きさ
      const sx: number[] = [], sy: number[] = [], sd: number[] = [], ss: number[] = [], so: number[] = [];
      const vis: boolean[] = [], below: boolean[] = [], left: boolean[] = [];
      type Rect = { l: number; t: number; r: number; b: number };
      const box: Rect[] = [];
      const rectOf = (i: number, toLeft: boolean, toBelow: boolean): Rect => {
        const w = bw.current[i] * ss[i], h = bh.current[i] * ss[i];
        const stem = 30 * ss[i], gap = 10 * ss[i];
        const l = toLeft ? sx[i] - gap - w : sx[i] + gap;
        const t = toBelow ? sy[i] + stem : sy[i] - stem - h;
        return { l, t, r: l + w, b: t + h };
      };
      const overlaps = (a: Rect, b: Rect, m: number) => a.l < b.r + m && a.r > b.l - m && a.t < b.b + m && a.b > b.t - m;

      for (let i = 0; i < n; i++) {
        const L = labelsRef.current[i];
        const dist = _v.copy(L.pos).distanceTo(cam.position);
        const arrived = L.pos.distanceTo(env.flipCenter) <= env.flipRadius;
        _v.project(cam);
        const x = (_v.x * 0.5 + 0.5) * W, y = (-_v.y * 0.5 + 0.5) * H;
        sx[i] = x;
        sy[i] = y;
        sd[i] = dist;
        const vd = L.screenDist ?? dist; // 空は「遠いが手前に見せる」
        ss[i] = Math.min(1, Math.max(0.85, 1.1 - vd / 2200));
        so[i] = Math.min(1, Math.max(0.82, 1.3 - vd / 3000));
        below[i] = false;
        left[i] = false;
        vis[i] =
          _v.z < 1 && arrived && dist < L.maxDist && dist > 10 && !hidden.current[i] && L.kind !== panelKind.current &&
          x > -40 && x < W + 40 && y > 4 && y < H - 48;
        box[i] = rectOf(i, false, false);
      }

      // 2 周目: 近い順に、点の上下左右 4 通りから「数式パネルにも他のふだにも重ならない」置き方を選ぶ。
      //         どれも駄目なら、そのふだは出さない（風景を数式のふだで埋めない）
      const order = [];
      for (let i = 0; i < n; i++) order.push(i);
      order.sort((a, b) => sd[a] - sd[b]);
      const placed: number[] = [];
      for (const i of order) {
        if (!vis[i]) continue;
        const wantBelow = sy[i] < 44 + (bh.current[i] + 30) * ss[i];
        const wantLeft = sx[i] > W - (bw.current[i] + 26) * ss[i];
        const cands: [boolean, boolean][] = [
          [wantLeft, wantBelow],
          [!wantLeft, wantBelow],
          [wantLeft, !wantBelow],
          [!wantLeft, !wantBelow],
        ];
        let ok = false;
        for (const [cl, cb] of cands) {
          const r = rectOf(i, cl, cb);
          if (r.l < 6 || r.r > W - 6 || r.t < 6 || r.b > H - 6) continue;
          if (avoid.current.some((a) => overlaps(r, a, 8))) continue;
          if (placed.some((j) => overlaps(r, box[j], 10))) continue;
          left[i] = cl;
          below[i] = cb;
          box[i] = r;
          ok = true;
          break;
        }
        vis[i] = ok;
        if (ok) placed.push(i);
      }
      // 3 周目: DOM へ
      for (let i = 0; i < n; i++) {
        const el = root.children[i] as HTMLElement | undefined;
        if (!el) continue;
        if (vis[i]) {
          el.style.transform = `translate3d(${Math.round(sx[i])}px, ${Math.round(sy[i])}px, 0) scale(${ss[i].toFixed(3)})`;
          el.style.opacity = String(so[i]);
          el.classList.toggle("below", below[i]);
          el.classList.toggle("toleft", left[i]);
        } else if (el.style.opacity !== "0") {
          el.style.opacity = "0";
        }
      }
    });
    return () => {
      off();
      built.current = false; // 版面（compact）が変わったら置き直す
    };
  }, [world, active, compact]);

  if (labels.length === 0) return null;
  return (
    <div className="wlabels" ref={rootRef} aria-hidden>
      {labels.map((l, i) => (
        <div className={`wlabel ${l.kind}`} key={`${l.kind}-${i}`} style={{ opacity: 0 }}>
          <span className="wlabel-dot" />
          <span className="wlabel-stem" />
          <div className="wlabel-box">
            <div className="wlabel-head">
              {l.title}
              <span>{l.latin}</span>
            </div>
            {l.lines.map((t, j) => (
              <div className="wlabel-line" key={j}>
                {t}
              </div>
            ))}
            <div className="wlabel-note">{l.note}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
