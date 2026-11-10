import { describe, expect, it } from 'vitest';
import authApp from '../src/api/auth.ts';
import type { Env } from '../src/env.ts';

const env = { APP_URL: 'https://git.example.test', GOOGLE_CLIENT_ID: 'test-client' } as Env;

describe('Capture Station sign-in', () => {
	it('returns to the station after OAuth when requested', async () => {
		const response = await authApp.request('/login?next=/station', {}, env);
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toContain('accounts.google.com');
		expect(response.headers.getSetCookie()).toEqual(expect.arrayContaining([
			expect.stringContaining('gf_oauth_state='),
			expect.stringContaining('gf_oauth_next=station;'),
		]));
	});

	it('clears an earlier station destination for a normal login', async () => {
		const response = await authApp.request('/login', {}, env);
		expect(response.headers.getSetCookie()).toEqual(expect.arrayContaining([
			expect.stringContaining('gf_oauth_next=;'),
		]));
	});
});
