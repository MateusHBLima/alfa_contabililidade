// Intermediário da busca na SEF/SC (01/10/2026).
//
// Por que existe: o servidor da SEF (IIS) só pede o certificado do cliente ao entrar
// em /ws/, por RENEGOCIAÇÃO TLS no meio da conexão. O fetch da Cloudflare não
// renegocia e a conexão cai (520). O Node renegocia. Então o Alfa Fiscal (Worker)
// chama este serviço, e ele fala com a SEF usando o certificado A1.
//
// O que ele faz, e só isso:
//   POST   /certificados/:id   guarda certificado + chave (PEM), cifrados em disco
//   DELETE /certificados/:id   apaga
//   ANY    /sef/:id            repassa o pedido para a URL FIXA da SEF com o certificado :id
//   GET    /saude              responde ok (sem token)
//
// Segurança: toda rota (menos /saude) exige o token do Alfa Fiscal (RELAY_TOKEN).
// Não é um proxy aberto: o destino é fixo e não vem do pedido. As chaves ficam
// cifradas com AES-256-GCM (RELAY_CHAVE) no volume; nada de corpo vai para o log.
//
// Sem dependências: roda direto na imagem oficial node:22-alpine.

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORTA = Number(process.env.PORT || 8080);
// Segredos do Docker Swarm chegam como arquivo (RELAY_TOKEN_FILE); a variável direta serve para teste.
import { readFileSync } from 'node:fs';
function segredo(nome) {
  const arq = process.env[`${nome}_FILE`];
  if (arq) { try { return readFileSync(arq, 'utf8').trim(); } catch { return ''; } }
  return (process.env[nome] || '').trim();
}
const TOKEN = segredo('RELAY_TOKEN');
const CHAVE_HEX = segredo('RELAY_CHAVE');
const DIR = process.env.RELAY_DIR || '/dados';
const DESTINO = new URL(process.env.RELAY_DESTINO || 'https://satnfe.sef.sc.gov.br/ws/distribuicao/nfedownloadV2.asmx');
const LIMITE_CORPO = 2 * 1024 * 1024;
const TEMPO_SEF_MS = 60_000;

if (TOKEN.length < 32) { console.error('RELAY_TOKEN ausente ou curto (mínimo 32 caracteres)'); process.exit(1); }
if (!/^[0-9a-f]{64}$/i.test(CHAVE_HEX)) { console.error('RELAY_CHAVE precisa ter 64 caracteres hexadecimais'); process.exit(1); }
const CHAVE = Buffer.from(CHAVE_HEX, 'hex');

function tokenConfere(req) {
  const h = req.headers.authorization || '';
  const dado = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const certo = Buffer.from(TOKEN);
  return dado.length === certo.length && crypto.timingSafeEqual(dado, certo);
}

function idValido(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', CHAVE, iv);
  const corpo = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), corpo]);
}

function decifrar(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', CHAVE, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

const arquivo = (id) => path.join(DIR, `${id}.cert`);
const agentes = new Map();

async function agenteDo(id) {
  if (agentes.has(id)) return agentes.get(id);
  let bruto;
  try { bruto = await fs.readFile(arquivo(id)); } catch { return null; }
  const { cert, key } = JSON.parse(decifrar(bruto));
  // keepAlive: a renegociação acontece uma vez por conexão; reaproveitar evita refazer.
  // Sem retomada de sessão: na renegociação o servidor precisa fazer o aperto de mão
  // completo e pedir o certificado. Se a sessão for retomada, o certificado não vai.
  const agente = new https.Agent({
    cert, key, keepAlive: true, maxSockets: 1, maxCachedSessions: 0,
    secureOptions: crypto.constants.SSL_OP_NO_TICKET, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
  });
  agentes.set(id, agente);
  return agente;
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    const partes = [];
    let tam = 0;
    req.on('data', (p) => {
      tam += p.length;
      if (tam > LIMITE_CORPO) { falha(new Error('corpo grande demais')); req.destroy(); return; }
      partes.push(p);
    });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', falha);
  });
}

