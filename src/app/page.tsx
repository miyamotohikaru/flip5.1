import fs from "node:fs";
import path from "node:path";
import WorldView from "@/components/WorldView";

/**
 * src/ 以下のコードの行数。ビルド時（静的生成）に数えて「この風景について」に出す。
 * 画像・モデル・音源はこの中に 1 つも無い、という看板の裏付け。取れなければ null（表示しない）。
 */
function countSourceLines(): number | null {
  try {
    const root = path.join(process.cwd(), "src");
    let lines = 0;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|css)$/.test(e.name)) lines += fs.readFileSync(p, "utf8").split("\n").length;
      }
    };
    walk(root);
    return lines > 0 ? lines : null;
  } catch {
    return null;
  }
}

export default function Page() {
  return <WorldView sourceLines={countSourceLines()} />;
}
