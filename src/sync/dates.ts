/** A local date as `YYYY-MM-DD` (not via toISOString, which is in UTC and can be a day out). */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface QuickDate {
  name: string;
  date: string;
}

/**
 * The quick choices in the due date picker, like Todoist's: today, tomorrow, the coming weekend
 * (Saturday) and next week (Monday), counted from `today`.
 */
export function quickDates(today: Date): QuickDate[] {
  const day = (n: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
    return isoDate(d);
  };
  const dow = today.getDay(); // 0 Sunday … 6 Saturday
  const toSaturday = (6 - dow + 7) % 7 || 7; // the next Saturday after today
  const toMonday = (1 - dow + 7) % 7 || 7; // the next Monday after today
  const weekend = dow === 0 || dow === 6 ? "Next weekend" : "This weekend";
  return [
    { name: "Today", date: day(0) },
    { name: "Tomorrow", date: day(1) },
    { name: weekend, date: day(toSaturday) },
    { name: "Next week", date: day(toMonday) },
  ];
}
