"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-lg border border-red-200 bg-white p-6 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-slate-900">Something went wrong loading this page</h1>
      <p className="mt-2 text-sm text-slate-600">The problem has been logged. Please try again; if it keeps happening, contact an administrator{error.digest ? ` and mention reference ${error.digest}` : ""}.</p>
      <button type="button" onClick={reset} className="btn-primary mt-4">
        Try again
      </button>
    </div>
  );
}
