import { SkelHeader, SkelLine, Shell } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <Shell>
      <SkelHeader />
      <div className="mb-5 flex gap-4 border-b border-slate-200 pb-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkelLine key={i} className="h-4 w-24 bg-slate-100" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="h-56 rounded-lg border border-slate-200 bg-white shadow-sm" />
        <div className="h-56 rounded-lg border border-slate-200 bg-white shadow-sm lg:col-span-2" />
      </div>
      <div className="mt-4 space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <SkelLine className="h-4 w-1/2" />
            <SkelLine className="mt-2 h-3 w-1/3 bg-slate-100" />
          </div>
        ))}
      </div>
    </Shell>
  );
}
