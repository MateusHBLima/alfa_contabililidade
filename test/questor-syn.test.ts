import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { D1Local, R2Local } from './d1-local';
import { Repo } from '../src/db/repo';
import { importarArquivos } from '../src/nfe/importador';
import { TODAS_PERMISSOES, type Sessao } from '../src/auth/permissoes';
import { gerarHashSenha } from '../src/auth/senha';
import app from '../src/index';
import { montarEntradas200, lerExtrasDoXml, textoCampo, cnpjFormatado, type NotaEntrada } from '../src/questor/leiaute200';
import { naturezaDoItem } from '../src/questor/entrada';
import { configSyn, extrairToken, extrairDadoId } from '../src/questor/syn';

/**
 * Questor SYN (25/11): a nota vai ao Questor com a natureza inteira (1556008), item por
 * item, pelo leiaute 200 – Entradas. Dados todos inventados.
 */

const XML = readFileSync(new URL('./fixtures/nfe-exemplo.xml', import.meta.url), 'utf8');
const SEED = 'semente-de-teste';

const notaInventada = (): NotaEntrada => ({
  cnpjEmpresa: '11222333000181',
  numero: '5303993', serie: '1', chave: '4'.repeat(44), dataEmissao: '2026-11-19',
  fornecedor: {
    cnpj: '99888777000166', nome: 'DISTRIBUIDORA; INVENTADA "LTDA"', uf: 'SC', ie: '250000000',
    logradouro: 'RUA DOS TESTES', numero: '100', complemento: null, bairro: 'CENTRO',
    municipioIbge: '4216602', cep: '88100000', fone: '4832220000',
  },
  indPag: '1', tPag: '15', modFrete: '0',
  duplicatas: [{ numero: '001', vencimento: '2026-12-19', valor: 331.33 }],
  itens: [
    { nItem: 1, cProd: '22679', descricao: 'COPO PLASTICO 300ML', ncm: '39241000', unidade: 'UN', quantidade: 20, valorUnitario: 7.1, valorProduto: 142, desconto: 0, frete: 6.73, seguro: 0, outras: 1.09, baseIcms: 149.82, icms: 17.98, baseSt: 0, st: 0, ipi: 0, valorContabil: 149.82, cfop: '1556', natureza: '1556008' },
    { nItem: 2, cProd: '67381', descricao: 'FARINHA PANKO 1KG', ncm: '19059090', unidade: 'UN', quantidade: 10, valorUnitario: 17.2, valorProduto: 172, desconto: 0, frete: 8.17, seguro: 0, outras: 1.34, baseIcms: 181.51, icms: 21.78, baseSt: 0, st: 0, ipi: 0, valorContabil: 181.51, cfop: '1101', natureza: '1101002' },
  ],
  icmsDoItem: new Map([[1, { aliquota: 12, cst: '000' }], [2, { aliquota: 12, cst: '000' }]]),
});

const registros = (txt: string) => txt.split('\r\n').filter(Boolean).map((l) => l.split(';'));

