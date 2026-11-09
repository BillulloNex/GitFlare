import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRecords, serializeCsv } from '../src/lib/csv.ts';
import {
	diffTableListings,
	historyForTable,
	normalizeTableName,
	parseTableInput,
	tableNameFromEntry,
	tablePath,
	TableError,
	type TablesHistory,
} from '../src/lib/tables.ts';

describe('csv', () => {
	it('round-trips quotes, commas, newlines and edge spaces', () => {
		const table = {
			columns: ['Part', 'Notes', 'Qty'],
			rows: [
				['M3 bolt, 10mm', 'say "hi"', '4'],
				['Bracket', 'line one\nline two', ''],
				[' padded ', '', '1'],
			],
		};
		const csv = serializeCsv(table);
		expect(csv).toBe('Part,Notes,Qty\n"M3 bolt, 10mm","say ""hi""",4\nBracket,"line one\nline two",\n" padded ",,1\n');
		expect(parseCsv(csv)).toEqual(table);
	});

	it('parses CRLF, a BOM, empty quoted fields and no trailing newline', () => {
		expect(parseCsvRecords('﻿a,b\r\n"",x\r\n1,"2"')).toEqual([
			['a', 'b'],
			['', 'x'],
			['1', '2'],
		]);
	});

	it('pads short rows, names extra columns, and skips blank lines', () => {
		expect(parseCsv('a,b\n1\n\n1,2,3\n')).toEqual({
			columns: ['a', 'b', 'Column 3'],
			rows: [
				['1', '', ''],
				['1', '2', '3'],
			],
		});
	});

	it('treats empty input as an empty table', () => {
		expect(parseCsv('')).toEqual({ columns: [], rows: [] });
		expect(serializeCsv({ columns: [], rows: [] })).toBe('');
	});
});

describe('table names', () => {
	it('accepts human names and drops a .csv suffix', () => {
		expect(normalizeTableName('  Potential   collaborators ')).toBe('Potential collaborators');
		expect(normalizeTableName('BOM.csv')).toBe('BOM');
		expect(normalizeTableName('Run log (v2) & notes')).toBe('Run log (v2) & notes');
		expect(normalizeTableName('Ünïcode 表')).toBe('Ünïcode 表');
	});

	it('rejects paths, dotfiles and junk', () => {
		for (const bad of ['', '   ', '../x', 'a/b', '.hidden', 'x.', 'a\\b', 'x'.repeat(81), 42, null]) {
			expect(normalizeTableName(bad)).toBeNull();
		}
	});

	it('maps names to paths and back', () => {
		expect(tablePath('BOM')).toBe('tables/BOM.csv');
		expect(tableNameFromEntry('BOM.csv')).toBe('BOM');
		expect(tableNameFromEntry('Data.CSV')).toBe('Data');
		expect(tableNameFromEntry('readme.md')).toBeNull();
	});
});

describe('parseTableInput', () => {
	it('pads rows and stringifies numbers', () => {
		const { table, csv } = parseTableInput({ columns: [' Name ', 'Qty'], rows: [['a', 3], ['b']] });
		expect(table).toEqual({ columns: ['Name', 'Qty'], rows: [['a', '3'], ['b', '']] });
		expect(csv).toBe('Name,Qty\na,3\nb,\n');
	});

	it('accepts csv text', () => {
		expect(parseTableInput({ csv: 'x,y\n1,2\n' }).table).toEqual({ columns: ['x', 'y'], rows: [['1', '2']] });
	});

	it('refuses bad shapes', () => {
		const bad = [
			{ columns: [] },
			{ columns: ['a', 'a'] },
			{ columns: ['a', ''] },
			{ columns: ['a'], rows: [['1', '2']] },
			{ columns: ['a'], rows: [[{}]] },
			{ columns: 'a' },
			{ csv: 5 },
		];
		for (const body of bad) expect(() => parseTableInput(body as any)).toThrow(TableError);
	});
});

describe('table history', () => {
	it('classifies added, modified, deleted and renamed tables', () => {
		const before = new Map([
			['BOM', 'b1'],
			['Old', 'o1'],
			['Gone', 'g1'],
		]);
		const after = new Map([
			['BOM', 'b2'],
			['New', 'o1'],
			['Fresh', 'f1'],
		]);
		expect(diffTableListings(before, after)).toEqual([
			{ table: 'BOM', kind: 'modified', blob: 'b2' },
			{ table: 'Fresh', kind: 'added', blob: 'f1' },
			{ table: 'Gone', kind: 'deleted', blob: null },
			{ table: 'New', kind: 'renamed', from: 'Old', blob: 'o1' },
		]);
	});

	it('follows a table back through renames and stops at its creation', () => {
		const commit = (sha: string, changes: any[]) => ({ sha, parent: null, message: sha, author: { name: 'a', email: 'e' }, date: '', changes });
		const history: TablesHistory = {
			head: 'c5',
			truncated: false,
			commits: [
				commit('c5', [{ table: 'Parts', kind: 'modified', blob: 'p3' }]),
				commit('c4', [{ table: 'Other', kind: 'modified', blob: 'x' }]),
				commit('c3', [{ table: 'Parts', kind: 'renamed', from: 'BOM', blob: 'p2' }]),
				commit('c2', [{ table: 'BOM', kind: 'added', blob: 'p1' }]),
				commit('c1', [{ table: 'BOM', kind: 'deleted', blob: null }]),
			],
		};
		expect(historyForTable(history, 'Parts').map((c) => c.sha)).toEqual(['c5', 'c3', 'c2']);
	});
});
