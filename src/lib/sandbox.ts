export type SandboxTier = 'micro' | 'small' | 'medium' | 'large';

export interface SandboxInstance {
  id: string;
  tier: SandboxTier;
  image: string;
  ready: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Creates a new sandbox instance.
 * @param tier The sandbox tier.
 * @param image The image to use. Default is 'gitflare-runner'.
 * @returns A promise resolving to the SandboxInstance.
 */
export async function createSandbox(tier: SandboxTier, image: string = 'gitflare-runner'): Promise<SandboxInstance> {
  // TODO: Replace with actual @cloudflare/sandbox SDK calls when available.
  console.log(`[Sandbox] Creating ${tier} sandbox with image ${image}...`);
  
  return {
    id: crypto.randomUUID(),
    tier,
    image,
    ready: true
  };
}

/**
 * Executes a sequence of commands in a sandbox.
 * @param sandbox The sandbox instance.
 * @param commands The commands to run.
 * @returns Results for each command and overall status.
 */
export async function runInSandbox(
  sandbox: SandboxInstance, 
  commands: { name: string, command: string, env?: Record<string, string>, timeout?: number }[]
): Promise<{ results: (ExecResult & { name: string })[], allPassed: boolean }> {
  // TODO: Replace with actual @cloudflare/sandbox SDK calls when available.
  console.log(`[Sandbox] Running ${commands.length} commands in sandbox ${sandbox.id}...`);
  
  const results: (ExecResult & { name: string })[] = [];
  let allPassed = true;

  for (const cmd of commands) {
    console.log(`[Sandbox] Executing: ${cmd.name} - ${cmd.command}`);
    
    // Simulate execution
    const success = Math.random() > 0.1; // 90% success rate for simulation
    const result = {
      name: cmd.name,
      exitCode: success ? 0 : 1,
      stdout: success ? `Successfully executed ${cmd.name}\n` : '',
      stderr: success ? '' : `Error executing ${cmd.name}\n`
    };
    
    results.push(result);
    
    if (!success) {
      allPassed = false;
      break; // Stop on first failure
    }
  }

  return { results, allPassed };
}

/**
 * Heuristic to determine the right sandbox tier based on repo characteristics.
 * @param repoName The name of the repository.
 * @param defaultTier The default tier to fall back to.
 * @returns The selected sandbox tier.
 */
export function getSandboxTierForRepo(repoName: string, defaultTier: SandboxTier): SandboxTier {
  // TODO: Analyze repo size, language, etc. to pick the best tier.
  return defaultTier;
}