describe('leiaute 200 – Entradas (módulo puro)', () => {
  it('monta A, B, C, D, E, G e H com a quantidade de campos do exemplo e a natureza inteira', () => {
    const txt = montarEntradas200([notaInventada()], new Map([['1556', 'outras'], ['1101', 'outras']]));
    expect(txt.endsWith('\r\n\r\n')).toBe(true); // linha em branco no fim
    expect(txt.includes('\n') && !/[^\r]\n/.test(txt)).toBe(true); // só CRLF
    const r = registros(txt);
    expect(r.map((l) => l[0])).toEqual(['A', 'B', 'B', 'C', 'D', 'D', 'E', 'E', 'G', 'H']);
    const tam = Object.fromEntries(r.map((l) => [l[0], l.length]));
    expect(tam).toEqual({ A: 25, B: 24, C: 62, D: 10, E: 42, G: 3, H: 6 });

    const c = r.find((l) => l[0] === 'C')!;
    expect(c.slice(1, 11)).toEqual(['11.222.333/0001-81', '99.888.777/0001-66', '5303993', 'NFE', '1', '', '19/11/2026', '19/11/2026', '19/11/2026', '331,33']);
    expect(c[19]).toBe('4'.repeat(44));
    expect(c[24]).toBe('14,90'); // frete
    expect(c[27]).toBe('2,43'); // outras despesas
    expect(c.slice(28, 36)).toEqual(['T', '0', '1', '15', '0', '0', '0', 'SC']);

    // Simples ("outras"): o valor contábil inteiro em Outras, sem base nem ICMS.
    const d = r.filter((l) => l[0] === 'D');
    expect(d).toEqual([
      ['D', '1556008', '1', '149,82', '0,00', '0,00', '0,00', '0,00', '149,82', '0.00'],
      ['D', '1101002', '1', '181,51', '0,00', '0,00', '0,00', '0,00', '181,51', '0.00'],
    ]);
    const e = r.filter((l) => l[0] === 'E');
    expect(e.map((l) => [l[1], l[2], l[3], l[5], l[6], l[7], l[8], l[13]])).toEqual([
      ['1', '1556008', '22679', '20,000000', '7,10', '142,00', '090', '149,82'],
      ['2', '1101002', '67381', '10,000000', '17,20', '172,00', '090', '181,51'],
    ]);
    expect(e[0]![33]).toBe('1,09'); // despesa acessória
    expect(e[0]![36]).toBe('6,73'); // frete do item
    // Tipo do item no cadastro de produto: uso e consumo (7) e matéria-prima (1).
    expect(r.filter((l) => l[0] === 'B').map((l) => [l[2], l[7]])).toEqual([['22679', '7'], ['67381', '1']]);
    // Separadores proibidos saem do texto.
    expect(r[0]![1]).toBe('DISTRIBUIDORA INVENTADA LTDA');
    expect(r.find((l) => l[0] === 'H')).toEqual(['H', '00', '5303993', '001', '19/12/2026', '331,33']);
  });

  it('na regra "manter" leva base, alíquota e ICMS, e o resto em Outras', () => {
    const r = registros(montarEntradas200([notaInventada()], new Map()));
    expect(r.filter((l) => l[0] === 'D')[0]).toEqual(['D', '1556008', '1', '149,82', '149,82', '12,00', '17,98', '0,00', '0,00', '0.00']);
    const e1 = r.filter((l) => l[0] === 'E')[0]!;
    expect([e1[8], e1[9], e1[10], e1[11], e1[13]]).toEqual(['000', '149,82', '12,00', '17,98', '0,00']);
  });

  it('formatos: CNPJ com máscara, texto limpo e cortado', () => {
    expect(cnpjFormatado('57873413000106')).toBe('57.873.413/0001-06');
    expect(textoCampo('  a;b|c"d\r\ne  ', 50)).toBe('a b c d e');
    expect(textoCampo('x'.repeat(60), 50)).toHaveLength(50);
  });

  it('lê do XML o que o leiaute pede além do que o sistema guarda', () => {
    const x = lerExtrasDoXml(XML);
    expect(x.fornecedor.cnpj).toBe('83646984003044');
    expect(x.fornecedor.uf).toBe('SC');
    expect(x.icmsDoItem.size).toBe(3);
    for (const v of x.icmsDoItem.values()) expect(v.cst).toMatch(/^\d{3,4}$/);
  });
});

describe('natureza do item', () => {
  const lista = [
    { cfop: '1556', complemento: '006', padrao: false },
    { cfop: '1556', complemento: '008', padrao: true },
    { cfop: '1102', complemento: '002', padrao: true },
  ];
  it('o escolhido na linha vale se for daquele CFOP; senão o padrão; sem os dois, nada', () => {
    expect(naturezaDoItem('1556', '006', lista)).toBe('1556006');
    expect(naturezaDoItem('1556', '', lista)).toBe('1556008');
    expect(naturezaDoItem('1556', '002', lista)).toBe('1556008'); // 002 é de outro CFOP
    expect(naturezaDoItem('1403', null, lista)).toBeNull();
  });
});

