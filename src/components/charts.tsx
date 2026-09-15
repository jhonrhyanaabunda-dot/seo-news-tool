/**
 * Dependency-free SVG charts (server-rendered, no client JS).
 */

export function ScoreHistoryChart({ points, height = 180 }: { points: Array<{ label: string; score: number | null; down?: boolean }>; height?: number }) {
  const valid = points.filter((p) => p.score !== null);
  if (valid.length === 0) return <p className="text-sm text-slate-500">No scored scans yet.</p>;
  const width = 640;
  const pad = { l: 34, r: 12, t: 10, b: 24 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (s: number) => pad.t + h - (s / 100) * h;
  let path = "";
  points.forEach((p, i) => {
    if (p.score === null) return;
    path += `${path && points[i - 1]?.score !== null ? "L" : "M"}${x(i).toFixed(1)},${y(p.score).toFixed(1)} `;
  });
  const summary = `Score history: ${valid.length} scans, latest ${valid[valid.length - 1].score}, lowest ${Math.min(...valid.map((v) => v.score!))}, highest ${Math.max(...valid.map((v) => v.score!))}.`;
  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={summary}>
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={width - pad.r} y1={y(g)} y2={y(g)} stroke="#e2e8f0" strokeDasharray={g === 0 ? undefined : "3 3"} />
            <text x={pad.l - 6} y={y(g) + 4} textAnchor="end" fontSize="10" fill="#64748b">
              {g}
            </text>
          </g>
        ))}
        <rect x={pad.l} y={y(100)} width={w} height={y(85) - y(100)} fill="#ecfdf5" opacity="0.6" />
        <path d={path} fill="none" stroke="#1d4ed8" strokeWidth="2" strokeLinejoin="round" />
        {points.map((p, i) =>
          p.score === null ? (
            p.down ? (
              <text key={i} x={x(i)} y={y(4)} textAnchor="middle" fontSize="11" fill="#b91c1c">
                ✕<title>{`${p.label}: website unavailable`}</title>
              </text>
            ) : null
          ) : (
            <circle key={i} cx={x(i)} cy={y(p.score)} r="3.5" fill="#fff" stroke="#1d4ed8" strokeWidth="2">
              <title>{`${p.label}: ${p.score}/100`}</title>
            </circle>
          ),
        )}
        {points.length > 1 && (
          <>
            <text x={x(0)} y={height - 6} fontSize="10" fill="#64748b" textAnchor="start">
              {points[0].label}
            </text>
            <text x={x(points.length - 1)} y={height - 6} fontSize="10" fill="#64748b" textAnchor="end">
              {points[points.length - 1].label}
            </text>
          </>
        )}
      </svg>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}

export function CategoryBars({ categories }: { categories: Array<{ key: string; label: string; score: number }> }) {
  return (
    <ul className="space-y-2.5">
      {categories.map((c) => {
        const color = c.score >= 85 ? "bg-emerald-500" : c.score >= 65 ? "bg-amber-500" : "bg-red-500";
        return (
          <li key={c.key}>
            <div className="mb-1 flex justify-between text-sm">
              <span className="text-slate-700">{c.label}</span>
              <span className="font-medium tabular-nums text-slate-900">{c.score}</span>
            </div>
            <div className="h-2 rounded-full bg-slate-100" role="meter" aria-valuenow={c.score} aria-valuemin={0} aria-valuemax={100} aria-label={`${c.label} score`}>
              <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.max(2, c.score)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
