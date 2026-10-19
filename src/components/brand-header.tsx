import { resolveBranding } from "@/lib/dealerships/branding";

/**
 * The dealership's own header band for a report, when it has a logo or brand
 * colour; nothing otherwise (A3 styling stays). Text colour is chosen for
 * contrast against the brand colour, never configured.
 *
 * The logo is a plain <img>: it is an arbitrary https host the admin entered
 * (validated as public when saved), so it is not routed through next/image's
 * optimiser, which would make this server fetch it.
 */
export function BrandHeader({ dealership, className }: { dealership: { name: string; brandColor?: string | null; logoUrl?: string | null }; className?: string }) {
  const b = resolveBranding(dealership);
  if (!b.custom) return null;
  return (
    <div className={className ?? "mb-3 flex items-center gap-3 rounded-lg px-4 py-3"} style={{ background: b.color, color: b.text }}>
      {b.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={b.logoUrl} alt={`${dealership.name} logo`} className="h-9 w-auto max-w-[10rem] rounded-sm bg-white/90 object-contain p-0.5" referrerPolicy="no-referrer" />
      )}
      <span className="min-w-0 truncate text-[15px] font-semibold">{dealership.name}</span>
    </div>
  );
}
