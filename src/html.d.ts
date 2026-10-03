// Allow importing .html files as strings (wrangler bundles these as text modules)
declare module '*.html' {
	const content: string;
	export default content;
}

// Allow importing .png files as binary ArrayBuffer (wrangler bundles these as binary modules)
declare module '*.png' {
	const content: ArrayBuffer;
	export default content;
}
