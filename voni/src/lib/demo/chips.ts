/* Scripted tool chips for the landing demo call (DESIGN.md §10c). */

export type DemoChip = { afterReply: number; pending: string; done: string };

// ponytail: scripted chips keyed to the agent's reply count, not real tool
// calls. Replace with tool.call events once the demo agents carry function
// tools (stored agents' HTTP tools never reach the browser).
export const DEMO_CHIPS: Record<string, DemoChip[]> = {
  "real-estate": [
    { afterReply: 2, pending: "Checking availability…", done: "2 viewings open" },
    { afterReply: 4, pending: "Booking a viewing…", done: "Booked Sat 10:30" },
  ],
  "car-dealership": [
    { afterReply: 2, pending: "Checking the calendar…", done: "3 test-drive slots" },
    { afterReply: 4, pending: "Booking a test drive…", done: "Booked Thu 17:00" },
  ],
  restaurant: [
    { afterReply: 2, pending: "Checking tables…", done: "Table for 4 free" },
    { afterReply: 4, pending: "Booking the table…", done: "Booked Fri 20:00" },
  ],
};

/**
 * The chip (if any) that follows each transcript line: one per finalized
 * agent reply, matched on that reply's 1-based count. Live captions never
 * count, so a chip lands only once the reply is final.
 */
export function chipSlots(
  lines: { role: "user" | "agent"; live?: boolean }[],
  chips: DemoChip[],
): (DemoChip | undefined)[] {
  let replies = 0;
  return lines.map((line) => {
    if (line.role !== "agent" || line.live) return undefined;
    const reply = ++replies;
    return chips.find((c) => c.afterReply === reply);
  });
}
