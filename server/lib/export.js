// CSV and Excel downloads for the admin. columns: [[key, label, kind?]] where kind
// 'gbp' / 'money' / 'date' / 'int' formats the Excel cell (CSV stays plain text).
const ExcelJS = require('exceljs');

function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, columns, rows) {
  const lines = [columns.map(([, label]) => csvCell(label)).join(',')];
  for (const row of rows) lines.push(columns.map(([key]) => csvCell(row[key])).join(','));
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.send('﻿' + lines.join('\r\n'));
}

async function sendXlsx(res, filename, sheetName, columns, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DCP UK admin';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([key, label, kind]) => ({
    header: label, key, width: Math.min(45, Math.max(12, label.length + 2)),
    style: kind === 'gbp' ? { numFmt: '"£"#,##0.00' } : kind === 'money' ? { numFmt: '#,##0.00' } : kind === 'int' ? { numFmt: '0' } : {},
  }));
  for (const row of rows) {
    ws.addRow(Object.fromEntries(columns.map(([key, , kind]) => {
      let v = row[key];
      if (v == null) v = null;
      else if (kind === 'gbp' || kind === 'money' || kind === 'int') v = Number(v);
      else if (typeof v === 'string' && /^[=+\-@]/.test(v)) v = `'${v}`; // formula injection
      return [key, v];
    })));
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}

// Sends CSV or XLSX depending on ?format=.
function sendTable(req, res, base, sheetName, columns, rows) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (req.query.format === 'xlsx') return sendXlsx(res, `${base}-${stamp}.xlsx`, sheetName, columns, rows);
  return sendCsv(res, `${base}-${stamp}.csv`, columns, rows);
}

module.exports = { csvCell, sendCsv, sendXlsx, sendTable };
