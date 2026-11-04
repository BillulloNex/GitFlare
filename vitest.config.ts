import { defineConfig } from 'vitest/config';

// Unit tests for pure modules (protocol parsing, crypto, access rules, client).
// They run in Node: WebCrypto, atob/btoa, fetch/Response are all globals in Node 22.
// Anything needing real Worker bindings belongs in a separate workers-pool project.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
	},
});
