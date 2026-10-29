/** A stored instant in the given zone as dd/mm/aaaa hh:mm; an unknown zone keeps the stored stamp. */
export function readAt(createdAt, timeZone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(createdAt)).map(part => [part.type, part.value]));
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
  } catch { return createdAt; }
}
