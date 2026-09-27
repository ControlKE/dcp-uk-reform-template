// Server-side paging, sorting and date-range filters shared by every admin table.
//   ?page=2&pageSize=25&sort=registered&dir=desc&from=2026-01-01&to=2026-03-31
// Sort keys map to whitelisted SQL expressions, so user input never reaches ORDER BY.
const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

function pageParams(q, sorts, defaultSort, defaultDir = 'desc') {
  const pageSize = PAGE_SIZES.includes(Number(q.pageSize)) ? Number(q.pageSize) : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const sort = Object.hasOwn(sorts, q.sort) ? q.sort : defaultSort;
  const dir = q.dir === 'asc' || q.dir === 'desc' ? q.dir : defaultDir;
  return { page, pageSize, sort, dir, orderBy: `${sorts[sort]} ${dir.toUpperCase()}` };
}

// Runs the count and the page query. A page past the end falls back to the last page.
async function paged(db, { select, from, where = [], params = [], p, tiebreak }) {
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.one(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`, params)).n);
  const lastPage = Math.max(1, Math.ceil(total / p.pageSize));
  const page = Math.min(p.page, lastPage);
  // LIMIT/OFFSET are validated integers, inlined because MySQL rejects them as
  // prepared-statement parameters on some versions.
  const rows = await db.query(
    `SELECT ${select} FROM ${from} ${whereSql} ORDER BY ${p.orderBy}${tiebreak ? `, ${tiebreak}` : ''} LIMIT ${p.pageSize} OFFSET ${(page - 1) * p.pageSize}`,
    params);
  return { rows, total, page, pageSize: p.pageSize, sort: p.sort, dir: p.dir };
}

// Adds created-between conditions from ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, UTC).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function dateRange(q, column, where, params) {
  if (ISO_DATE.test(q.from || '')) { where.push(`${column} >= ?`); params.push(`${q.from} 00:00:00`); }
  if (ISO_DATE.test(q.to || '')) { where.push(`${column} < DATE_ADD(?, INTERVAL 1 DAY)`); params.push(q.to); }
}

module.exports = { PAGE_SIZES, pageParams, paged, dateRange };
