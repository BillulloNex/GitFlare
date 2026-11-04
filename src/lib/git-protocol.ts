/**
 * Git Smart HTTP protocol helpers (protocol v0/v1, which is all receive-pack speaks).
 *
 * One pkt-line reader (`readPkt`) backs every parser in this file:
 *  - `parseInfoRefs`             ref advertisement (info/refs)
 *  - `parseReceivePackRequest`   push commands (strict — throws on anything malformed)
 *  - `demuxSideband`             side-band / side-band-64k streams
 *  - `parseReceivePackResponse`  report-status, sideband-wrapped or raw
 *
 * Sideband rule (pack-protocol.txt): demux the OUTER pkt-lines by band byte,
 * concatenate every band-1 payload, then parse THAT byte stream as pkt-lines.
 * A single band-1 packet may hold several inner pkt-lines, and one inner
 * pkt-line may be split across band-1 packets.
 *
 * References:
 * - https://git-scm.com/docs/pack-protocol
 * - https://git-scm.com/docs/http-protocol
 */

// ─── Types ──────────────────────────────────────────────────────

export type RefKind = 'branch' | 'tag' | 'other';

export interface RefUpdate {
	oldSha: string;
	newSha: string;
	/** Full ref name, e.g. "refs/heads/main" or "refs/tags/v1.0". */
	refName: string;
	kind: RefKind;
	/** Name without the refs/heads/ or refs/tags/ prefix ("main", "v1.0"); the full ref for `other`. */
	shortName: string;
	isCreate: boolean; // oldSha is all zeros
	isDelete: boolean; // newSha is all zeros
}

export interface RefResult {
	refName: string;
	success: boolean;
	error?: string; // e.g. "non-fast-forward"
}

export interface ReceivePackParsed {
	refs: RefUpdate[];
	capabilities: string[];
	/** True for git's auth probe: a body that is a lone flush-pkt ("0000"), no commands. */
	isProbe: boolean;
	/** Byte length of the command section (up to and including its flush-pkt). */
	commandSectionLength: number;
}

export interface ReportStatus {
	unpackOk: boolean;
	unpackError?: string;
	refResults: RefResult[];
	/** Band-2 progress messages, if the response was sideband-wrapped. */
	progress: string[];
	/** Band-3 fatal error messages, if the response was sideband-wrapped. */
	errors: string[];
}

export type Pkt =
	| { type: 'data'; payload: Uint8Array }
	| { type: 'flush' | 'delim' | 'response-end' };

export class PktLineError extends Error {
	/** Capabilities read before the failure, if any (lets callers pick the reply framing). */
	capabilities?: string[];
	constructor(message: string, capabilities?: string[]) {
		super(message);
		this.name = 'PktLineError';
		this.capabilities = capabilities;
	}
}

// ─── Constants ──────────────────────────────────────────────────

export const ZERO_SHA = '0000000000000000000000000000000000000000';
const FLUSH_PKT = '0000';
/** SHA-1 (40) or SHA-256 (64) object IDs. */
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_OID_RE = /^0+$/;

/** Max payload (incl. band byte) of one sideband pkt-line. */
const SIDEBAND_64K_MAX = 65520 - 4;
const SIDEBAND_MAX = 1000 - 4;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ─── pkt-line primitives ────────────────────────────────────────

/**
 * Read one pkt-line at `offset`. Returns null at end of buffer.
 * Throws PktLineError on a bad length header or a truncated packet.
 */
export function readPkt(buffer: Uint8Array, offset: number): { pkt: Pkt; next: number } | null {
	if (offset >= buffer.length) return null;
	if (offset + 4 > buffer.length) {
		throw new PktLineError(`truncated pkt-line header at offset ${offset}`);
	}
	const lenHex = decoder.decode(buffer.subarray(offset, offset + 4));
	if (!/^[0-9a-f]{4}$/i.test(lenHex)) {
		throw new PktLineError(`invalid pkt-line length ${JSON.stringify(lenHex)} at offset ${offset}`);
	}
	const len = parseInt(lenHex, 16);
	if (len === 0) return { pkt: { type: 'flush' }, next: offset + 4 };
	if (len === 1) return { pkt: { type: 'delim' }, next: offset + 4 };
	if (len === 2) return { pkt: { type: 'response-end' }, next: offset + 4 };
	if (len < 4) throw new PktLineError(`invalid pkt-line length ${len} at offset ${offset}`);
	if (offset + len > buffer.length) {
		throw new PktLineError(`truncated pkt-line at offset ${offset} (need ${len} bytes, have ${buffer.length - offset})`);
	}
	return { pkt: { type: 'data', payload: buffer.subarray(offset + 4, offset + len) }, next: offset + len };
}

