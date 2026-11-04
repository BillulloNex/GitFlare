/**
 * Input validation for repository names and git ref names.
 */

const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Repo names: 1–100 chars of `[A-Za-z0-9._-]`. Also rejects `.`/`..`, a
 * trailing `.git`, and a leading `-` (could be parsed as a CLI flag).
 */
export function isValidRepoName(name: string): boolean {
	if (!REPO_NAME_RE.test(name)) return false;
	if (name === '.' || name === '..') return false;
	if (name.startsWith('-')) return false;
	if (name.toLowerCase().endsWith('.git')) return false;
	return true;
}

/**
 * Git ref name rules (git-check-ref-format), applied to either a full ref
 * (`refs/heads/main`) or a short branch name (`main`, `feature/x`):
 *
 *  - not empty, not `@`, max 255 chars
 *  - no ASCII control chars, space, DEL, `~ ^ : ? * [ \`
 *  - no `..`, no `@{`, no `//`
 *  - does not begin or end with `/`, does not end with `.`
 *  - no component begins with `.` or ends with `.lock`
 *  - does not begin with `-`
 */
export function isValidRefName(ref: string): boolean {
	if (!ref || ref.length > 255 || ref === '@') return false;
	if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
	if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
	if (ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) return false;
	if (ref.startsWith('-')) return false;
	for (const component of ref.split('/')) {
		if (component.startsWith('.') || component.endsWith('.lock')) return false;
	}
	return true;
}
