/** A table's columns without the named ones, for selecting everything a screen shows but not the large JSON it never reads. */
export function omitColumns<T extends object, K extends keyof T>(columns: T, ...omit: K[]): Omit<T, K> {
  const out = { ...columns };
  for (const key of omit) delete out[key];
  return out;
}
