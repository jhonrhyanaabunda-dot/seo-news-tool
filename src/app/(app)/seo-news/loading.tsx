import { SkelHeader, SkelLine, Shell } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <Shell>
      <SkelHeader />
      <div className="mb-4 h-[70px] rounded-lg border border-slate-200 bg-white shadow-sm" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <SkelLine className="h-4 w-3/5" />
            <SkelLine className="mt-2 h-3 w-2/5 bg-slate-100" />
          </div>
        ))}
      </div>
    </Shell>
  );
}
