// 検証ログ: 辛口批評エージェントの採点をラウンドごとに並べる。データは src/data/critique.json（批評担当が追記する）。
import Link from "next/link";
import critique from "@/data/critique.json";
import { SHOTS } from "@/engine/core/params";

type Round = {
  round: number;
  date: string;
  scores: Record<string, number>;
  mobile?: Record<string, number>;
  blind?: Record<string, boolean>;
  verdict: string;
  top?: string[];
  notes?: string[];
};

export const metadata = { title: "検証ログ ｜ 数式の絶景" };

const rounds = (critique as Round[]).slice().sort((a, b) => a.round - b.round);
const shotDesc = new Map(SHOTS.map((s) => [s.name, s.desc]));

function avg(o: Record<string, number> | undefined) {
  if (!o) return null;
  const v = Object.values(o);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export default function LogPage() {
  return (
    <main className="log">
      <header className="log-head">
        <Link href="/" className="log-back">← 数式の絶景</Link>
        <h1>検証ログ</h1>
        <p>
          この風景は、制作とは別の「辛口批評」エージェントが、<br />
          AAA ゲームのスクリーンショットと並べて見分けがつくかを、<br />
          12 の定点でラウンドごとに採点し直しています。<br />
          合格は全定点 9 点以上。ここに載っているのは、その記録そのままです。
        </p>
      </header>

      {rounds.length === 0 && <p className="log-empty">まだ採点はありません。</p>}

      <section className="log-summary">
        <table>
          <thead>
            <tr><th>ラウンド</th><th>日付</th><th>平均</th><th>携帯</th><th>ブラインド通過</th><th>判定</th></tr>
          </thead>
          <tbody>
            {rounds.map((r) => {
              const a = avg(r.scores), m = avg(r.mobile);
              const blind = r.blind ? Object.values(r.blind).filter(Boolean).length : null;
              return (
                <tr key={r.round}>
                  <td>{r.round}</td>
                  <td>{r.date}</td>
                  <td>{a === null ? "—" : a.toFixed(1)}</td>
                  <td>{m === null ? "—" : m.toFixed(1)}</td>
                  <td>{blind === null ? "—" : `${blind} / ${Object.keys(r.blind ?? {}).length}`}</td>
                  <td className={r.verdict.includes("合格") && !r.verdict.includes("不") ? "pass" : "fail"}>{r.verdict}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {rounds.slice().reverse().map((r) => (
        <section key={r.round} className="log-round">
          <h2>ラウンド {r.round} <span>{r.date} ／ {r.verdict}</span></h2>
          <table>
            <thead>
              <tr><th>定点</th><th>内容</th><th>点</th><th>ブラインド</th></tr>
            </thead>
            <tbody>
              {Object.entries(r.scores).map(([k, v]) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td>{shotDesc.get(k) ?? ""}</td>
                  <td className="num">{v}</td>
                  <td>{r.blind ? (r.blind[k] ? "される" : "されない") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.top && r.top.length > 0 && (
            <>
              <h3>直すべきこと（効果の大きい順）</h3>
              <ol>{r.top.map((t, i) => <li key={i}>{t}</li>)}</ol>
            </>
          )}
          {r.notes && r.notes.length > 0 && (
            <>
              <h3>定点ごとの指摘</h3>
              <ul>{r.notes.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </>
          )}
        </section>
      ))}

      <footer className="log-foot">制作: こす.くま × Claude Fable 5.1 ／ <Link href="/">風景へもどる</Link></footer>
    </main>
  );
}
