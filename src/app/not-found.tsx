import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="text-center">
        <p className="text-sm font-semibold text-brand-600">404</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">The page or dealership you are looking for does not exist or was removed.</p>
        <Link href="/" className="btn-primary mt-4">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
