import { createServerFn } from "@tanstack/react-start";
import { composeBrief, type RideFacts } from "./brief-copy";
import { formatHoursMinutes } from "./geo";

export type { RideFacts };
export { composeBrief };

const briefCache = new Map<string, { at: number; text: string }>();

export const briefRide = createServerFn({ method: "POST" })
  .validator((input: RideFacts) => {
    const q = String(input?.q ?? "").trim();
    if (!q) throw new Error("No flight");
    return {
      ...input,
      q,
      reasons: Array.isArray(input.reasons) ? input.reasons : [],
      inbound: String(input.inbound ?? ""),
      summary: String(input.summary ?? ""),
      label: String(input.label ?? ""),
      grade: String(input.grade ?? ""),
    };
  })
  .handler(async ({ data }) => {
    let local = "This flight is on file. Ground, flight, and arrival notes fill in as the day updates.";
    try {
      local = composeBrief(data).lead;
    } catch {
      /* keep fallback sentence */
    }

    // Preserve the explicit saved-schedule warning during partial updates.
    if (data.scheduleNote) return { ok: true as const, text: local };
    const cacheKey = `${data.iata}:${data.now}:${data.delayMin}:${data.rideLabel}:${data.destNas}:${data.taxiInKind}:${data.land}:${data.wxHash ?? ""}`;
    const hit = briefCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 10 * 60_000) {
      return { ok: true as const, text: hit.text };
    }

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      briefCache.set(cacheKey, { at: Date.now(), text: local });
      return { ok: true as const, text: local };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12_000);
    try {
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "grok-4.5",
          reasoning: { effort: "low" },
          messages: [
            {
              role: "user",
              content: [
                `You write a passenger briefing — the whole trip in 70-110 words, ONE or TWO short paragraphs. Not a list. Not a recap of app screens.`,
                `Voice: calm, specific, present tense for what is happening, future for what is still ahead. No emoji. No markdown. No letter grades. No "this is the flight."`,
                `If they have not taken off, brief the entire trip: inbound if it still matters, push delay, taxi out, what the ride will feel like, arrival delay/weather, landing time, taxi in / gate.`,
                `If they are airborne, drop inbound and push. Brief remaining distance/time, ride quality still ahead, arrival delay, landing time, taxi in.`,
                `If they are on arrival, drop high-altitude chop. Brief the field, landing time, taxi in.`,
                `If they are at the gate, close it out with actual taxi in if you have it.`,
                `Only use the facts below. Do not invent minutes, gates, or weather. If a taxi time is estimated, say estimated. If measured, do not say estimated.`,
                `Current stage: ${data.now}. Live: ${data.live}. Aircraft: ${data.typeName ?? "unknown"} ${data.registration ?? ""}.`,
                `Ride call: ${data.rideLabel ?? "n/a"}.`,
                `Remaining ${Math.round(data.remainingNm)} nm, about ${formatHoursMinutes(data.etaMin)}.`,
                `Push ${data.push ?? "n/a"}; taxi out ${data.taxiOutMin ?? "n/a"} min (${data.taxiOutKind ?? "n/a"}); wheels up ${data.takeoff ?? "n/a"}; land ${data.land ?? "n/a"}; taxi in ${data.taxiInMin ?? "n/a"} min (${data.taxiInKind ?? "n/a"}); dest gate ${data.destGate ?? "n/a"}.`,
                `Departure delay vs original: ${data.delayMin ?? "n/a"} min. Typical slip: ${data.typicalDelayMin ?? "n/a"} min.`,
                `Origin weather: ${data.originWx}. Origin TAF: ${data.originTaf ?? "n/a"}. Origin NAS: ${data.originNas}.`,
                `Dest weather: ${data.destWx}. Dest TAF: ${data.destTaf ?? "n/a"}. Dest NAS: ${data.destNas}.`,
                `Ride/weather hash: ${data.wxHash ?? "n/a"}. Weather deltas: ${(data.wxDeltas ?? []).join("; ") || "none"}. Corridor: ${data.corridorWx ?? "n/a"}.`,
                `Inbound status: ${data.inboundStatus ?? "n/a"}. ${data.inbound}`,
                `If this is an update, end with one short sentence starting "Updated because" explaining what changed in the facts, not that the app refreshed.`,
              ].join("\n"),
            },
          ],
          max_tokens: 700,
          temperature: 0.4,
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        briefCache.set(cacheKey, { at: Date.now(), text: local });
        return { ok: true as const, text: local };
      }
      const body = (await res.json()) as {
        choices?: { message?: { content?: string; reasoning_content?: string } }[];
      };
      const text =
        body.choices?.[0]?.message?.content?.trim() ||
        body.choices?.[0]?.message?.reasoning_content?.trim() ||
        "";
      const out = text || local;
      briefCache.set(cacheKey, { at: Date.now(), text: out });
      return { ok: true as const, text: out };
    } catch {
      briefCache.set(cacheKey, { at: Date.now(), text: local });
      return { ok: true as const, text: local };
    } finally {
      clearTimeout(timer);
    }
  });

export const briefField = createServerFn({ method: "POST" })
  .validator((input: { icao: string }) => {
    const icao = String(input?.icao ?? "").toUpperCase();
    if (!/^[A-Z]{4}$/.test(icao)) throw new Error("Unknown field");
    return { icao };
  })
  .handler(async (): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    return { ok: false, error: "Field brief moved. Use Inbound." };
  });
