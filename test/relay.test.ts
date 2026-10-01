import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import forge from 'node-forge';
import https from 'node:https';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * O intermediário da busca na SEF (relay/relay.mjs) contra um servidor que imita o
 * IIS da SEF: TLS 1.2, raiz sem certificado e /ws/ pedindo o certificado por
 * RENEGOCIAÇÃO no meio da conexão — o que derrubou o fetch da Cloudflare (520).
 *
 * O servidor falso retoma sessão quando pode. Foi assim que o primeiro intermediário
 * falhou aqui: retomada a sessão, o certificado não ia. Este teste trava isso.
 */

function certificado(cn: string, emissor?: { cert: forge.pki.Certificate; chave: forge.pki.rsa.PrivateKey }) {
  const chaves = forge.pki.rsa.generateKeyPair(1024);
  const c = forge.pki.createCertificate();
  c.publicKey = chaves.publicKey;
  c.serialNumber = String(Math.floor(Math.random() * 1e9));
  c.validity.notBefore = new Date(Date.now() - 86400000);
  c.validity.notAfter = new Date(Date.now() + 86400000);
  c.setSubject([{ name: 'commonName', value: cn }]);
  c.setIssuer(emissor ? emissor.cert.subject.attributes : [{ name: 'commonName', value: cn }]);
  if (cn === 'localhost') c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]);
  if (!emissor) c.setExtensions([{ name: 'basicConstraints', cA: true }]);
  c.sign(emissor ? emissor.chave : chaves.privateKey, forge.md.sha256.create());
  return { cert: c, chave: chaves.privateKey, pem: forge.pki.certificateToPem(c), chavePem: forge.pki.privateKeyToPem(chaves.privateKey) };
}

const TOKEN = 'token-de-teste-do-intermediario-1234567890';
let iis: https.Server;
let relay: ChildProcess;
let porta = 0;
let dir = '';
const ac = certificado('AC TESTE');
const srv = certificado('localhost', ac);
const cli = certificado('ISA TESTE:12345678909', ac);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-'));
  writeFileSync(join(dir, 'ca.pem'), ac.pem);
  iis = https.createServer({ key: srv.chavePem, cert: srv.pem, ca: ac.pem, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }, (req, res) => {
    if (!req.url!.startsWith('/ws/')) { res.writeHead(403); res.end('403 - Forbidden: Access is denied.'); return; }
    const sock = req.socket as import('node:tls').TLSSocket;
    // Como o IIS: renegocia só se a conexão ainda não tem certificado.
    const seguir = (f: () => void) => (sock.getPeerCertificate()?.subject ? f() : sock.renegotiate({ requestCert: true, rejectUnauthorized: false }, f));
    seguir(() => {
      const c = sock.getPeerCertificate();
      let corpo = '';
      req.on('data', (d) => (corpo += d));
      req.on('end', () => {
        if (!c?.subject) { res.writeHead(403); res.end('403.7 sem certificado'); return; }
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(`<ok cn="${c.subject.CN}" metodo="${req.method}" url="${req.url}" soap='${req.headers.soapaction ?? ''}' tam="${corpo.length}"/>`);
      });
    });
  });
  await new Promise<void>((ok) => iis.listen(0, ok));
  const portaIis = (iis.address() as AddressInfo).port;
  porta = 20000 + Math.floor(Math.random() * 20000);
  relay = spawn(process.execPath, ['relay/relay.mjs'], {
    env: {
      ...process.env, PORT: String(porta), RELAY_TOKEN: TOKEN, RELAY_CHAVE: 'ab'.repeat(32), RELAY_DIR: dir,
      RELAY_DESTINO: `https://localhost:${portaIis}/ws/distribuicao/nfedownloadV2.asmx`, NODE_EXTRA_CA_CERTS: join(dir, 'ca.pem'),
    },
    stdio: 'pipe',
  });
  await new Promise<void>((ok) => relay.stdout!.on('data', (d) => { if (String(d).includes('ouvindo')) ok(); }));
}, 30000);

afterAll(() => {
  relay?.kill();
  iis?.close();
});

const chamar = (caminho: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(`http://127.0.0.1:${porta}${caminho}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as any) } });

describe('intermediário da busca na SEF', () => {
  it('sem o token não faz nada', async () => {
    expect((await fetch(`http://127.0.0.1:${porta}/saude`)).status).toBe(200);
    expect((await chamar('/sef/isa?WSDL', {}, 'errado')).status).toBe(401);
    expect((await chamar('/certificados/isa', { method: 'POST', body: '{}' }, 'errado')).status).toBe(401);
  });

  it('recusa chave que não é do certificado e guarda a certa cifrada', async () => {
    const ruim = await chamar('/certificados/isa', { method: 'POST', body: JSON.stringify({ cert: cli.pem, key: srv.chavePem }) });
    expect(ruim.status).toBe(502);
    const ok = await chamar('/certificados/isa', { method: 'POST', body: JSON.stringify({ cert: cli.pem, key: cli.chavePem }) });
    expect(ok.status).toBe(200);
    expect(readdirSync(dir)).toContain('isa.cert');
    expect(readFileSync(join(dir, 'isa.cert')).toString('latin1')).not.toMatch(/PRIVATE KEY|BEGIN/);
  });

  it('apresenta o certificado quando a SEF pede por renegociação, no GET e no POST, várias vezes', async () => {
    const w = await chamar('/sef/isa?WSDL');
    expect(w.status).toBe(200);
    expect(await w.text()).toContain('cn="ISA TESTE:12345678909" metodo="GET" url="/ws/distribuicao/nfedownloadV2.asmx?WSDL"');
    for (let i = 0; i < 3; i++) {
      const p = await chamar('/sef/isa', { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '"x/NfeDownloadContab"' }, body: '<a>1</a>' });
      expect(await p.text()).toContain(`cn="ISA TESTE:12345678909" metodo="POST" url="/ws/distribuicao/nfedownloadV2.asmx" soap='"x/NfeDownloadContab"' tam="8"`);
    }
  });

  it('o destino é fixo: não repassa outro caminho nem outra consulta', async () => {
    const r = await chamar('/sef/isa?url=https://outro.site/');
    expect(await r.text()).toContain('url="/ws/distribuicao/nfedownloadV2.asmx"');
    expect((await chamar('/qualquer/coisa')).status).toBe(404);
    expect((await chamar('/sef/nao-existe?WSDL')).status).toBe(404);
  });

  it('apagar tira o arquivo', async () => {
    expect((await chamar('/certificados/isa', { method: 'DELETE' })).status).toBe(200);
    expect(readdirSync(dir)).not.toContain('isa.cert');
  });
});
