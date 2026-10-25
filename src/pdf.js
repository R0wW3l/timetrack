const PDFDocument = require('pdfkit');
const { localParts, localDateString, formatTime, formatDuration } = require('./time');

const COLUMNS = [
  { key: 'date', label: 'Date', width: 78 },
  { key: 'start', label: 'Start', width: 78 },
  { key: 'finish', label: 'Finish', width: 78 },
  { key: 'duration', label: 'Duration', width: 64 },
  { key: 'project', label: 'Project', width: 100 },
  { key: 'task', label: 'Task', width: 100 },
  { key: 'notes', label: 'Notes', width: 138 },
  { key: 'amount', label: 'Amount (CAD)', width: 76 },
];

function rowFor(entry, timeFormat) {
  const start = localParts(entry.startUtc, entry.tzOffsetMinutes);
  const finish = localParts(entry.finishUtc, entry.tzOffsetMinutes);
  return {
    date: localDateString(entry.startUtc, entry.tzOffsetMinutes),
    start: formatTime(start, timeFormat),
    finish: formatTime(finish, timeFormat),
    duration: formatDuration(entry.durationSeconds),
    project: entry.projectName || '',
    task: entry.taskName || '',
    notes: entry.notes || '',
    amount: Number(entry.amountCad).toFixed(2),
  };
}

function contentWidth() {
  return COLUMNS.reduce((sum, column) => sum + column.width, 0);
}

function describeFilters(filters) {
  if (!filters || (!filters.projects.length && !filters.tasks.length)) return '';
  const projects = filters.projects.length ? filters.projects.join(', ') : 'all';
  const tasks = filters.tasks.length ? filters.tasks.join(', ') : 'all';
  return `Projects: ${projects}  ·  Tasks: ${tasks}`;
}

function streamPdf(res, report, { from, to, timeFormat, filters }) {
  const doc = new PDFDocument({
    size: 'LETTER',
    layout: 'landscape',
    margin: 40,
    bufferPages: true,
  });
  doc.pipe(res);
  doc.info.Title = `Time report ${from} to ${to}`;

  const left = doc.page.margins.left;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 28;

  doc.fillColor('#1a1d23');
  doc.font('Helvetica-Bold').fontSize(18).text('Time report', left, doc.page.margins.top, { lineBreak: false });
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(11).fillColor('#5c6570').text(`${from} to ${to}`);
  const filterLine = describeFilters(filters);
  if (filterLine) {
    doc.moveDown(0.2);
    doc.fontSize(10).text(filterLine, { width: contentWidth() });
  }
  doc.moveDown(0.8);
  doc.fillColor('#1a1d23');

  let y = doc.y;

  function drawHeader() {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1d23');
    let x = left;
    for (const column of COLUMNS) {
      doc.text(column.label, x, y, { width: column.width, lineBreak: false });
      x += column.width;
    }
    y += 14;
    doc.strokeColor('#d5dbe3').moveTo(left, y).lineTo(left + contentWidth(), y).stroke();
    y += 6;
  }

  drawHeader();

  const rows = report.entries.map((entry) => rowFor(entry, timeFormat));
  doc.font('Helvetica').fontSize(9);

  if (rows.length === 0) {
    doc.fillColor('#5c6570').text('No entries in this range.', left, y);
    y += 20;
  }

  for (const row of rows) {
    const height = Math.max(
      14,
      ...COLUMNS.map((column) => doc.heightOfString(String(row[column.key] ?? ''), { width: column.width }))
    ) + 8;
    if (y + height > bottomLimit()) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
      doc.font('Helvetica').fontSize(9);
    }
    let x = left;
    doc.fillColor('#1a1d23');
    for (const column of COLUMNS) {
      doc.text(String(row[column.key] ?? ''), x, y, { width: column.width });
      x += column.width;
    }
    y += height;
  }

  const hours = (report.totalDurationSeconds / 3600).toFixed(2);
  const totalLine = `Total ${hours} hours (${formatDuration(report.totalDurationSeconds)})  ·  Total ${report.totalAmountCad.toFixed(2)} CAD`;
  if (y + 36 > bottomLimit()) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  y += 8;
  doc.strokeColor('#d5dbe3').moveTo(left, y).lineTo(left + contentWidth(), y).stroke();
  y += 10;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1d23').text(totalLine, left, y);

  const pages = doc.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i += 1) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(8).fillColor('#5c6570').text(
      `Page ${i + 1} of ${pages.count}`,
      left,
      doc.page.height - 28,
      { width: contentWidth(), align: 'right', lineBreak: false }
    );
  }

  doc.end();
}

module.exports = { streamPdf };
