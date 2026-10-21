/**
 * Coolify API Client
 */
export class CoolifyClient {
	constructor(
		private baseUrl: string,
		private apiKey: string
	) {}

	private async request(path: string, options: RequestInit = {}) {
		const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
		const response = await fetch(url, {
			...options,
			headers: {
				'Authorization': `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				...options.headers,
			}
		});

		if (!response.ok) {
			let errorMsg = `Coolify API error: ${response.status} ${response.statusText}`;
			try {
				const errorBody = await response.json() as any;
				if (errorBody.message) {
					errorMsg += ` - ${errorBody.message}`;
				}
			} catch (e) {
				// ignore
			}
			throw new Error(errorMsg);
		}

		return response.json();
	}

	/**
	 * Deploy an application
	 */
	async deploy(appId: string): Promise<any> {
		return this.request(`/api/v1/deploy?uuid=${appId}&force=false`, {
			method: 'POST'
		});
	}

	/**
	 * Check deployment status
	 */
	async getDeploymentStatus(appId: string, deploymentId: string): Promise<any> {
		return this.request(`/api/v1/applications/${appId}/deployments/${deploymentId}`);
	}

	async getDeployment(deploymentUuid: string): Promise<{ status?: string }> {
		return this.request(`/api/v1/deployments/${deploymentUuid}`) as Promise<{ status?: string }>;
	}

	/**
	 * Get application details
	 */
	async getApplication(appId: string): Promise<any> {
		return this.request(`/api/v1/applications/${appId}`);
	}
}

const COOLIFY_OK = new Set(['finished', 'success', 'succeeded']);
const COOLIFY_PENDING = new Set(['in_progress', 'in-progress', 'queued', 'pending', 'running']);

export function coolifyDeploymentId(payload: any): string | null {
	const id = payload?.deployments?.[0]?.deployment_uuid
		|| payload?.deployment_uuid
		|| payload?.uuid
		|| null;
	return typeof id === 'string' && id ? id : null;
}

/** Poll until Coolify reports a terminal status. Never treats "accepted" as success. */
export async function waitForCoolifyDeployment(
	client: CoolifyClient,
	deploymentUuid: string,
	timeoutMs = 8 * 60 * 1000,
): Promise<'success' | 'failed' | 'timeout'> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const data = await client.getDeployment(deploymentUuid);
		const status = String(data?.status || '').toLowerCase();
		if (COOLIFY_OK.has(status)) return 'success';
		if (status && !COOLIFY_PENDING.has(status)) return 'failed';
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
	return 'timeout';
}
