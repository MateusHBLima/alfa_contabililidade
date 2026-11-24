import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { D1Local } from './d1-local';
import worker, { ConsultaAdnCartorio } from '../src/index';
import { loteParaCartorio, type AmbienteInterno } from '../src/interno';

/**
 * 24/11: consulta interna para a plataforma do cartório. O que importa aqui é o que ela
 * NÃO deixa fazer: escolher certificado, consultar sem CPF válido, chegar pela internet.
 */

const CPF = '52998224725';            // inventado, com dígito verificador certo
const CERT = 'cert-da-contadora';
let db: D1Local;

const amb = (extra: Partial<AmbienteInterno> = {}): AmbienteInterno => ({
  DB: db as never, AUDIT_SEED: 'semente', SEF_PONTE_URL: 'https://relay.teste/', SEF_PONTE_TOKEN: 'segredo-do-relay',
  CARTORIO_CERT_ID: CERT, ...extra,
});

async function cadastrarCertificado(id: string, mudancas: Record<string, string | null> = {}) {
  const c: Record<string, string | null> = {
    id, tenant_id: 'alfa', nome: 'e-CPF', titular: 'CONTADORA DE TESTE', documento: null, tipo: 'e-CPF', emissor: null, serial: null,
    valido_de: '2026-01-01T00:00:00Z', valido_ate: '2099-01-01T00:00:00Z', cloudflare_id: '', enviado_em: '2026-11-01T00:00:00Z',
    enviado_por: 'u1', removido_em: null, removido_por: null, guardado_em: 'ponte', ...mudancas,
  };
  const cols = Object.keys(c);
  await db.prepare(`INSERT INTO certificados (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map((k) => c[k]!)).run();
}

const ADN = {
  StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS', TipoConsulta: 'Procuracao',
  LoteDFe: [
    { NSU: 101, ChaveAcesso: 'C'.repeat(50), TipoDocumento: 'NFSE', ArquivoXml: 'eG1sLTE=', DataHoraGeracao: '2026-11-16T21:15:49' },
    { NSU: 102, ChaveAcesso: 'D'.repeat(50), TipoDocumento: 'EVENTO', ArquivoXml: 'eG1sLTI=', DataHoraGeracao: '2026-11-16T21:20:00' },
    { NSU: 'torto', ArquivoXml: 'x' },
    { NSU: 103 },
  ],
};

let pedidos: { url: string; auth: string | null }[];
const responder = (fn: (url: string) => Response) => vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
  pedidos.push({ url: String(u), auth: new Headers(init?.headers).get('authorization') });
  return fn(String(u));
}));
const trilha = () => (db.consultar("SELECT tenant_id, usuario_email, acao, entidade_id, valor_depois, origem FROM auditoria WHERE entidade = 'certificado' ORDER BY rowid") as any[]);

beforeEach(async () => {
  db = new D1Local();
  db.migrar();
  pedidos = [];
  await cadastrarCertificado(CERT);
});
afterEach(() => vi.unstubAllGlobals());

describe('consulta interna do ADN para a plataforma do cartório', () => {
  it('busca um lote com o certificado fixo, em nome do CPF, e devolve os documentos como o ADN mandou', async () => {
    responder(() => new Response(JSON.stringify(ADN), { status: 200 }));
    const r = await loteParaCartorio(amb(), { cpf: '529.982.247-25', nsu: 100 });
    expect(r).toEqual({
      status: 200, situacao: 'DOCUMENTOS_LOCALIZADOS',
      documentos: [
        { nsu: 101, chave: 'C'.repeat(50), tipo: 'NFSE', xml: 'eG1sLTE=', geradoEm: '2026-11-16T21:15:49' },
        { nsu: 102, chave: 'D'.repeat(50), tipo: 'EVENTO', xml: 'eG1sLTI=', geradoEm: '2026-11-16T21:20:00' },
      ],
    });
    expect(pedidos).toEqual([{ url: `https://relay.teste/adn/${CERT}/contribuintes/DFe/100?lote=true&cpfConsulta=${CPF}`, auth: 'Bearer segredo-do-relay' }]);
    // Na trilha: quem foi (a plataforma do cartório), com o CPF mascarado.
    expect(trilha()).toEqual([{
      tenant_id: 'alfa', usuario_email: 'plataforma do cartório', acao: 'exportar', entidade_id: CERT, origem: 'sistema',
      valor_depois: 'consulta ADN pela plataforma do cartório · NSU 100 · CPF ***.982.247-** · lote · HTTP 200 · 2 documentos',
    }]);
    expect(JSON.stringify(trilha())).not.toContain(CPF);
  });

  it('fim da lista: 404 nos dois caminhos vira "não há mais", sem documento', async () => {
    responder(() => new Response('', { status: 404 }));
    expect(await loteParaCartorio(amb(), { cpf: CPF, nsu: 33908 })).toEqual({ status: 404, situacao: null, documentos: [] });
    expect(pedidos.map((p) => p.url.replace(/\?.*/, ''))).toEqual([
      `https://relay.teste/adn/${CERT}/contribuintes/DFe/33908`, `https://relay.teste/adn/${CERT}/contribuinte/DFe/33908`,
    ]);
    expect(trilha()[0].valor_depois).toBe('consulta ADN pela plataforma do cartório · NSU 33908 · CPF ***.982.247-** · lote · HTTP 404');
  });

  it('erro do ADN ou do intermediário volta só como código, sem o texto da resposta', async () => {
    responder(() => new Response('<html>Bad Gateway com dado sensível</html>', { status: 502 }));
    expect(await loteParaCartorio(amb(), { cpf: CPF, nsu: 1 })).toEqual({ status: 502, situacao: null, documentos: [], mensagem: 'o ADN respondeu 502' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rede fora'); }));
    expect((await loteParaCartorio(amb(), { cpf: CPF, nsu: 1 })).status).toBe(502);
    // Rejeição do ADN (HTTP 200 sem lote) passa a situação adiante, sem documento.
    responder(() => new Response(JSON.stringify({ StatusProcessamento: 'REJEICAO', LoteDFe: [] }), { status: 200 }));
    expect(await loteParaCartorio(amb(), { cpf: CPF, nsu: 1 })).toEqual({ status: 200, situacao: 'REJEICAO', documentos: [] });
  });

  it('CPF inválido ou NSU torto nem chegam ao intermediário, e não ficam na trilha', async () => {
    responder(() => new Response(JSON.stringify(ADN), { status: 200 }));
    for (const pedido of [{ cpf: '11122233300', nsu: 1 }, { cpf: '', nsu: 1 }, { cpf: '11111111111', nsu: 1 }, { cpf: CPF, nsu: -1 },
      { cpf: CPF, nsu: 1.5 }, { cpf: CPF, nsu: NaN }, { cpf: CPF, nsu: '1; DROP' as never }, null as never, {} as never]) {
      expect((await loteParaCartorio(amb(), pedido)).status).toBe(400);
    }
    expect(pedidos).toEqual([]);
    expect(trilha()).toEqual([]);
  });

  it('o certificado é um só, o da variável: sem ela, ou com ele removido, vencido ou fora do intermediário, não consulta', async () => {
    responder(() => new Response(JSON.stringify(ADN), { status: 200 }));
    await cadastrarCertificado('removido', { removido_em: '2026-11-20T00:00:00Z', removido_por: 'u1' });
    await cadastrarCertificado('vencido', { valido_ate: '2026-01-01T00:00:00Z' });
    await cadastrarCertificado('na-cloudflare', { guardado_em: 'cloudflare' });
    const casos: [Partial<AmbienteInterno>, string][] = [
      [{ CARTORIO_CERT_ID: undefined }, 'não está ligada'],
      [{ CARTORIO_CERT_ID: '' }, 'não está ligada'],
      [{ CARTORIO_CERT_ID: '../outro' }, 'não está ligada'],
      [{ CARTORIO_CERT_ID: 'nao-existe' }, 'não está cadastrado'],
      [{ CARTORIO_CERT_ID: 'removido' }, 'não está cadastrado'],
      [{ CARTORIO_CERT_ID: 'vencido' }, 'venceu'],
      [{ CARTORIO_CERT_ID: 'na-cloudflare' }, 'não está no intermediário'],
      [{ SEF_PONTE_TOKEN: undefined }, 'intermediário não está configurado'],
      [{ SEF_PONTE_URL: '' }, 'intermediário não está configurado'],
    ];
    for (const [extra, trecho] of casos) {
      const r = await loteParaCartorio(amb(extra), { cpf: CPF, nsu: 1 });
      expect([r.status, r.documentos]).toEqual([503, []]);
      expect(r.mensagem).toContain(trecho);
    }
    expect(pedidos).toEqual([]);
    // O pedido não escolhe certificado: um campo a mais é ignorado.
    await loteParaCartorio(amb(), { cpf: CPF, nsu: 1, certId: 'na-cloudflare' } as never);
    expect(pedidos[0]!.url).toContain(`/adn/${CERT}/`);
  });

  it('é ponto de entrada, não rota: a classe chama a mesma função, e pela internet não existe', async () => {
    responder(() => new Response(JSON.stringify(ADN), { status: 200 }));
    const entrada = new (ConsultaAdnCartorio as any)({}, amb()) as ConsultaAdnCartorio;
    expect((await entrada.lote({ cpf: CPF, nsu: 100 })).documentos).toHaveLength(2);
    // Nenhum endereço público leva a ela.
    const ambiente = { ...amb(), XML_ORIGINAL: {}, XML_TRABALHO: {}, SESSION_SECRET: 's', AMBIENTE: 'producao', ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
    for (const caminho of ['/api/interno/lote', '/api/captura/adn-cartorio', '/ConsultaAdnCartorio', '/api/ConsultaAdnCartorio/lote']) {
      const r = await worker.fetch(new Request(`http://x${caminho}`, { method: 'POST', body: JSON.stringify({ cpf: CPF, nsu: 1 }) }), ambiente as never);
      expect([401, 404]).toContain(r.status);
    }
    expect(pedidos).toHaveLength(1);
  });
});