/** Decode a pkt-line payload as text, dropping one trailing LF. */
function pktText(payload: Uint8Array): string {
	const text = decoder.decode(payload);
	return text.endsWith('\n') ? text.slice(0, -1) : text;
}

export function encodePktLine(content: string | Uint8Array): Uint8Array {
	const data = typeof content === 'string' ? encoder.encode(content) : content;
	const len = data.length + 4;
	if (len > 65520) throw new PktLineError(`pkt-line payload too large (${data.length} bytes)`);
	const result = new Uint8Array(len);
	result.set(encoder.encode(len.toString(16).padStart(4, '0')), 0);
	result.set(data, 4);
	return result;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

function toBytes(body: ArrayBuffer | Uint8Array): Uint8Array {
	return body instanceof Uint8Array ? body : new Uint8Array(body);
}

function classifyRef(refName: string): { kind: RefKind; shortName: string } {
	if (refName.startsWith('refs/heads/')) return { kind: 'branch', shortName: refName.slice('refs/heads/'.length) };
	if (refName.startsWith('refs/tags/')) return { kind: 'tag', shortName: refName.slice('refs/tags/'.length) };
	return { kind: 'other', shortName: refName };
}

// ─── Ref Advertisement Parsing ──────────────────────────────────

/**
 * Parse a Smart HTTP (protocol v0/v1) info/refs advertisement.
 *
 * Format:
 *   001e# service=git-upload-pack\n   (optional service header, HTTP only)
 *   0000
 *   [000eversion 1\n]
 *   <sha> <ref>\0<capabilities>\n      (first ref carries capabilities)
 *   <sha> <ref>\n ...
 *   0000
 *
 * Peeled tag entries (`<ref>^{}`) and the empty-repo placeholder
 * (`capabilities^{}`) are skipped. Stops quietly at malformed/truncated data.
 */
export function parseInfoRefs(body: ArrayBuffer): { refs: Map<string, string>; capabilities: string[] } {
	const buffer = new Uint8Array(body);
	const refs = new Map<string, string>();
	let capabilities: string[] = [];
	let offset = 0;

	while (true) {
		let read: ReturnType<typeof readPkt>;
		try {
			read = readPkt(buffer, offset);
		} catch {
			break;
		}
		if (!read) break;
		offset = read.next;
		if (read.pkt.type !== 'data') continue; // flush / delim / response-end

		let line = pktText(read.pkt.payload);
		if (line.startsWith('# service=') || line.startsWith('version ')) continue;

		const nulIdx = line.indexOf('\0');
		if (nulIdx !== -1) {
			capabilities = line.slice(nulIdx + 1).split(' ').filter(Boolean);
			line = line.slice(0, nulIdx);
		}

		const spaceIdx = line.indexOf(' ');
		if (spaceIdx === -1) continue;
		const sha = line.slice(0, spaceIdx);
		const refName = line.slice(spaceIdx + 1);

		if (!OID_RE.test(sha)) continue;
		if (refName.endsWith('^{}')) continue;

		refs.set(refName, sha);
	}

	return { refs, capabilities };
}

// ─── Request Parsing ────────────────────────────────────────────

/**
 * Parse a git-receive-pack request body. STRICT: throws PktLineError on any
 * malformed framing or command line, so callers can fail closed.
 *
 * Request format (pkt-line):
 *   [shallow <sha>\n]*                                  (shallow clients)
 *   <old-sha> <new-sha> <refname>\0<capabilities>\n     (first command)
 *   [<old-sha> <new-sha> <refname>\n]*                  (subsequent)
 *   0000                                                (flush)
 *   [<push-option>\n]* 0000                             (if push-options negotiated)
 *   <packfile binary data>                              (absent for delete-only pushes)
 *
 * Signed pushes put the commands inside a `push-cert` block instead:
 *   push-cert\0<capabilities>\n  certificate version 0.1\n  pusher ...\n
 *   ... \n  <old> <new> <ref>\n ...  -----BEGIN PGP SIGNATURE----- ...  push-cert-end\n  0000
 *
 * A body that is only "0000" is git's probe request (sent before a large
 * chunked upload to check auth); it is reported as `isProbe` with no refs.
 */
export function parseReceivePackRequest(body: ArrayBuffer | Uint8Array): ReceivePackParsed {
	const buffer = toBytes(body);
	const refs: RefUpdate[] = [];
	let capabilities: string[] = [];
	let offset = 0;
	let lineNo = 0;
	let sawCommand = false; // first command (or push-cert line) seen
	let sawFlush = false;
	let inPushCert = false;
	let inSignature = false;

	const fail = (message: string): never => {
		throw new PktLineError(message, capabilities.length ? capabilities : undefined);
	};

	while (true) {
		let read: ReturnType<typeof readPkt>;
		try {
			read = readPkt(buffer, offset);
		} catch (err: any) {
			return fail(err.message);
		}
		if (!read) break;
		offset = read.next;

		if (read.pkt.type === 'flush') {
			sawFlush = true;
			break;
		}
		if (read.pkt.type !== 'data') {
			fail(`unexpected ${read.pkt.type} packet in receive-pack command list`);
			break;
		}

		let line = pktText(read.pkt.payload);
		lineNo++;

		if (!sawCommand && line.startsWith('shallow ')) {
			if (!OID_RE.test(line.slice('shallow '.length))) fail(`malformed shallow line: ${JSON.stringify(line)}`);
			continue;
		}
		const first = !sawCommand;
		sawCommand = true;

		// Capabilities ride on the first command (or the push-cert line) after a NUL;
		// any `shallow` lines come before it.
		const nulIdx = line.indexOf('\0');
		if (nulIdx !== -1) {
			if (!first) fail('capabilities on a non-first command line');
			capabilities = line.slice(nulIdx + 1).split(' ').filter(Boolean);
			line = line.slice(0, nulIdx);
		}

		if (first && line === 'push-cert') {
			inPushCert = true;
			continue;
		}
		if (inPushCert) {
			// Only the command lines in the cert matter; everything else is cert metadata/signature.
			if (line === 'push-cert-end') {
				inPushCert = false;
				continue;
			}
			if (line.startsWith('-----BEGIN PGP SIGNATURE-----') || line.startsWith('-----BEGIN SSH SIGNATURE-----')) {
				inSignature = true;
			}
			if (inSignature) continue;
			const cmd = line.split(' ');
			if (cmd.length === 3 && OID_RE.test(cmd[0]) && OID_RE.test(cmd[1])) {
				refs.push(makeRefUpdate(cmd[0], cmd[1], cmd[2]));
			}
			continue;
		}

		const parts = line.split(' ');
		if (parts.length !== 3) fail(`malformed command line: ${JSON.stringify(line.slice(0, 200))}`);
		const [oldSha, newSha, refName] = parts;
		if (!OID_RE.test(oldSha) || !OID_RE.test(newSha)) {
			fail(`malformed object id in command line: ${JSON.stringify(line.slice(0, 200))}`);
		}
		if (!refName) fail('empty ref name in command line');
		refs.push(makeRefUpdate(oldSha, newSha, refName));
	}

	if (!sawFlush) fail('receive-pack command list not terminated by a flush-pkt');
	if (inPushCert) fail('unterminated push-cert block');

	const isProbe = lineNo === 0 && offset === 4 && buffer.length === 4;
	if (refs.length === 0 && !isProbe) fail('receive-pack request contains no ref update commands');

	return { refs, capabilities, isProbe, commandSectionLength: offset };
}

function makeRefUpdate(oldSha: string, newSha: string, refName: string): RefUpdate {
	const { kind, shortName } = classifyRef(refName);
	return {
		oldSha,
		newSha,
		refName,
		kind,
		shortName,
		isCreate: ZERO_OID_RE.test(oldSha),
		isDelete: ZERO_OID_RE.test(newSha),
	};
}

// ─── Sideband ───────────────────────────────────────────────────

/**
 * True if the stream's first data pkt-line carries a sideband band byte
 * (1, 2 or 3). Raw report-status starts with "unpack ", so this is unambiguous.
 */
export function isSidebandStream(body: ArrayBuffer | Uint8Array): boolean {
	const buffer = toBytes(body);
	let offset = 0;
	try {
		while (true) {
			const read = readPkt(buffer, offset);
			if (!read) return false;
			offset = read.next;
			if (read.pkt.type === 'data') {
				const band = read.pkt.payload[0];
				return band === 1 || band === 2 || band === 3;
			}
		}
	} catch {
		return false;
	}
}

/**
 * Demultiplex a side-band / side-band-64k stream. Reads outer pkt-lines until
 * the outer flush (or end of input) and concatenates every band-1 payload.
 * Band 2 (progress) and band 3 (fatal error) are returned as text.
 * Throws PktLineError on malformed outer framing or an unknown band.
 */
export function demuxSideband(body: ArrayBuffer | Uint8Array): {
	band1: Uint8Array;
	progress: string[];
	errors: string[];
	bytesConsumed: number;
} {
	const buffer = toBytes(body);
	const band1: Uint8Array[] = [];
	const progress: string[] = [];
	const errors: string[] = [];
	let offset = 0;

	while (true) {
		const read = readPkt(buffer, offset);
		if (!read) break;
		offset = read.next;
		if (read.pkt.type === 'flush') break;
		if (read.pkt.type !== 'data') continue;

		const payload = read.pkt.payload;
		if (payload.length === 0) continue;
		const band = payload[0];
		const data = payload.subarray(1);
		if (band === 1) band1.push(data);
		else if (band === 2) progress.push(decoder.decode(data));
		else if (band === 3) errors.push(decoder.decode(data));
		else throw new PktLineError(`unknown sideband band ${band} at offset ${offset - payload.length - 4}`);
	}

	return { band1: concatBytes(band1), progress, errors, bytesConsumed: offset };
}

/**
 * Frame `data` as band-`band` sideband pkt-lines (no trailing flush), split
 * into chunks that fit the negotiated sideband flavour.
 */
export function encodeSideband(data: Uint8Array, band: 1 | 2 | 3, maxPayload = SIDEBAND_64K_MAX): Uint8Array {
	const chunkSize = maxPayload - 1; // minus band byte
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < data.length; i += chunkSize) {
		const slice = data.subarray(i, Math.min(i + chunkSize, data.length));
		const payload = new Uint8Array(slice.length + 1);
		payload[0] = band;
		payload.set(slice, 1);
		chunks.push(encodePktLine(payload));
	}
	return concatBytes(chunks);
}

