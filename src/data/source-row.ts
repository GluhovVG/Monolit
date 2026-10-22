/**
 * Raw row of sheet «Сделки» as returned by GET /api/deals.
 * Layout: row, deal code, month (0 = period not supplied), customer, item,
 * plan revenue, fact revenue, plan cost, fact cost, actual weight (kg),
 * MK fact revenue, MK fact cost, documentation fact, supply fact,
 * delivery fact, construction fact, BG/fines fact. null != 0.
 */
export type SourceRow = [
  number, string, number, string, string,
  number, number, number, number,
  number | null, number | null, number | null,
  number | null, number | null, number | null,
  number | null, number | null
];
