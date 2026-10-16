import { encodeQr, qrSvgPath } from "@/lib/qr";

/**
 * A QR code as inline SVG (one path, no script, no external image), so it
 * renders under the enforced CSP and prints crisply. Returns null when the
 * text is too long to encode; callers always offer the text as well.
 */
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const matrix = encodeQr(text);
  if (!matrix) return null;
  const { d, size } = qrSvgPath(matrix);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className={className}>
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
