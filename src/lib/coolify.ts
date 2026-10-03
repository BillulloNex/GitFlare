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

	/**
	 * Get application details
	 */
	async getApplication(appId: string): Promise<any> {
		return this.request(`/api/v1/applications/${appId}`);
	}
}
