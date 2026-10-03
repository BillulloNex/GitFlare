import * as http from 'node:http';

const PORT = process.env.PORT || 7654;
const RUNNER_SECRET = process.env.RUNNER_SECRET;
const COOLIFY_BASE_URL = process.env.COOLIFY_BASE_URL || 'https://cloud.comfyspace.tech';
const COOLIFY_API_KEY = process.env.COOLIFY_API_KEY;

async function pollDeployment(deploymentUuid: string, runId: string, callbackUrl: string, startTime: number) {
  const checkInterval = 15000;
  
  const poll = async () => {
    try {
      const response = await fetch(`${COOLIFY_BASE_URL}/api/v1/deployments/${deploymentUuid}`, {
        headers: { 'Authorization': `Bearer ${COOLIFY_API_KEY}` }
      });
      
      if (!response.ok) {
        throw new Error(`Coolify API error: ${response.status}`);
      }
      
      const data = await response.json();
      const status = data.status;
      
      if (status !== 'in_progress') {
        const finalStatus = status === 'finished' ? 'success' : 'failed';
        const durationMs = Date.now() - startTime;
        
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId, status: finalStatus, deploymentUuid, durationMs })
        }).catch(err => console.error("Callback failed", err));
        
        return;
      }
      setTimeout(poll, checkInterval);
    } catch (error) {
      console.error("Polling error", error);
      setTimeout(poll, checkInterval);
    }
  };
  
  setTimeout(poll, checkInterval);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }
  
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${RUNNER_SECRET}`) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        if (url.pathname === '/webhook/deploy') {
          const payload = JSON.parse(body);
          const { runId, coolifyAppId, callbackUrl } = payload;
          
          if (!runId || !coolifyAppId || !callbackUrl) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing fields' }));
            return;
          }

          const coolifyRes = await fetch(`${COOLIFY_BASE_URL}/api/v1/deploy?uuid=${coolifyAppId}&force=false`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${COOLIFY_API_KEY}`,
              'Content-Type': 'application/json'
            }
          });

          if (!coolifyRes.ok) {
            const errBody = await coolifyRes.text();
            console.error(`Coolify deploy failed: ${coolifyRes.status} ${coolifyRes.statusText}`, errBody);
            console.error(`URL: ${COOLIFY_BASE_URL}/api/v1/applications/${coolifyAppId}/deploy`);
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'Failed Coolify deployment', status: coolifyRes.status, detail: errBody }));
            return;
          }

          const coolifyData = await coolifyRes.json() as any;
          const deploymentUuid = coolifyData.deployments?.[0]?.deployment_uuid || coolifyData.deployment_uuid || coolifyData.uuid;
          
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted', deploymentUuid }));
          
          pollDeployment(deploymentUuid, runId, callbackUrl, Date.now());
        } else if (url.pathname === '/webhook/ci') {
          res.writeHead(501);
          res.end(JSON.stringify({ error: 'Not Implemented' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    });
    return;
  }
  
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Runner listening on port ${PORT}`);
  console.log(`COOLIFY_BASE_URL: ${COOLIFY_BASE_URL}`);
  console.log(`COOLIFY_API_KEY: ${COOLIFY_API_KEY ? '***set***' : 'MISSING'}`);
  console.log(`RUNNER_SECRET: ${RUNNER_SECRET ? '***set***' : 'MISSING'}`);
});