describe('configuração e respostas do SYN', () => {
  it('diz o que falta sem mostrar segredo', () => {
    const r = configSyn({ QUESTOR_SYN_URL: 'https://syn.questor.com.br', QUESTOR_SYN_CNPJ: '57.873.413/0001-06', QUESTOR_SYN_CODIGO: 'segredo-x' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('segredo-x');
    expect((r as any).falta).toEqual(['QUESTOR_SYN_EMAIL (segredo)', 'QUESTOR_CNPJ_ESCRITORIO (CNPJ da Alfa na licença do Questor)']);
  });
  it('acha o token e o id do dado em formas diferentes de resposta', () => {
    expect(extrairToken('"abc.def"')).toBe('abc.def');
    expect(extrairToken({ token: 't1' })).toBe('t1');
    expect(extrairToken({ data: { accessToken: 't2' } })).toBe('t2');
    expect(extrairDadoId({ dadoId: 42 })).toBe('42');
    expect(extrairDadoId({ data: { id: 'x-1' } })).toBe('x-1');
  });
});

describe('rotas do Questor SYN', () => {
  let db: D1Local;
  let r2: R2Local;
  let repo: Repo;
  let ck = '';
  let empresaId = '';
  const CONFIG = {
    QUESTOR_SYN_URL: 'https://syn.exemplo.test', QUESTOR_SYN_CNPJ: '57.873.413/0001-06',
    QUESTOR_SYN_EMAIL: 'erp@exemplo.test', QUESTOR_SYN_CODIGO: 'codigo-secreto-de-teste',
    QUESTOR_CNPJ_ESCRITORIO: '11.444.777/0001-61',
  };
  let extra: Record<string, unknown> = {};
  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao', ...extra,
  }) as never;
  const req = (c: string, o: RequestInit = {}) =>
    app.fetch(new Request(`http://x${c}`, {
      ...o, headers: { 'content-type': 'application/json', Cookie: ck, ...(o.headers ?? {}) },
    }), ambiente());

  beforeEach(async () => {
    db = new D1Local();
    db.migrar();
    r2 = new R2Local();
    extra = {};
    await db.prepare('INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, criado_em) VALUES (?,?,?,?,?,?)')
      .bind('u1', 'alfa', 'contadora@alfacontabil.net', 'Contadora', await gerarHashSenha('uma frase de senha longa'), new Date().toISOString()).run();
    await db.prepare('INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES (?,?)').bind('u1', 'papel-admin').run();
    const sessao: Sessao = {
      usuarioId: 'u1', tenantId: 'alfa', email: 'contadora@alfacontabil.net', nome: 'Contadora',
      permissoes: new Set(TODAS_PERMISSOES), empresas: null, deveTrocarSenha: false,
    };
    repo = new Repo(db as any, { sessao, ip: '1.2.3.4', requestId: 'req-1' }, SEED);
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    empresaId = await repo.criarEmpresa({ cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO LTDA', uf: 'SC', perfil: 'revenda' });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    db.consultar(`UPDATE itens SET cfop_novo = CASE WHEN n_item = 1 THEN '1556' WHEN n_item = 2 THEN '1102' ELSE '1403' END`);
  });

  afterEach(() => vi.unstubAllGlobals());

  const notaId = () => (db.consultar('SELECT id FROM notas') as any[])[0].id as string;

  it('o Admin nasce com a permissão, pela migração', () => {
    expect(db.consultar(`SELECT papel_id FROM papel_permissoes WHERE permissao = 'questor.enviar'`)).toEqual([{ papel_id: 'papel-admin' }]);
  });

  it('sem a lista de complementos da empresa a nota não sai; com ela, o arquivo leva a natureza inteira', async () => {
    let r = await req(`/api/notas/${notaId()}/questor/arquivo`);
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).erro).toContain('CFOP 1556, 1102, 1403');

    expect((await req(`/api/empresas/${empresaId}/naturezas`, {
      method: 'PUT', body: JSON.stringify({ naturezas: [
        { cfop: '1556', complemento: '008', padrao: true }, { cfop: '1556', complemento: '006' },
        { cfop: '1102', complemento: '002', padrao: true }, { cfop: '1403', complemento: '002', padrao: true },
      ] }),
    })).status).toBe(200);
    db.consultar(`UPDATE itens SET complemento = '006' WHERE n_item = 1`);

    r = await req(`/api/notas/${notaId()}/questor/arquivo`);
    expect(r.status).toBe(200);
    const txt = await r.text();
    const e = registros(txt).filter((l) => l[0] === 'E').map((l) => l[2]);
    expect(e).toEqual(['1556006', '1102002', '1403002']);
  });

  it('mandar: sem configuração diz o que falta; com ela gera o token, posta e guarda o envio sem o segredo', async () => {
    await req(`/api/empresas/${empresaId}/naturezas`, {
      method: 'PUT', body: JSON.stringify({ naturezas: [
        { cfop: '1556', complemento: '008', padrao: true }, { cfop: '1102', complemento: '002', padrao: true },
        { cfop: '1403', complemento: '002', padrao: true },
      ] }),
    });
    let r = await req(`/api/notas/${notaId()}/questor/enviar`, { method: 'POST' });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).falta).toContain('QUESTOR_SYN_CODIGO (segredo)');

    extra = CONFIG;
    const chamadas: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      chamadas.push({ url, init });
      if (url.endsWith('/api/v2/erp/gerartoken')) return new Response(JSON.stringify({ token: 'tok-123' }), { status: 200 });
      if (url.endsWith('/api/v2/dados/inserir')) return new Response(JSON.stringify({ dadoId: 777 }), { status: 200 });
      return new Response('não', { status: 404 });
    }));
    r = await req(`/api/notas/${notaId()}/questor/enviar`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ situacao: 'enviado', dadoId: '777' });

    expect(chamadas.map((c) => c.url)).toEqual(['https://syn.exemplo.test/api/v2/erp/gerartoken', 'https://syn.exemplo.test/api/v2/dados/inserir']);
    expect(JSON.parse(String(chamadas[0]!.init.body))).toEqual({ cnpj: '57.873.413/0001-06', email: 'erp@exemplo.test', codigoAcesso: 'codigo-secreto-de-teste' });
    const post = JSON.parse(String(chamadas[1]!.init.body));
    expect(post).toMatchObject({ cnpjCliente: '11.222.333/0001-81', versao: '2.00', grupoLayout: 200, cnpjContabilidade: ['11.444.777/0001-61'] });
    expect(post.dataDocumentos).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(post.dado).toContain(';1556008;');
    expect((chamadas[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');

    const envios = db.consultar('SELECT * FROM questor_envios') as any[];
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({ situacao: 'enviado', dado_id: '777', empresa_id: empresaId });
    // O código de acesso e o token não ficam em lugar nenhum do banco.
    const tudo = JSON.stringify([db.consultar('SELECT * FROM questor_envios'), db.consultar('SELECT * FROM auditoria')]);
    expect(tudo).not.toContain('codigo-secreto-de-teste');
    expect(tudo).not.toContain('tok-123');
    expect(db.consultar(`SELECT valor_depois FROM auditoria WHERE entidade = 'nota' AND acao = 'exportar'`)).toEqual([{ valor_depois: 'Questor SYN · enviado · dado 777' }]);

    // Erro do Questor fica registrado como erro, sem quebrar.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('gerartoken')
      ? new Response('"tok"', { status: 200 })
      : new Response(JSON.stringify({ mensagem: 'acesso não aprovado pelo escritório' }), { status: 403 }))));
    r = await req(`/api/notas/${notaId()}/questor/enviar`, { method: 'POST' });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).resposta).toContain('acesso não aprovado');
    expect((db.consultar('SELECT situacao FROM questor_envios ORDER BY criado_em') as any[]).map((x) => x.situacao).sort()).toEqual(['enviado', 'erro']);
    expect(((await (await req(`/api/notas/${notaId()}/questor/envios`)).json()) as any[])).toHaveLength(2);
  });

  it('pedir acesso da empresa manda CNPJ do cliente, do escritório e o grupo de entradas', async () => {
    extra = CONFIG;
    const corpos: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('gerartoken')) return new Response('"tok"', { status: 200 });
      corpos.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ situacao: 'Pendente' }), { status: 200 });
    }));
    const r = await req(`/api/empresas/${empresaId}/questor/acesso`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(corpos[0]).toEqual({
      url: 'https://syn.exemplo.test/api/v2/dadosescritorio/solicitaracesso',
      body: { cnpjCliente: '11.222.333/0001-81', cnpjEscritorio: '11.444.777/0001-61', grupoLayout: 200 },
    });
    const s = await req(`/api/empresas/${empresaId}/questor/acesso`);
    expect(await s.json()).toMatchObject({ status: 200, resposta: { situacao: 'Pendente' } });
    expect(corpos[1].url).toContain('/api/v2/dadosescritorio/erp/solicitaracesso/busca?CnpjCliente=11.222.333%2F0001-81');
  });

  it('sem a permissão, nada das rotas do Questor', async () => {
    db.consultar(`DELETE FROM papel_permissoes WHERE permissao = 'questor.enviar'`);
    for (const [c, m] of [[`/api/questor/syn`, 'GET'], [`/api/notas/${notaId()}/questor/arquivo`, 'GET'], [`/api/notas/${notaId()}/questor/enviar`, 'POST'], [`/api/empresas/${empresaId}/questor/acesso`, 'POST']] as const) {
      expect((await req(c, { method: m })).status, c).toBe(403);
    }
  });
});
