/**
 * Git Smart HTTP Protocol Parser
 * 
 * Parses pkt-line format used by git smart HTTP protocol to extract
 * ref update commands from receive-pack requests and parse
 * report-status from receive-pack responses.
 * 
 * References:
 * - https://git-scm.com/docs/pack-protocol
 * - https://git-scm.com/docs/protocol-v2
 */

// ─── Types ──────────────────────────────────────────────────────

export interface RefUpdate {
	oldSha: string;
	newSha: string;
	refName: string;       // e.g. "refs/heads/main"
	branch: string;        // e.g. "main" (extracted from refName)
	isCreate: boolean;     // oldSha is all zeros
	isDelete: boolean;     // newSha is all zeros
}

export interface RefResult {
	refName: string;
	branch: string;
	success: boolean;
	error?: string;        // e.g. "non-fast-forward"
}

export interface ReceivePackParsed {
	refs: RefUpdate[];
	capabilities: string[];
}

export interface ReportStatus {
	unpackOk: boolean;
	unpackError?: string;
	refResults: RefResult[];
}

// ─── Constants ──────────────────────────────────────────────────

const ZERO_SHA = '0000000000000000000000000000000000000000';
const FLUSH_PKT = '0000';

// ─── pkt-line Parsing ───────────────────────────────────────────

/**
 * Parse pkt-lines from a Uint8Array buffer until a flush packet (0000).
 * Returns the parsed text lines and the byte offset where parsing stopped.
 */
function parsePktLines(buffer: Uint8Array): { lines: string[]; bytesConsumed: number } {
	const decoder = new TextDecoder();
	const lines: string[] = [];
	let offset = 0;

	while (offset + 4 <= buffer.length) {
		const lenHex = decoder.decode(buffer.subarray(offset, offset + 4));

		// Flush packet — end of this section
		if (lenHex === FLUSH_PKT) {
			offset += 4;
			break;
		}

		// Delimiter (0001) or response-end (0002) 
		if (lenHex === '0001' || lenHex === '0002') {
			offset += 4;
			break;
		}

		const len = parseInt(lenHex, 16);
		if (isNaN(len) || len < 4) {
			break; // Invalid pkt-line, stop parsing
		}

		if (offset + len > buffer.length) {
			break; // Incomplete packet
		}

		// Extract the line content (skip the 4-byte length prefix)
		const lineBytes = buffer.subarray(offset + 4, offset + len);
		let line = decoder.decode(lineBytes);

		// Strip trailing newline
		if (line.endsWith('\n')) {
			line = line.slice(0, -1);
		}

		lines.push(line);
		offset += len;
	}

	return { lines, bytesConsumed: offset };
}

// ─── Request Parsing ────────────────────────────────────────────

/**
 * Parse a git-receive-pack request body to extract ref update commands.
 * 
 * Request format (pkt-line):
 *   <old-sha> <new-sha> <refname>\0<capabilities>\n   (first line)
 *   [<old-sha> <new-sha> <refname>\n]*                (subsequent)
 *   0000                                               (flush)
 *   <packfile binary data>
 * 
 * @param body The raw request body as ArrayBuffer
 * @returns Parsed ref updates and capabilities
 */
export function parseReceivePackRequest(body: ArrayBuffer): ReceivePackParsed {
	const buffer = new Uint8Array(body);
	const { lines } = parsePktLines(buffer);

	const refs: RefUpdate[] = [];
	let capabilities: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		let caps: string[] = [];

		// First line has capabilities after a NUL byte
		const nulIdx = line.indexOf('\0');
		if (nulIdx !== -1) {
			caps = line.slice(nulIdx + 1).split(' ').filter(Boolean);
			line = line.slice(0, nulIdx);
			capabilities = caps;
		}

		// Parse: <old-sha> <new-sha> <refname>
		const parts = line.split(' ');
		if (parts.length < 3) continue;

		const [oldSha, newSha, ...refParts] = parts;
		const refName = refParts.join(' '); // ref names shouldn't have spaces, but be safe

		// Validate SHA format (40 hex chars)
		if (!/^[0-9a-f]{40}$/.test(oldSha) || !/^[0-9a-f]{40}$/.test(newSha)) {
			continue;
		}

		// Extract branch name from refName (refs/heads/main → main)
		let branch = refName;
		if (refName.startsWith('refs/heads/')) {
			branch = refName.slice('refs/heads/'.length);
		} else if (refName.startsWith('refs/tags/')) {
			branch = refName.slice('refs/tags/'.length);
		}

		refs.push({
			oldSha,
			newSha,
			refName,
			branch,
			isCreate: oldSha === ZERO_SHA,
			isDelete: newSha === ZERO_SHA,
		});
	}

	return { refs, capabilities };
}

