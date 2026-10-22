#!/usr/bin/env node
// Navigate to URL in current or new tab
const http = require('http');

const url = process.argv[2];
const newTab = process.argv.includes('--new');

if (!url) {
  console.error('Usage: nav.cjs <url> [--new]');
  process.exit(1);
}

async function requestJson(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: 9222, path, method }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 405 && method === 'PUT') {
          resolve(requestJson(path, 'GET'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Chrome ${method} ${path}: HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Chrome ${method} ${path}: non-JSON response: ${data.slice(0, 200)}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function getTargets() {
  return requestJson('/json');
}

async function createTab(url) {
  return requestJson(`/json/new?${encodeURIComponent(url)}`, 'PUT');
}

async function navigate(targetId, url) {
  const WebSocket = require('ws');
  const targets = await getTargets();
  const target = targets.find(t => t.id === targetId);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } }));
    });
    ws.on('message', data => {
      const msg = JSON.parse(data);
      if (msg.id === 1) {
        ws.close();
        resolve(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

(async () => {
  try {
    if (newTab) {
      const tab = await createTab(url);
      console.log(JSON.stringify({ action: 'created', tabId: tab.id, url }));
    } else {
      const targets = await getTargets();
      const page = targets.find(t => t.type === 'page');
      if (!page) throw new Error('No active page found');
      await navigate(page.id, url);
      console.log(JSON.stringify({ action: 'navigated', tabId: page.id, url }));
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