/** The sideband flavour the client asked for in its capabilities, if any. */
export function negotiatedSideband(capabilities: readonly string[] | undefined): 'side-band-64k' | 'side-band' | null {
	if (!capabilities) return null;
	if (capabilities.includes('side-band-64k')) return 'side-band-64k';
	if (capabilities.includes('side-band')) return 'side-band';
	return null;
}

// ─── Response Parsing ───────────────────────────────────────────

/**
 * Parse a git-receive-pack response (report-status / report-status-v2).
 *
 * Accepts either a raw report-status stream:
 *   000eunpack ok\n  0019ok refs/heads/main\n  0000
 * or the same stream sideband-wrapped (demuxed per the rule at the top of this file).
 *
 * Returns null if no report-status could be found — callers must treat that
 * as "no ref is known to have been updated".
 */
export function parseReceivePackResponse(body: ArrayBuffer | Uint8Array): ReportStatus | null {
	const buffer = toBytes(body);
	let report = buffer;
	let progress: string[] = [];
	let errors: string[] = [];

	try {
		if (isSidebandStream(buffer)) {
			const demuxed = demuxSideband(buffer);
			report = demuxed.band1;
			progress = demuxed.progress;
			errors = demuxed.errors;
		}
	} catch {
		return null;
	}

	let unpackSeen = false;
	let unpackOk = false;
	let unpackError: string | undefined;
	const refResults: RefResult[] = [];
	let offset = 0;

	try {
		while (true) {
			const read = readPkt(report, offset);
			if (!read) break;
			offset = read.next;
			if (read.pkt.type === 'flush') break;
			if (read.pkt.type !== 'data') continue;

			const line = pktText(read.pkt.payload);
			if (line.startsWith('unpack ')) {
				unpackSeen = true;
				const status = line.slice('unpack '.length).trim();
				unpackOk = status === 'ok';
				if (!unpackOk) unpackError = status;
			} else if (line.startsWith('ok ')) {
				refResults.push({ refName: line.slice('ok '.length).trim(), success: true });
			} else if (line.startsWith('ng ')) {
				const rest = line.slice('ng '.length).trim();
				const spaceIdx = rest.indexOf(' ');
				refResults.push({
					refName: spaceIdx === -1 ? rest : rest.slice(0, spaceIdx),
					success: false,
					error: spaceIdx === -1 ? 'unknown error' : rest.slice(spaceIdx + 1),
				});
			}
			// report-status-v2 `option ...` lines refine the previous ref; not needed here.
		}
	} catch {
		// Malformed inner framing: fall through with whatever was read.
	}

	if (!unpackSeen) {
		if (errors.length === 0) return null;
		// Band-3 fatal error with no report: the push failed.
		return { unpackOk: false, unpackError: errors.join('; ').trim(), refResults: [], progress, errors };
	}

	return { unpackOk, unpackError, refResults, progress, errors };
}

