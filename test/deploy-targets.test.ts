import { describe, expect, it } from 'vitest';
import {
	isDeployTargetType,
	isValidCloudRunService,
	isValidGcpProjectId,
	isValidGcpRegion,
	normaliseGcpServiceAccountKey,
} from '../src/lib/deploy-targets.ts';

describe('deploy target types', () => {
	it('accepts the three supported types only', () => {
		expect(isDeployTargetType('coolify')).toBe(true);
		expect(isDeployTargetType('cloudflare')).toBe(true);
		expect(isDeployTargetType('cloudrun')).toBe(true);
		expect(isDeployTargetType('gcp')).toBe(false);
		expect(isDeployTargetType(undefined)).toBe(false);
	});
});

describe('GCP identifier validation', () => {
	it.each([
		['my-project', true],
		['my-project-123456', true],
		['abc123', true],
		['Abc123', false], // uppercase
		['-project', false], // leading hyphen
		['my-project-', false], // trailing hyphen
		['short', false], // 5 chars
		['a'.repeat(31), false],
		['my project', false],
		['my;project', false], // shell metachar
	])('project id %s → %s', (value, expected) => {
		expect(isValidGcpProjectId(value)).toBe(expected);
	});

	it.each([
		['us-central1', true],
		['europe-west4', true],
		['asia-northeast1', true],
		['us-central', false],
		['US-CENTRAL1', false],
		['us-central1 --flag', false],
		['', false],
	])('region %s → %s', (value, expected) => {
		expect(isValidGcpRegion(value)).toBe(expected);
	});

	it.each([
		['api', true],
		['my-app-2', true],
		['a', true],
		['a'.repeat(49), true],
		['a'.repeat(50), false],
		['My-App', false],
		['1app', false],
		['app-', false],
		['app_x', false],
		['app;rm', false],
	])('service %s → %s', (value, expected) => {
		expect(isValidCloudRunService(value)).toBe(expected);
	});
});

describe('normaliseGcpServiceAccountKey', () => {
	const valid = {
		type: 'service_account',
		project_id: 'my-project',
		private_key_id: 'abc',
		private_key: '-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----\n',
		client_email: 'deploy@my-project.iam.gserviceaccount.com',
	};

	it('accepts a service-account key and re-serialises it', () => {
		const out = normaliseGcpServiceAccountKey(JSON.stringify(valid, null, 2));
		expect(out).not.toBeNull();
		expect(JSON.parse(out!)).toEqual(valid);
	});

	it('rejects non-JSON, non-objects and other credential types', () => {
		expect(normaliseGcpServiceAccountKey('not json')).toBeNull();
		expect(normaliseGcpServiceAccountKey('[]')).toBeNull();
		expect(normaliseGcpServiceAccountKey(JSON.stringify({ ...valid, type: 'authorized_user' }))).toBeNull();
	});

	it.each(['project_id', 'client_email', 'private_key'])('rejects a key missing %s', (field) => {
		const { [field]: _omit, ...rest } = valid as Record<string, string>;
		expect(normaliseGcpServiceAccountKey(JSON.stringify(rest))).toBeNull();
	});
});
