import { SkelHeader, SkelLine, SkelTable, Shell } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <Shell>
      <SkelHeader />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[76px] rounded-lg border border-l-4 border-slate-200 bg-white px-4 py-3 shadow-sm">
            <SkelLine className="h-3 w-24 bg-slate-100" />
            <SkelLine className="mt-2 h-6 w-14" />
          </div>
        ))}
      </div>
      <div className="mb-6 mt-3 h-[60px] rounded-lg border border-slate-200 bg-white shadow-sm" />
      <SkelTable />
    </Shell>
  );
}