// ─── Building responses for the client ─────────────────────────

/** Build a raw report-status stream (pkt-lines + flush). */
export function buildReportStatus(unpackStatus: string, refs: { refName: string; error?: string }[]): Uint8Array {
	const lines: Uint8Array[] = [encodePktLine(`unpack ${unpackStatus}\n`)];
	for (const ref of refs) {
		lines.push(encodePktLine(ref.error ? `ng ${ref.refName} ${ref.error}\n` : `ok ${ref.refName}\n`));
	}
	lines.push(encoder.encode(FLUSH_PKT));
	return concatBytes(lines);
}

/** Report-status rejecting every ref in `refs` with `reason`. */
export function buildRejectResponse(refs: { refName: string }[], reason: string): Uint8Array {
	return buildReportStatus('ok', refs.map(r => ({ refName: r.refName, error: reason })));
}

/**
 * Frame a raw report-status stream for the client: band-1 sideband + outer
 * flush if the client negotiated sideband, unchanged otherwise.
 */
export function frameReportForClient(report: Uint8Array, sideband: 'side-band-64k' | 'side-band' | null): Uint8Array {
	if (!sideband) return report;
	const max = sideband === 'side-band-64k' ? SIDEBAND_64K_MAX : SIDEBAND_MAX;
	return concatBytes([encodeSideband(report, 1, max), encoder.encode(FLUSH_PKT)]);
}

