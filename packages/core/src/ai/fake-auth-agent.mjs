import readline from 'node:readline';
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
if (process.argv.includes('--login')) {
  process.stdout.write('Device code: TEST-1234\r\nhttps://example.com/device\r\nEnter confirmation: ');
  process.stdin.once('data', data => {
    if (String(data).trim() === 'yes' && process.env.AUTH_METHOD_ENV === 'present') {
      writeFileSync(process.env.AUTH_FILE, 'provider-owned-credential'); process.exit(0);
    }
    process.exit(1);
  });
} else {
  let pending;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (!message.method) {
      if (message.id === 'browser-login' && pending) {
        if (message.result?.action === 'accept') { writeFileSync(process.env.AUTH_FILE, 'provider-owned-credential'); send({ id: pending, result: {} }); }
        else send({ id: pending, error: { code: -32000, message: 'Authentication cancelled' } });
      }
      return;
    }
    appendFileSync(process.env.AUTH_LOG, `${message.method}\n`);
    const ok = result => send({ id: message.id, result });
    if (message.method === 'initialize') return ok({ protocolVersion: 1, agentCapabilities: {}, authMethods: [
      { id: 'browser', name: 'Browser sign-in' },
      { id: 'terminal', name: 'Device sign-in', type: 'terminal', args: ['--login'], env: { AUTH_METHOD_ENV: 'present' } }
    ] });
    if (message.method === 'authenticate') {
      pending = message.id;
      return send({ id: 'browser-login', method: 'elicitation/create', params: { mode: 'url', requestId: message.id, elicitationId: 'login', url: process.env.AUTH_URL ?? 'https://example.com/login', message: 'Finish signing in in your browser.' } });
    }
    if (message.method === 'session/new') return existsSync(process.env.AUTH_FILE) ? ok({ sessionId: 'verified' }) : send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
  });
}
