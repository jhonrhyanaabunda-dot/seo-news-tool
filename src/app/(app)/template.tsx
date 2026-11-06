/** A short fade as a new screen arrives. Tabs and filters on one screen do not remount this, so they do not flash. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