// ─── Response Parsing ───────────────────────────────────────────

/**
 * Parse a git-receive-pack response to extract the report-status.
 * 
 * Response format (pkt-line):
 *   unpack ok\n                         (or "unpack <error>")
 *   ok <refname>\n                      (for successful updates)
 *   ng <refname> <reason>\n             (for rejected updates)
 *   0000                                (flush)
 * 
 * The response may also contain sideband data (band 1 = packfile data,
 * band 2 = progress, band 3 = error). We handle this gracefully.
 * 
 * @param body The raw response body as ArrayBuffer
 * @returns Parsed report status, or null if response couldn't be parsed
 */
export function parseReceivePackResponse(body: ArrayBuffer): ReportStatus | null {
	const buffer = new Uint8Array(body);
	const { lines } = parsePktLines(buffer);

	if (lines.length === 0) return null;

	let unpackOk = false;
	let unpackError: string | undefined;
	const refResults: RefResult[] = [];

	for (const rawLine of lines) {
		// Handle sideband: first byte might be \x01, \x02, \x03
		let line = rawLine;
		const firstByte = rawLine.charCodeAt(0);
		if (firstByte === 1 || firstByte === 2 || firstByte === 3) {
			line = rawLine.slice(1);
		}

		if (line.startsWith('unpack ')) {
			const status = line.slice('unpack '.length).trim();
			unpackOk = status === 'ok';
			if (!unpackOk) {
				unpackError = status;
			}
		} else if (line.startsWith('ok ')) {
			const refName = line.slice('ok '.length).trim();
			let branch = refName;
			if (refName.startsWith('refs/heads/')) {
				branch = refName.slice('refs/heads/'.length);
			}
			refResults.push({ refName, branch, success: true });
		} else if (line.startsWith('ng ')) {
			const rest = line.slice('ng '.length).trim();
			const spaceIdx = rest.indexOf(' ');
			const refName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
			const error = spaceIdx === -1 ? 'unknown error' : rest.slice(spaceIdx + 1);
			let branch = refName;
			if (refName.startsWith('refs/heads/')) {
				branch = refName.slice('refs/heads/'.length);
			}
			refResults.push({ refName, branch, success: false, error });
		}
	}

	return { unpackOk, unpackError, refResults };
}

/**
 * Build a git protocol error response in pkt-line format.
 * This is what the client sees as a push rejection.
 */
export function buildRejectResponse(refs: RefUpdate[], reason: string): Uint8Array {
	const encoder = new TextEncoder();
	const lines: Uint8Array[] = [];

	// unpack ok
	lines.push(encodePktLine('unpack ok\n'));

	// Reject each ref
	for (const ref of refs) {
		lines.push(encodePktLine(`ng ${ref.refName} ${reason}\n`));
	}

	// Flush
	lines.push(encoder.encode(FLUSH_PKT));

	// Concatenate
	const totalLen = lines.reduce((sum, l) => sum + l.length, 0);
	const result = new Uint8Array(totalLen);
	let offset = 0;
	for (const line of lines) {
		result.set(line, offset);
		offset += line.length;
	}

	return result;
}

function encodePktLine(content: string): Uint8Array {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const len = data.length + 4; // 4 bytes for the length prefix itself
	const lenHex = len.toString(16).padStart(4, '0');
	const prefix = encoder.encode(lenHex);

	const result = new Uint8Array(prefix.length + data.length);
	result.set(prefix, 0);
	result.set(data, prefix.length);
	return result;
}
