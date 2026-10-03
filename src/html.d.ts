// Allow importing .html files as strings (wrangler bundles these as text modules)
declare module '*.html' {
	const content: string;
	export default content;
}
