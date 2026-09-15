import { SkelHeader, SkelTable, Shell } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <Shell>
      <SkelHeader />
      <SkelTable rows={5} cols={5} />
    </Shell>
  );
}
