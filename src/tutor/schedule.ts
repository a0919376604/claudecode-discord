export function localTimeToUtcCron(hhmm: string, timeZone: string, dayOfWeek?: number, now = new Date()): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) throw new Error("invalid time");
  let offsetName: string | undefined;
  try {
    offsetName = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(now).find(part => part.type === "timeZoneName")?.value;
  } catch { throw new Error("invalid timezone"); }
  const offset = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(offsetName ?? "");
  if (!offset) throw new Error("invalid timezone");
  const offsetMinutes = offset[1] ? (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
  const [hour, minute] = hhmm.split(":").map(Number);
  // ponytail: offset frozen at setup time; DST zones drift 1h after a switch.
  // Upgrade: add a tz column on crons and make nextFireAfter timezone-aware.
  const utc = hour * 60 + minute - offsetMinutes;
  const dayShift = Math.floor(utc / 1440);
  const utcMinutes = ((utc % 1440) + 1440) % 1440;
  const day = dayOfWeek === undefined ? "*" : ((dayOfWeek + dayShift + 7) % 7);
  return `${utcMinutes % 60} ${Math.floor(utcMinutes / 60)} * * ${day}`;
}