/**
 * A band-3 (fatal error) sideband message + flush. The client prints
 * "remote error: <message>" and aborts the push.
 */
export function buildSidebandError(message: string, sideband: 'side-band-64k' | 'side-band'): Uint8Array {
	const max = sideband === 'side-band-64k' ? SIDEBAND_64K_MAX : SIDEBAND_MAX;
	return concatBytes([encodeSideband(encoder.encode(`${message}\n`), 3, max), encoder.encode(FLUSH_PKT)]);
}

/**
 * Adapt an upstream (Artifacts) receive-pack response to the framing the
 * client negotiated:
 *  - upstream sideband + client sideband → pass through
 *  - upstream raw      + client sideband → wrap in band 1
 *  - upstream sideband + client raw      → demux, send band-1 only
 *  - upstream raw      + client raw      → pass through
 */
export function adaptReceivePackResponse(
	upstream: ArrayBuffer | Uint8Array,
	sideband: 'side-band-64k' | 'side-band' | null
): Uint8Array {
	const buffer = toBytes(upstream);
	if (buffer.length === 0) return buffer;
	const upstreamSideband = isSidebandStream(buffer);
	if (upstreamSideband === !!sideband) return buffer;
	if (sideband) return frameReportForClient(buffer, sideband);
	try {
		return demuxSideband(buffer).band1;
	} catch {
		return buffer;
	}
}

// ─── Diagnostics ────────────────────────────────────────────────

/** Classic `offset  hex bytes  |ascii|` dump of the first `maxBytes` bytes. */
export function hexDump(body: ArrayBuffer | Uint8Array, maxBytes = 4096): string {
	const buffer = toBytes(body);
	const n = Math.min(buffer.length, maxBytes);
	const rows: string[] = [];
	for (let i = 0; i < n; i += 16) {
		const row = buffer.subarray(i, Math.min(i + 16, n));
		const hex = Array.from(row, b => b.toString(16).padStart(2, '0')).join(' ');
		const ascii = Array.from(row, b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
		rows.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii}|`);
	}
	if (buffer.length > n) rows.push(`… ${buffer.length - n} more bytes`);
	return rows.join('\n');
}
