/**
 * RFC 4180 CSV for repository data tables (src/lib/tables.ts).
 *
 * Every cell is text. The first record is the header (column names). Output
 * uses LF line endings and quotes a field only when it must, so a one-cell
 * edit changes one line of the file and `git diff` stays readable.
 */

export interface TableData {
	columns: string[];
	rows: string[][];
}

/** Parse CSV text into records. Accepts CRLF/LF/CR line endings and a leading BOM. */
export function parseCsvRecords(text: string): string[][] {
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	const records: string[][] = [];
	let record: string[] = [];
	let field = '';
	let quoted = false;
	let i = 0;
	const n = text.length;
	// True once the current record has any content (so a trailing newline adds no empty record).
	let started = false;

	while (i < n) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"' && field === '') {
			quoted = true;
			started = true;
			i++;
			continue;
		}
		if (ch === ',') {
			record.push(field);
			field = '';
			started = true;
			i++;
			continue;
		}
		if (ch === '\n' || ch === '\r') {
			record.push(field);
			records.push(record);
			record = [];
			field = '';
			started = false;
			i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
			continue;
		}
		field += ch;
		started = true;
		i++;
	}
	if (started || field !== '' || record.length) {
		record.push(field);
		records.push(record);
	}
	return records;
}

/**
 * CSV text → table. The header becomes the columns; short rows are padded,
 * and cells beyond the header get generated column names so nothing is lost.
 * Blank lines are dropped.
 */
export function parseCsv(text: string): TableData {
	const records = parseCsvRecords(text).filter((r) => !(r.length === 1 && r[0] === ''));
	if (records.length === 0) return { columns: [], rows: [] };
	const columns = [...records[0]];
	const width = Math.max(columns.length, ...records.map((r) => r.length));
	for (let c = columns.length; c < width; c++) columns.push(`Column ${c + 1}`);
	const rows = records.slice(1).map((r) => {
		const row = r.slice(0, width);
		while (row.length < width) row.push('');
		return row;
	});
	return { columns, rows };
}

function quoteField(value: string): string {
	return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Table → CSV text (LF line endings, trailing newline). An empty table is the empty string. */
export function serializeCsv(table: TableData): string {
	if (table.columns.length === 0) return '';
	const lines = [table.columns, ...table.rows].map((r) => r.map(quoteField).join(','));
	return lines.join('\n') + '\n';
}
