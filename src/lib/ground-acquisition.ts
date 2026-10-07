export type GroundAcquisitionRoute<T> = { route: string; run: () => Promise<T | null> };

/** Lazy stages: a successful exact lookup must not launch redundant provider work. */
export async function acquireGroundInStages<T>(input: {
  strongest: GroundAcquisitionRoute<T> | null;
  area: GroundAcquisitionRoute<T>;
  aliases: GroundAcquisitionRoute<T>[];
}): Promise<{ route: string; position: T } | null> {
  for (const entry of [input.strongest, input.area, ...input.aliases.slice(0, 2)]) {
    if (!entry) continue;
    try {
      const position = await entry.run();
      if (position) return { route: entry.route, position };
    } catch {
      // A failed route is not evidence that another identity alias is absent.
    }
  }
  return null;
}
