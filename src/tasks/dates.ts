/**
 * Parse relative date phrases into Unix timestamps.
 * Examples: "today", "tomorrow", "next Monday", "in 3 days", "May 27"
 */
export function parseRelativeDate(phrase: string): number | null {
  const now = new Date();
  const lower = phrase.toLowerCase().trim();

  if (lower === 'today') {
    return endOfDay(now);
  }

  if (lower === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return endOfDay(d);
  }

  // "next {day}"
  const dayMatch = lower.match(/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (dayMatch) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = days.indexOf(dayMatch[1]);
    const currentDay = now.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;

    const d = new Date(now);
    d.setDate(d.getDate() + daysUntil);
    return endOfDay(d);
  }

  // "in X days"
  const inDaysMatch = lower.match(/in\s+(\d+)\s+day/);
  if (inDaysMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(inDaysMatch[1]));
    return endOfDay(d);
  }

  // "in X weeks"
  const inWeeksMatch = lower.match(/in\s+(\d+)\s+week/);
  if (inWeeksMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(inWeeksMatch[1]) * 7);
    return endOfDay(d);
  }

  // "end of week" (Friday)
  if (lower === 'end of week') {
    const d = new Date(now);
    const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilFriday);
    d.setHours(17, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  // Specific date: "May 27" or "May 27, 2024"
  const dateMatch = phrase.match(/([A-Za-z]+)\s+(\d{1,2})(?:,\s+(\d{4}))?/);
  if (dateMatch) {
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'];
    const month = monthNames.indexOf(dateMatch[1].toLowerCase());
    const day = parseInt(dateMatch[2]);
    const year = dateMatch[3] ? parseInt(dateMatch[3]) : now.getFullYear();

    if (month !== -1) {
      const d = new Date(year, month, day, 23, 59, 59, 999);
      return Math.floor(d.getTime() / 1000);
    }
  }

  return null;
}

/** Format timestamp for human-readable display. */
export function formatTaskDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getHours() !== 23 || date.getMinutes() !== 59 ? { hour: 'numeric' } : {}),
  });
}

function endOfDay(d: Date): number {
  d.setHours(23, 59, 59, 999);
  return Math.floor(d.getTime() / 1000);
}