function responder(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function repassar(agente, metodo, consulta, headers, corpo) {
  return new Promise((ok, falha) => {
    const req = https.request({
      host: DESTINO.hostname, port: Number(DESTINO.port) || 443, path: DESTINO.pathname + consulta, method: metodo, agent: agente,
      servername: DESTINO.hostname, headers, timeout: TEMPO_SEF_MS,
    }, (r) => {
      const partes = [];
      r.on('data', (p) => partes.push(p));
      r.on('end', () => ok({ status: r.statusCode || 502, tipo: r.headers['content-type'], corpo: Buffer.concat(partes) }));
      r.on('error', falha);
    });
    req.on('timeout', () => req.destroy(new Error('a SEF não respondeu em 60 s')));
    req.on('error', falha);
    if (corpo?.length) req.write(corpo);
    req.end();
  });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay');
  const partes = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/saude') return responder(res, 200, { ok: true });
    if (!tokenConfere(req)) return responder(res, 401, { erro: 'não autorizado' });

    if (partes[0] === 'certificados' && idValido(partes[1]) && partes.length === 2) {
      const id = partes[1];
      if (req.method === 'POST') {
        const { cert, key } = JSON.parse((await lerCorpo(req)).toString('utf8'));
        if (typeof cert !== 'string' || typeof key !== 'string' || !cert.includes('BEGIN CERTIFICATE') || !key.includes('PRIVATE KEY')) {
          return responder(res, 400, { erro: 'certificado ou chave inválidos' });
        }
        // Confere se a chave é do certificado antes de guardar.
        tls.createSecureContext({ cert, key });
        await fs.mkdir(DIR, { recursive: true });
        await fs.writeFile(arquivo(id), cifrar(JSON.stringify({ cert, key })), { mode: 0o600 });
        agentes.get(id)?.destroy();
        agentes.delete(id);
        console.log(`certificado ${id} guardado`);
        return responder(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        agentes.get(id)?.destroy();
        agentes.delete(id);
        await fs.rm(arquivo(id), { force: true });
        console.log(`certificado ${id} apagado`);
        return responder(res, 200, { ok: true });
      }
    }

    if (partes[0] === 'sef' && idValido(partes[1]) && partes.length === 2 && (req.method === 'GET' || req.method === 'POST')) {
      const agente = await agenteDo(partes[1]);
      if (!agente) return responder(res, 404, { erro: 'certificado não está no intermediário' });
      // Só a consulta (?WSDL) passa; o caminho é sempre o da SEF.
      const consulta = url.search === '?WSDL' || url.search === '?wsdl' ? '?WSDL' : '';
      const corpo = req.method === 'POST' ? await lerCorpo(req) : null;
      const headers = {};
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      if (req.headers['soapaction']) headers['soapaction'] = req.headers['soapaction'];
      if (corpo) headers['content-length'] = String(corpo.length);
      const t0 = Date.now();
      // Antes de um POST, um GET da descrição do serviço na MESMA conexão (maxSockets 1):
      // a renegociação para pedir o certificado acontece nele, sem corpo em trânsito.
      // Renegociar no meio de um POST depende de o servidor guardar o corpo enquanto isso.
      if (req.method === 'POST') await repassar(agente, 'GET', '?WSDL', {}, null);
      const r = await repassar(agente, req.method, consulta, headers, corpo);
      console.log(`sef ${req.method}${consulta} -> ${r.status} em ${Date.now() - t0} ms`);
      res.writeHead(r.status, { 'content-type': r.tipo || 'text/xml; charset=utf-8', 'x-relay-ms': String(Date.now() - t0) });
      return res.end(r.corpo);
    }

    return responder(res, 404, { erro: 'rota inexistente' });
  } catch (e) {
    console.error(`erro: ${e?.code || ''} ${e?.message || e}`);
    return responder(res, 502, { erro: `intermediário: ${e?.code ? e.code + ' ' : ''}${e?.message || e}` });
  }
});

servidor.listen(PORTA, () => console.log(`intermediário SEF ouvindo na porta ${PORTA}`));
