import { describe, expect, it } from 'vitest';
import {
	PktLineError,
	ZERO_SHA,
	adaptReceivePackResponse,
	buildReportStatus,
	demuxSideband,
	encodePktLine,
	encodeSideband,
	frameReportForClient,
	isSidebandStream,
	negotiatedSideband,
	parseInfoRefs,
	parseReceivePackRequest,
	parseReceivePackResponse,
	readPkt,
} from '../src/lib/git-protocol.ts';

// ─── Fixture helpers ────────────────────────────────────────────
// Fixtures are written as the literal bytes git puts on the wire. `bytes()`
// takes a JS string where every char is one byte (\x01 etc. for band bytes).

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytes(wire: string): Uint8Array {
	return Uint8Array.from(wire, (ch) => {
		const code = ch.charCodeAt(0);
		if (code > 0xff) throw new Error('fixture strings must be byte strings');
		return code;
	});
}

function hex(buf: Uint8Array): string {
	return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

// ─── pkt-line primitives ────────────────────────────────────────

describe('pkt-line encoding', () => {
	it('matches the canonical examples from git protocol-common docs', () => {
		expect(dec.decode(encodePktLine('a\n'))).toBe('0006a\n');
		expect(dec.decode(encodePktLine('a'))).toBe('0005a');
		expect(dec.decode(encodePktLine('foobar\n'))).toBe('000bfoobar\n');
		expect(dec.decode(encodePktLine(''))).toBe('0004');
	});

	it('produces exact bytes (hex) for a binary payload', () => {
		expect(hex(encodePktLine(new Uint8Array([0x01, 0x00, 0xff])))).toBe('30303037' + '0100ff');
	});

	it('rejects payloads larger than 65516 bytes', () => {
		expect(() => encodePktLine(new Uint8Array(65517))).toThrow(PktLineError);
		expect(encodePktLine(new Uint8Array(65516)).length).toBe(65520);
	});
});

describe('readPkt', () => {
	it('reads data, flush, delim and response-end packets', () => {
		const buf = bytes('0006a\n000000010002');
		const r1 = readPkt(buf, 0)!;
		expect(r1.pkt.type).toBe('data');
		expect(dec.decode((r1.pkt as { payload: Uint8Array }).payload)).toBe('a\n');
		const r2 = readPkt(buf, r1.next)!;
		expect(r2.pkt.type).toBe('flush');
		const r3 = readPkt(buf, r2.next)!;
		expect(r3.pkt.type).toBe('delim');
		const r4 = readPkt(buf, r3.next)!;
		expect(r4.pkt.type).toBe('response-end');
		expect(readPkt(buf, r4.next)).toBeNull();
	});

	it('accepts upper-case hex lengths', () => {
		const buf = bytes('000Afoobar');
		expect(readPkt(buf, 0)!.next).toBe(10);
	});

	it('throws on a non-hex length header', () => {
		expect(() => readPkt(bytes('00zzabc'), 0)).toThrow(PktLineError);
	});

	it('throws on a reserved length (0003)', () => {
		expect(() => readPkt(bytes('0003'), 0)).toThrow(/invalid pkt-line length 3/);
	});

	it('throws on a truncated header and a truncated payload', () => {
		expect(() => readPkt(bytes('00'), 0)).toThrow(/truncated pkt-line header/);
		expect(() => readPkt(bytes('000afoo'), 0)).toThrow(/truncated pkt-line at offset 0/);
	});
});

// ─── info/refs ──────────────────────────────────────────────────

describe('parseInfoRefs', () => {
	const sha1 = '1'.repeat(40);
	const sha2 = '2'.repeat(40);
	const sha3 = '3'.repeat(40);
	const peeled = '4'.repeat(40);

	// GET /info/refs?service=git-upload-pack as served over smart HTTP.
	const advertisement = concat(
		encodePktLine('# service=git-upload-pack\n'),
		bytes('0000'),
		encodePktLine(`${sha1} HEAD\0multi_ack side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=git/2.43.0\n`),
		encodePktLine(`${sha1} refs/heads/main\n`),
		encodePktLine(`${sha2} refs/heads/feature/x\n`),
		encodePktLine(`${sha3} refs/tags/v1.0\n`),
		encodePktLine(`${peeled} refs/tags/v1.0^{}\n`),
		bytes('0000'),
	);

	it('returns every ref with its sha, skipping peeled tags', () => {
		const { refs } = parseInfoRefs(advertisement.buffer as ArrayBuffer);
		expect([...refs]).toEqual([
			['HEAD', sha1],
			['refs/heads/main', sha1],
			['refs/heads/feature/x', sha2],
			['refs/tags/v1.0', sha3],
		]);
	});

	it('reads capabilities from the first ref line', () => {
		const { capabilities } = parseInfoRefs(advertisement.buffer as ArrayBuffer);
		expect(capabilities).toContain('side-band-64k');
		expect(capabilities).toContain('symref=HEAD:refs/heads/main');
	});

	it('handles an empty repository advertisement (capabilities^{})', () => {
		const empty = concat(
			encodePktLine('# service=git-receive-pack\n'),
			bytes('0000'),
			encodePktLine(`${ZERO_SHA} capabilities^{}\0report-status delete-refs side-band-64k\n`),
			bytes('0000'),
		);
		const { refs, capabilities } = parseInfoRefs(empty.buffer as ArrayBuffer);
		expect(refs.size).toBe(0);
		expect(capabilities).toEqual(['report-status', 'delete-refs', 'side-band-64k']);
	});

	it('skips "version 1" lines and stops quietly at truncated data', () => {
		const body = concat(
			encodePktLine('version 1\n'),
			encodePktLine(`${sha1} refs/heads/main\n`),
			bytes('00ff' + 'truncated'),
		);
		const { refs } = parseInfoRefs(body.buffer as ArrayBuffer);
		expect([...refs]).toEqual([['refs/heads/main', sha1]]);
	});

	it('accepts SHA-256 object ids', () => {
		const sha256 = 'c'.repeat(64);
		const body = concat(encodePktLine(`${sha256} refs/heads/main\0object-format=sha256\n`), bytes('0000'));
		expect(parseInfoRefs(body.buffer as ArrayBuffer).refs.get('refs/heads/main')).toBe(sha256);
	});
});

// ─── receive-pack request ───────────────────────────────────────

describe('parseReceivePackRequest', () => {
	const caps = 'report-status side-band-64k quiet object-format=sha1 agent=git/2.43.0';

	it('parses a single-branch push followed by a packfile', () => {
		const body = concat(
			encodePktLine(`${OLD} ${NEW} refs/heads/main\0 ${caps}`),
			bytes('0000'),
			bytes('PACK\x00\x00\x00\x02\x00\x00\x00\x00'),
		);
		const parsed = parseReceivePackRequest(body);
		expect(parsed.isProbe).toBe(false);
		expect(parsed.capabilities).toEqual(caps.split(' '));
		expect(parsed.commandSectionLength).toBe(body.length - 12);
		expect(parsed.refs).toEqual([
			{
				oldSha: OLD,
				newSha: NEW,
				refName: 'refs/heads/main',
				kind: 'branch',
				shortName: 'main',
				isCreate: false,
				isDelete: false,
			},
		]);
	});

	it('flags branch creation, branch deletion and tags', () => {
		const body = concat(
			encodePktLine(`${ZERO_SHA} ${NEW} refs/heads/feature/new\0report-status`),
			encodePktLine(`${OLD} ${ZERO_SHA} refs/heads/old\n`),
			encodePktLine(`${ZERO_SHA} ${NEW} refs/tags/v2.0\n`),
			bytes('0000'),
		);
		const [create, del, tag] = parseReceivePackRequest(body).refs;
		expect(create).toMatchObject({ isCreate: true, isDelete: false, kind: 'branch', shortName: 'feature/new' });
		expect(del).toMatchObject({ isCreate: false, isDelete: true, shortName: 'old' });
		expect(tag).toMatchObject({ kind: 'tag', shortName: 'v2.0' });
	});

	it('skips shallow lines that precede the first command', () => {
		const body = concat(
			encodePktLine(`shallow ${'d'.repeat(40)}\n`),
			encodePktLine(`${OLD} ${NEW} refs/heads/main\0report-status\n`),
			bytes('0000'),
		);
		const parsed = parseReceivePackRequest(body);
		expect(parsed.refs).toHaveLength(1);
		expect(parsed.capabilities).toEqual(['report-status']);
	});

	it('extracts commands from a signed push certificate', () => {
		const body = concat(
			encodePktLine('push-cert\0report-status side-band-64k\n'),
			encodePktLine('certificate version 0.1\n'),
			encodePktLine('pusher Alice <a@example.com> 1700000000 +0000\n'),
			encodePktLine('pushee https://git.example.com/repo\n'),
			encodePktLine('nonce 1700000000-abc\n'),
			encodePktLine('\n'),
			encodePktLine(`${OLD} ${NEW} refs/heads/main\n`),
			encodePktLine('-----BEGIN PGP SIGNATURE-----\n'),
			encodePktLine(`${'e'.repeat(40)} ${'f'.repeat(40)} refs/heads/not-a-command\n`),
			encodePktLine('-----END PGP SIGNATURE-----\n'),
			encodePktLine('push-cert-end\n'),
			bytes('0000'),
		);
		const parsed = parseReceivePackRequest(body);
		expect(parsed.refs.map((r) => r.refName)).toEqual(['refs/heads/main']);
		expect(parsed.capabilities).toEqual(['report-status', 'side-band-64k']);
	});

	it('recognises the "0000" auth probe', () => {
		const parsed = parseReceivePackRequest(bytes('0000'));
		expect(parsed).toEqual({ refs: [], capabilities: [], isProbe: true, commandSectionLength: 4 });
	});

	it('fails closed on malformed input', () => {
		// no flush
		expect(() => parseReceivePackRequest(encodePktLine(`${OLD} ${NEW} refs/heads/main\0report-status`))).toThrow(
			/not terminated by a flush-pkt/,
		);
		// bad sha
		expect(() =>
			parseReceivePackRequest(concat(encodePktLine(`xyz ${NEW} refs/heads/main\n`), bytes('0000'))),
		).toThrow(/malformed object id/);
		// wrong field count
		expect(() =>
			parseReceivePackRequest(concat(encodePktLine(`${OLD} ${NEW}\n`), bytes('0000'))),
		).toThrow(/malformed command line/);
		// capabilities on a later command
		expect(() =>
			parseReceivePackRequest(
				concat(
					encodePktLine(`${OLD} ${NEW} refs/heads/a\n`),
					encodePktLine(`${OLD} ${NEW} refs/heads/b\0report-status\n`),
					bytes('0000'),
				),
			),
		).toThrow(/capabilities on a non-first command line/);
		// flush + nothing else but not a lone probe
		expect(() => parseReceivePackRequest(bytes('00000000'))).toThrow(/no ref update commands/);
		// truncated framing
		expect(() => parseReceivePackRequest(bytes('00ffabc'))).toThrow(PktLineError);
	});

	it('attaches already-read capabilities to the error', () => {
		try {
			parseReceivePackRequest(encodePktLine(`${OLD} ${NEW} refs/heads/main\0side-band-64k`));
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(PktLineError);
			expect((err as PktLineError).capabilities).toEqual(['side-band-64k']);
		}
	});
});

// ─── Sideband ───────────────────────────────────────────────────

// receive-pack response for `git push` with side-band-64k + report-status,
// as raw wire bytes:
//   0013 \x01 000eunpack ok\n
//   001c \x01 0017ok refs/heads/main\n
//   0009 \x01 0000
//   0000
const SIDEBAND_REPORT_WIRE = '0013\x01000eunpack ok\n' + '001c\x010017ok refs/heads/main\n' + '0009\x010000' + '0000';

describe('sideband demux', () => {
	it('fixture bytes are what encodeSideband + report-status produce', () => {
		const report = buildReportStatus('ok', [{ refName: 'refs/heads/main' }]);
		expect(dec.decode(report)).toBe('000eunpack ok\n0017ok refs/heads/main\n0000');
		// Frame each inner pkt-line in its own band-1 packet like git does.
		const framed = concat(
			encodeSideband(bytes('000eunpack ok\n'), 1),
			encodeSideband(bytes('0017ok refs/heads/main\n'), 1),
			encodeSideband(bytes('0000'), 1),
			bytes('0000'),
		);
		expect(hex(framed)).toBe(hex(bytes(SIDEBAND_REPORT_WIRE)));
	});

	it('detects sideband vs raw report-status', () => {
		expect(isSidebandStream(bytes(SIDEBAND_REPORT_WIRE))).toBe(true);
		expect(isSidebandStream(bytes('000eunpack ok\n0000'))).toBe(false);
		expect(isSidebandStream(bytes(''))).toBe(false);
		expect(isSidebandStream(bytes('zzzz'))).toBe(false);
	});

	it('concatenates band-1 and separates progress (2) and errors (3)', () => {
		const wire = bytes(
			'0017\x02Resolving deltas\r\n' + '0013\x01000eunpack ok\n' + '0011\x03fatal: boom\n' + '0000' + 'trailing',
		);
		const out = demuxSideband(wire);
		expect(dec.decode(out.band1)).toBe('000eunpack ok\n');
		expect(out.progress).toEqual(['Resolving deltas\r\n']);
		expect(out.errors).toEqual(['fatal: boom\n']);
		expect(out.bytesConsumed).toBe(wire.length - 'trailing'.length);
	});

	it('throws on an unknown band', () => {
		expect(() => demuxSideband(bytes('0006\x07x'))).toThrow(/unknown sideband band 7/);
	});

	it('round-trips data larger than one sideband packet', () => {
		const data = enc.encode('x'.repeat(2500));
		const framed = encodeSideband(data, 1, 1000 - 4); // side-band (1000-byte) flavour
		// 995 data bytes per packet → 3 packets
		let count = 0;
		for (let o = 0, r; (r = readPkt(framed, o)); o = r.next) count++;
		expect(count).toBe(3);
		expect(dec.decode(demuxSideband(framed).band1)).toBe('x'.repeat(2500));
	});

	it('negotiatedSideband prefers side-band-64k', () => {
		expect(negotiatedSideband(['side-band', 'side-band-64k'])).toBe('side-band-64k');
		expect(negotiatedSideband(['side-band'])).toBe('side-band');
		expect(negotiatedSideband(['report-status'])).toBeNull();
		expect(negotiatedSideband(undefined)).toBeNull();
	});
});

// ─── report-status parsing ──────────────────────────────────────

describe('parseReceivePackResponse', () => {
	it('parses a sideband-wrapped success report', () => {
		const report = parseReceivePackResponse(bytes(SIDEBAND_REPORT_WIRE));
		expect(report).toEqual({
			unpackOk: true,
			unpackError: undefined,
			refResults: [{ refName: 'refs/heads/main', success: true }],
			progress: [],
			errors: [],
		});
	});

	it('parses a raw report with a rejected ref', () => {
		const raw = buildReportStatus('ok', [
			{ refName: 'refs/heads/main' },
			{ refName: 'refs/heads/locked', error: 'protected branch' },
		]);
		const report = parseReceivePackResponse(raw)!;
		expect(report.unpackOk).toBe(true);
		expect(report.refResults).toEqual([
			{ refName: 'refs/heads/main', success: true },
			{ refName: 'refs/heads/locked', success: false, error: 'protected branch' },
		]);
	});

	it('reports unpack failures', () => {
		const report = parseReceivePackResponse(bytes('0024unpack index-pack abnormal exit\n' + '0000'))!;
		expect(report.unpackOk).toBe(false);
		expect(report.unpackError).toBe('index-pack abnormal exit');
	});

	it('handles an inner pkt-line split across two band-1 packets', () => {
		// "000eunpack ok\n" split after "000eunp", then "0017ok refs/heads/main\n0000" in one packet.
		const inner = '000eunpack ok\n0017ok refs/heads/main\n0000';
		const wire = concat(
			encodeSideband(bytes(inner.slice(0, 7)), 1),
			encodeSideband(bytes(inner.slice(7)), 1),
			bytes('0000'),
		);
		const report = parseReceivePackResponse(wire)!;
		expect(report.unpackOk).toBe(true);
		expect(report.refResults).toEqual([{ refName: 'refs/heads/main', success: true }]);
	});

	it('turns a band-3 fatal error with no report into a failed unpack', () => {
		const report = parseReceivePackResponse(bytes('0017\x03remote: disk full\n' + '0000'))!;
		expect(report.unpackOk).toBe(false);
		expect(report.unpackError).toBe('remote: disk full');
		expect(report.errors).toEqual(['remote: disk full\n']);
	});

	it('returns null when there is no report at all', () => {
		expect(parseReceivePackResponse(bytes(''))).toBeNull();
		expect(parseReceivePackResponse(bytes('0000'))).toBeNull();
		expect(parseReceivePackResponse(bytes('0006\x07x0000'))).toBeNull(); // unknown band byte, no report
	});
});

describe('client framing', () => {
	const raw = buildReportStatus('ok', [{ refName: 'refs/heads/main' }]);

	it('frameReportForClient wraps in band 1 + flush only when sideband was negotiated', () => {
		expect(frameReportForClient(raw, null)).toBe(raw);
		expect(hex(frameReportForClient(raw, 'side-band-64k'))).toBe(hex(concat(encodeSideband(raw, 1), bytes('0000'))));
	});

	it('adaptReceivePackResponse converts between raw and sideband', () => {
		const wrapped = frameReportForClient(raw, 'side-band-64k');
		expect(adaptReceivePackResponse(raw, null)).toEqual(raw);
		expect(adaptReceivePackResponse(wrapped, 'side-band-64k')).toEqual(wrapped);
		expect(adaptReceivePackResponse(raw, 'side-band-64k')).toEqual(wrapped);
		expect(adaptReceivePackResponse(wrapped, null)).toEqual(raw);
		expect(adaptReceivePackResponse(new Uint8Array(0), 'side-band')).toEqual(new Uint8Array(0));
	});
});
