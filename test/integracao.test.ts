import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { D1Local, R2Local } from './d1-local';
import { Repo } from '../src/db/repo';
import { Auditoria } from '../src/db/auditoria';
import { importarArquivos } from '../src/nfe/importador';
import { gerarXmlCorrigido, verificarInvariantes } from '../src/nfe/serializer';
import { parseNFe } from '../src/nfe/parser';
import { detectarAlertas } from '../src/rules/alertas';
import { aprender, chavesDoItem, sugerir } from '../src/rules/engine';
import { TODAS_PERMISSOES, type Sessao } from '../src/auth/permissoes';
import { gerarHashSenha, conferirSenha } from '../src/auth/senha';
import app from '../src/index';
import { gerarTotp } from '../src/auth/totp';

/**
 * Teste de integração: o sistema inteiro contra um SQLite de verdade.
 *
 * Prova que as migrações aplicam, que o repositório escreve, que o motor de regras
 * aprende entre uma nota e outra, que a auditoria encadeia e que a exportação valida.
 */

const XML = readFileSync(new URL('./fixtures/nfe-exemplo.xml', import.meta.url), 'utf8');
const SEED = 'semente-de-teste';

const CHAVE_ORIGINAL = '42260783646984003044550010005047671000722978'; // 44 dígitos

/** Segunda nota do mesmo fornecedor: outra chave, outro número, mesmos produtos. */
function outraNota(xml: string, sufixo: string, mudancas: [string, string][] = []): string {
  const chaveNova = CHAVE_ORIGINAL.slice(0, 44 - sufixo.length) + sufixo;
  let out = xml
    .replaceAll(CHAVE_ORIGINAL, chaveNova)
    .replace('<nNF>504767</nNF>', `<nNF>5047${sufixo}</nNF>`)
    .replace('<dhEmi>2026-07-14T09:31:00-03:00</dhEmi>', '<dhEmi>2026-08-14T09:31:00-03:00</dhEmi>');
  for (const [de, para] of mudancas) out = out.replace(de, para);
  return out;
}

let db: D1Local;
let r2: R2Local;
let sessao: Sessao;
let repo: Repo;

async function semear() {
  db = new D1Local();
  db.migrar();
  r2 = new R2Local();

  // tenant, permissões e papéis vêm da migração 0003 — não duplicamos aqui.
  // Só o usuário é criado, porque senha não entra em migração.
  await db.prepare(
    'INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, criado_em) VALUES (?,?,?,?,?,?)',
  ).bind('u1', 'alfa', 'contadora@alfacontabil.net', 'Contadora',
    await gerarHashSenha('uma frase de senha longa'), new Date().toISOString()).run();

  await db.prepare('INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES (?,?)')
    .bind('u1', 'papel-admin').run();

  sessao = {
    usuarioId: 'u1', tenantId: 'alfa', email: 'contadora@alfacontabil.net', nome: 'Contadora',
    permissoes: new Set(TODAS_PERMISSOES), empresas: null, deveTrocarSenha: false,
  };

  repo = new Repo(db as any, { sessao, ip: '1.2.3.4', requestId: 'req-1' }, SEED);
}

beforeEach(semear);

describe('as migrações aplicam num SQLite real', () => {
  it('cria as 17 tabelas e já traz a semente', () => {
    const tabelas = db.consultar<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(tabelas.length).toBe(23);
    expect(db.consultar('SELECT 1 FROM tenants')).toHaveLength(1);
    expect(db.consultar('SELECT 1 FROM papeis')).toHaveLength(3);
  });

  it('as chaves estrangeiras estão ativas e valem', async () => {
    await expect(
      db.prepare('INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES (?,?)')
        .bind('inexistente', 'papel-admin').run(),
    ).rejects.toThrow();
  });
});

describe('login contra o banco', () => {
  it('a senha gravada confere', async () => {
    const u = await db.prepare('SELECT senha_hash FROM usuarios WHERE email = ?')
      .bind('contadora@alfacontabil.net').first<{ senha_hash: string }>();
    expect(await conferirSenha('uma frase de senha longa', u!.senha_hash)).toBe(true);
    expect(await conferirSenha('outra coisa', u!.senha_hash)).toBe(false);
  });
});

describe('cadastro de empresa', () => {
  it('grava e registra na auditoria', async () => {
    const id = await repo.criarEmpresa({
      cnpj: '11.222.333/0001-81', razaoSocial: 'MERCADO PILOTO LTDA',
      uf: 'SC', perfil: 'revenda', cnaePrincipal: '4711302',
    });

    const e = await repo.obterEmpresa(id);
    expect(e.cnpj).toBe('11222333000181'); // pontuação removida
    expect(e.perfil).toBe('revenda');

    const trilha = db.consultar("SELECT * FROM auditoria WHERE entidade='empresa'");
    expect(trilha).toHaveLength(1);
    expect(trilha[0].usuario_email).toBe('contadora@alfacontabil.net');
  });

  it('o recorte por empresa é respeitado na listagem', async () => {
    const a = await repo.criarEmpresa({ cnpj: '11222333000181', razaoSocial: 'A', perfil: 'revenda' });
    await repo.criarEmpresa({ cnpj: '22333444000192', razaoSocial: 'B', perfil: 'revenda' });

    const limitado = new Repo(
      db as any,
      { sessao: { ...sessao, empresas: new Set([a]), permissoes: new Set(['notas.visualizar'] as any) }, ip: null, requestId: 'r' },
      SEED,
    );
    const vistas = await limitado.listarEmpresas();
    expect(vistas.map((e: any) => e.razao_social)).toEqual(['A']);
  });
});

describe('importar uma nota de verdade', () => {
  let empresaId: string;
  beforeEach(async () => {
    empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO LTDA', uf: 'SC', perfil: 'revenda',
    });
  });

  it('grava nota, itens, fornecedor e o XML no R2', async () => {
    const r = await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'nota.xml', conteudo: XML }]);

    expect(r.importadas).toBe(1);
    expect(r.arquivos[0]!.itens).toBe(3);

    const notas = db.consultar('SELECT * FROM notas');
    expect(notas).toHaveLength(1);
    expect(notas[0].emit_cnpj).toBe('83646984003044');
    expect(notas[0].competencia).toBe('2026-07');
    expect(notas[0].origem).toBe('upload');

    const itens = db.consultar('SELECT * FROM itens ORDER BY n_item');
    expect(itens).toHaveLength(3);
    expect(itens[0].cst_origem).toBe('00');       // guardado para comparação futura
    expect(itens[0].cfop_original).toBe('5102');

    const forn = db.consultar('SELECT * FROM fornecedores');
    expect(forn).toHaveLength(1);
    expect(forn[0].notas_recebidas).toBe(1);

    expect(r2.objetos.size).toBe(1);
    expect([...r2.objetos.values()][0]!.corpo).toBe(XML);
  });

  it('na primeira vez, tudo cai no perfil da empresa', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    const itens = db.consultar('SELECT * FROM itens');
    expect(itens.every((i: any) => i.cfop_origem === 'perfil')).toBe(true);
    expect(itens.every((i: any) => i.cfop_novo === '1102')).toBe(true); // revenda, SC->SC
  });

  it('a mesma nota duas vezes é detectada como duplicada', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    const r2a = await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    expect(r2a.duplicadas).toBe(1);
    expect(db.consultar('SELECT * FROM notas')).toHaveLength(1);
  });

  it('arquivo inválido é recusado com motivo, sem derrubar o lote', async () => {
    const r = await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'boa.xml', conteudo: XML },
      { nome: 'lixo.xml', conteudo: '<nada/>' },
    ]);
    expect(r.importadas).toBe(1);
    expect(r.recusadas).toBe(1);
    expect(r.arquivos.find((a) => a.arquivo === 'lixo.xml')!.motivo).toContain('NFe');
  });

  it('o lote fica registrado com a origem', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }], 'email');
    const lote = db.consultar('SELECT * FROM lotes_importacao')[0];
    expect(lote.origem).toBe('email');
    expect(lote.importadas).toBe(1);
  });
});

describe('o ciclo que faz o produto valer — a segunda nota vem pronta', () => {
  it('a contadora corrige uma vez e a nota seguinte já chega preenchida', async () => {
    const empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda',
    });

    // --- competência 1: importa e corrige o item 1 para ST -----------------
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'jul.xml', conteudo: XML }]);

    const nota1 = parseNFe(XML);
    const item1 = nota1.itens[0]!;
    const chaves = chavesDoItem(item1, nota1.emit.cnpj);
    const antes = await repo.carregarRegrasCandidatas(empresaId, chaves);
    expect(antes).toHaveLength(0); // o sistema não sabia nada

    const sugestao = sugerir('cfop', item1, antes, {
      perfil: 'revenda', ufEmitente: 'SC', ufDestinatario: 'SC',
    });
    expect(sugestao.origem).toBe('perfil');

    await repo.aplicarAprendizado(
      empresaId,
      aprender({ item: item1, emitCnpj: nota1.emit.cnpj, campo: 'cfop', valorFinal: '1403', sugestao }),
    );

    const itemId = db.consultar('SELECT id FROM itens WHERE n_item = 1')[0].id;
    await repo.alterarItem(itemId, [{ campo: 'cfop', valor: '1403', origem: 'manual' }]);

    // --- competência 2: mesma mercadoria, nota nova ------------------------
    const agosto = outraNota(XML, '99');
    const r = await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'ago.xml', conteudo: agosto }]);
    expect(r.importadas).toBe(1);

    const chaveNova = parseNFe(agosto).chave;
    const notaId = db.consultar('SELECT id FROM notas WHERE chave = ?', chaveNova)[0].id;
    const itens2 = db.consultar('SELECT * FROM itens WHERE nota_id = ? ORDER BY n_item', notaId);

    // O item 1 chegou com o CFOP que a contadora ensinou, e sabendo de onde veio.
    expect(itens2[0].cfop_novo).toBe('1403');
    expect(String(itens2[0].cfop_origem)).toMatch(/^regra:/);

    // Os outros não foram ensinados: continuam no palpite do perfil.
    expect(itens2[1].cfop_origem).toBe('perfil');
  });

  it('"aplicar a todo o fornecedor" pega produto que nunca foi visto', async () => {
    const empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda',
    });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'jul.xml', conteudo: XML }]);

    const nota1 = parseNFe(XML);
    await repo.aplicarAprendizado(
      empresaId,
      aprender({
        item: nota1.itens[0]!, emitCnpj: nota1.emit.cnpj, campo: 'cfop',
        valorFinal: '1403', sugestao: null, fixar: true, apenasNiveis: [5],
      }),
    );

    // nota nova, com um produto que nunca apareceu
    const comProdutoNovo = outraNota(XML, '88', [
      ['<cProd>7891</cProd>', '<cProd>NOVO123</cProd>'],
      ['<cEAN>7891000100103</cEAN>', '<cEAN>SEM GTIN</cEAN>'],
      ['<NCM>18069000</NCM>', '<NCM>21069090</NCM>'],
    ]);
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'nova.xml', conteudo: comProdutoNovo }]);

    const notaId = db.consultar('SELECT id FROM notas WHERE chave = ?', parseNFe(comProdutoNovo).chave)[0].id;
    const item = db.consultar('SELECT * FROM itens WHERE nota_id = ? AND n_item = 1', notaId)[0];

    expect(item.cfop_novo).toBe('1403');            // o padrão do fornecedor pegou
    expect(String(item.cfop_origem)).toMatch(/^regra:/);
  });
});

describe('alertas contra o histórico real do banco', () => {
  it('detecta que o produto entrou em substituição tributária', async () => {
    const empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda',
    });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'jul.xml', conteudo: XML }]);

    // mesma mercadoria, mas agora o fornecedor mandou com CST 60 e NCM diferente
    const mudou = outraNota(XML, '77', [
      ['<CST>00</CST><vICMS>15.30</vICMS>', '<CST>60</CST><vICMS>15.30</vICMS>'],
      ['<NCM>18069000</NCM>', '<NCM>17049090</NCM>'],
    ]);
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'ago.xml', conteudo: mudou }]);

    const nova = parseNFe(mudou);
    const historico = await repo.carregarHistoricoProdutos(empresaId, nova.emit.cnpj, null);
    const h = historico.get('7891');
    expect(h).toBeDefined();
    expect(h!.vezesVisto).toBeGreaterThanOrEqual(1);

    // compara o item novo contra o que sabíamos ANTES dele
    const alertas = detectarAlertas(nova.itens[0]!, {
      historico: { ...h!, ncm: '18069000', cstOrigem: '00' },
      cfopEntrada: '1102', confianca: 'media', regraSuspeita: false,
    });
    const codigos = alertas.map((a) => a.codigo);
    expect(codigos).toContain('st_mudou');
    expect(codigos).toContain('ncm_mudou');
  });

  it('produto conhecido e sem mudança não gera alerta nenhum', async () => {
    const empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda',
    });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'jul.xml', conteudo: XML }]);

    const nota = parseNFe(XML);
    const h = (await repo.carregarHistoricoProdutos(empresaId, nota.emit.cnpj, null)).get('7891')!;
    const alertas = detectarAlertas(nota.itens[0]!, {
      historico: h, cfopEntrada: '1102', confianca: 'alta', regraSuspeita: false,
    });
    expect(alertas).toEqual([]);
  });
});

describe('exportação a partir do que está gravado', () => {
  it('gera o XML corrigido do banco e passa nas invariantes', async () => {
    const empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda',
    });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);

    const notaId = db.consultar('SELECT id FROM notas')[0].id;
    const r = await repo.obterNotaComItens(notaId);
    const original = await (await r2.get(r!.nota.r2_original))!.text();

    const { xml, itensAlterados } = gerarXmlCorrigido(
      original,
      r!.itens.map((i: any) => ({ nItem: i.n_item, cfop: i.cfop_novo, xProd: i.x_prod_novo })),
    );

    expect(itensAlterados).toBe(3); // os três CFOP viraram 1102
    expect(verificarInvariantes(original, xml).filter((i) => !i.ok)).toEqual([]);
    expect(parseNFe(xml).chave).toBe(parseNFe(original).chave);
  });
});

describe('a trilha de auditoria encadeia de verdade', () => {
  it('a cadeia fecha depois de uma sessão de trabalho inteira', async () => {
    const empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda',
    });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    await repo.atualizarEmpresa(empresaId, { perfil: 'uso_consumo' });

    const itemId = db.consultar('SELECT id FROM itens WHERE n_item = 1')[0].id;
    await repo.alterarItem(itemId, [
      { campo: 'cfop', valor: '1556', origem: 'manual' },
      { campo: 'cst_entrada', valor: '090', origem: 'manual' },
    ]);

    const aud = new Auditoria(db as any, SEED);
    const r = await aud.verificarCadeia('alfa');
    expect(r.ok).toBe(true);
    expect(r.conferidos).toBeGreaterThan(4);
  });

  it('adulterar um registro quebra a cadeia e o sistema aponta onde', async () => {
    const empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda',
    });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    const itemId = db.consultar('SELECT id FROM itens WHERE n_item = 1')[0].id;
    await repo.alterarItem(itemId, [{ campo: 'cfop', valor: '1556', origem: 'manual' }]);

    // alguém edita o banco por fora para esconder uma alteração de CFOP
    await db.prepare("UPDATE auditoria SET valor_depois = '1102' WHERE campo = 'cfop'").bind().run();

    const r = await new Auditoria(db as any, SEED).verificarCadeia('alfa');
    expect(r.ok).toBe(false);
    expect(r.quebrouNoId).not.toBeNull();
  });

  it('a origem fica registrada — distingue quem digitou de quem só confirmou', async () => {
    const empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda',
    });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    const itemId = db.consultar('SELECT id FROM itens WHERE n_item = 1')[0].id;

    await repo.alterarItem(itemId, [{ campo: 'cfop', valor: '1403', origem: 'manual' }]);
    await repo.alterarItem(itemId, [{ campo: 'cfop', valor: '1556', origem: 'regra:abc' }]);

    const trilha = db.consultar("SELECT * FROM auditoria WHERE campo='cfop' ORDER BY id");
    expect(trilha[0].origem).toBe('manual');
    expect(trilha[0].valor_depois).toBe('1403');
    expect(trilha[1].origem).toBe('regra:abc');
    expect(trilha[1].valor_antes).toBe('1403'); // o "de → para" fecha
  });
});

describe('configuração ausente não vira "erro interno"', () => {
  /* O .dev.vars está no .gitignore — corretamente, é onde moram os segredos. Só que
     isso significa que toda máquina que clona o repositório começa sem ele. Sem
     SESSION_SECRET o HMAC do cookie estoura lá no fundo e a tela de login mostra
     "erro interno", que não diz a ninguém o que fazer. Aconteceu de verdade, no
     primeiro login do Mateus na máquina dele. */

  const ambiente = (extra: Record<string, unknown> = {}) => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    AMBIENTE: 'teste', ...extra,
  }) as never;

  beforeEach(semear);

  it('sem SESSION_SECRET, a API diz o nome do que falta', async () => {
    const r = await app.fetch(
      new Request('http://x/api/eu'), ambiente({ AUDIT_SEED: SEED }),
    );
    expect(r.status).toBe(500);
    const corpo = await r.json() as { erro: string };
    expect(corpo.erro).toContain('SESSION_SECRET');
    expect(corpo.erro).not.toBe('erro interno');
  });

  it('sem AUDIT_SEED também', async () => {
    const r = await app.fetch(
      new Request('http://x/api/eu'), ambiente({ SESSION_SECRET: 's' }),
    );
    expect((await r.json() as { erro: string }).erro).toContain('AUDIT_SEED');
  });

  it('a mensagem diz o que fazer, não só o que falta', async () => {
    const r = await app.fetch(new Request('http://x/api/eu'), ambiente());
    const { erro } = await r.json() as { erro: string };
    expect(erro).toContain('subir.cmd');
    expect(erro).toContain('wrangler secret put');
  });

  it('com os dois presentes, a rota volta ao normal: 401 por falta de sessão', async () => {
    const r = await app.fetch(
      new Request('http://x/api/eu'), ambiente({ SESSION_SECRET: 's', AUDIT_SEED: SEED }),
    );
    expect(r.status).toBe(401);
  });
});

describe('a rota das credenciais de teste só existe no ambiente local', () => {
  /* A tela de login se preenche sozinha na máquina de quem está testando. Isso é
     conveniência de desenvolvimento e não pode, em hipótese alguma, virar um
     endpoint que serve senha numa instalação publicada.

     A trava NÃO é o AMBIENTE: `wrangler.jsonc` traz AMBIENTE="dev" e esse mesmo
     arquivo vai para produção — trava que depende de alguém lembrar de trocar uma
     string não é trava. A trava é a ausência de LOGIN_DEMO, que vive só no
     .dev.vars, e o wrangler lê .dev.vars apenas em `wrangler dev`. */

  const ambiente = (extra: Record<string, unknown> = {}) => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'dev', ...extra,
  }) as never;

  beforeEach(semear);

  it('sem LOGIN_DEMO a rota não existe — é o caso de qualquer deploy', async () => {
    const r = await app.fetch(new Request('http://x/api/local'), ambiente());
    expect(r.status).toBe(404);
  });

  it('nem mesmo com AMBIENTE=dev, que é o valor que vai para produção', async () => {
    const r = await app.fetch(new Request('http://x/api/local'), ambiente({ AMBIENTE: 'dev' }));
    expect(r.status).toBe(404);
  });

  it('com LOGIN_DEMO devolve o par para a tela preencher', async () => {
    const r = await app.fetch(
      new Request('http://x/api/local'),
      ambiente({ LOGIN_DEMO: 'contadora@alfacontabil.net|alfa-contabilidade-2026' }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      email: 'contadora@alfacontabil.net', senha: 'alfa-contabilidade-2026',
    });
  });

  it('senha com "|" no meio não é cortada — só o primeiro separador conta', async () => {
    const r = await app.fetch(
      new Request('http://x/api/local'),
      ambiente({ LOGIN_DEMO: 'a@b.com|frase|com|barras' }),
    );
    expect((await r.json() as { senha: string }).senha).toBe('frase|com|barras');
  });

  it('valor malformado não vira credencial pela metade', async () => {
    for (const ruim of ['semseparador', '|so-a-senha']) {
      const r = await app.fetch(new Request('http://x/api/local'), ambiente({ LOGIN_DEMO: ruim }));
      expect(r.status).toBe(404);
    }
  });

  it('a rota é pública, mas continua sendo a única além de login e saúde', async () => {
    const r = await app.fetch(new Request('http://x/api/empresas'), ambiente());
    expect(r.status).toBe(401);
  });
});

describe('o 401 do login não é "sessão expirada"', () => {
  /* A tela intercepta todo 401 como sessão vencida e manda de volta ao login.
     Faz sentido para /api/notas — não faz para /api/login, onde 401 significa
     "e-mail ou senha inválidos". Na primeira tentativa de entrar em produção a
     tela mostrou "sessão expirada" para quem nunca tinha tido sessão nenhuma:
     a mensagem manda procurar o problema no lugar errado. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  beforeEach(semear);

  const entrar = (senha: string) => app.fetch(new Request('http://x/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha }),
  }), ambiente());

  it('senha errada devolve 401 dizendo que é a credencial', async () => {
    const r = await entrar('senha completamente errada');
    expect(r.status).toBe(401);
    expect((await r.json() as { erro: string }).erro).toContain('senha');
  });

  it('e-mail que não existe responde igualzinho — não entregamos a lista de usuários', async () => {
    const r = await app.fetch(new Request('http://x/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ninguem@lugar.nenhum', senha: 'seja o que for' }),
    }), ambiente());
    expect(r.status).toBe(401);
    expect((await r.json() as { erro: string }).erro).toContain('senha');
  });

  it('a senha certa entra', async () => {
    const r = await entrar('uma frase de senha longa');
    expect(r.status).toBe(200);
  });

  it('a tela só trata 401 como sessão vencida fora das rotas de entrada', () => {
    // São duas agora: a senha e o código. Errar um dígito do código não pode
    // devolver o usuário à primeira tela dizendo "sessão expirada".
    const app_js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(app_js).toContain("ROTAS_DE_ENTRADA = ['/api/login', '/api/login/mfa']");
    expect(app_js).toContain('!ROTAS_DE_ENTRADA.includes(caminho)');
  });
});

describe('trocar a senha dentro do app', () => {
  /* Faltava, e a falta apareceu do pior jeito: a senha do primeiro admin em
     produção foi digitada às cegas, sem confirmação, e a única saída era um
     script na máquina de quem publicou. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 'segredo-de-teste', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  const SENHA = 'uma frase de senha longa';
  let cookie = '';

  beforeEach(async () => {
    await semear();
    const r = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: SENHA }),
    }), ambiente());
    cookie = (r.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  });

  const trocar = (senhaAtual: string, senhaNova: string, ck = cookie) =>
    app.fetch(new Request('http://x/api/trocar-senha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: ck },
      body: JSON.stringify({ senhaAtual, senhaNova }),
    }), ambiente());

  const entrar = (senha: string) => app.fetch(new Request('http://x/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha }),
  }), ambiente());

  it('troca, e a senha nova passa a valer', async () => {
    expect((await trocar(SENHA, 'outra frase bem comprida 9')).status).toBe(200);
    expect((await entrar('outra frase bem comprida 9')).status).toBe(200);
  });

  it('a senha antiga para de valer na hora', async () => {
    await trocar(SENHA, 'outra frase bem comprida 9');
    expect((await entrar(SENHA)).status).toBe(401);
  });

  it('exige a senha atual — sessão roubada não vira conta roubada', async () => {
    const r = await trocar('chute errado', 'outra frase bem comprida 9');
    expect(r.status).toBe(400);
    expect((await r.json() as { erro: string }).erro).toContain('atual');
    expect((await entrar(SENHA)).status).toBe(200);   // nada mudou
  });

  it('sem sessão nenhuma, 401 — a rota é autenticada', async () => {
    expect((await trocar(SENHA, 'outra frase bem comprida 9', '')).status).toBe(401);
  });

  it('recusa senha fraca dizendo o que está faltando', async () => {
    const r = await trocar(SENHA, 'curta1');
    expect(r.status).toBe(400);
    expect((await r.json() as { erro: string }).erro).toContain('12 caracteres');
  });

  it('recusa repetir a senha atual', async () => {
    expect((await trocar(SENHA, SENHA)).status).toBe(400);
  });

  it('derruba as outras sessões — trocar senha é o que se faz quando se desconfia', async () => {
    const outra = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: SENHA }),
    }), ambiente());
    const cookieOutra = (outra.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    await trocar(SENHA, 'outra frase bem comprida 9');

    const r = await app.fetch(new Request('http://x/api/eu', {
      headers: { Cookie: cookieOutra },
    }), ambiente());
    expect(r.status).toBe(401);
  });

  it('mas não expulsa quem trocou: a resposta traz uma sessão nova válida', async () => {
    const t = await trocar(SENHA, 'outra frase bem comprida 9');
    const novoCookie = (t.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    expect(novoCookie).toContain('pf_sessao=');
    const eu = await app.fetch(new Request('http://x/api/eu', {
      headers: { Cookie: novoCookie },
    }), ambiente());
    expect(eu.status).toBe(200);
  });

  it('a troca fica na auditoria — sem o valor, só o fato', async () => {
    await trocar(SENHA, 'outra frase bem comprida 9');
    const { results } = await db
      .prepare("SELECT * FROM auditoria WHERE entidade = 'usuario' AND campo = 'senha'")
      .all<any>();
    expect(results.length).toBe(1);
    expect(results[0].valor_antes).toBeNull();
    expect(results[0].valor_depois).toBeNull();
    expect(results[0].acao).toBe('alterar');
  });
});

describe('segundo fator', () => {
  /* Entra agora, não "antes da fase 2". Autenticação é a parte do sistema que
     não se troca depois sem mexer em tudo — fluxo de login, sessão, telas e o
     modelo de usuário. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 'segredo-de-teste', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  const SENHA = 'uma frase de senha longa';
  let cookie = '';

  const post = (caminho: string, corpo: unknown, ck = '') =>
    app.fetch(new Request(`http://x${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ck ? { Cookie: ck } : {}) },
      body: JSON.stringify(corpo),
    }), ambiente());

  const entrar = (senha = SENHA) =>
    post('/api/login', { email: 'contadora@alfacontabil.net', senha });

  beforeEach(async () => {
    await semear();
    const r = await entrar();
    cookie = (r.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  });

  /** Liga o MFA e devolve o segredo e os códigos de recuperação. */
  async function ligarMfa() {
    const ini = await post('/api/mfa/iniciar', {}, cookie);
    const { segredo } = await ini.json() as { segredo: string };
    const codigo = await gerarTotp(segredo);
    const conf = await post('/api/mfa/confirmar', { codigo }, cookie);
    const { codigosRecuperacao } = await conf.json() as { codigosRecuperacao: string[] };
    return { segredo, codigosRecuperacao };
  }

  it('sem MFA, a senha certa já abre a sessão', async () => {
    const r = await entrar();
    expect(r.status).toBe(200);
    expect(r.headers.get('Set-Cookie')).toContain('pf_sessao=');
  });

  it('com MFA ligado, a senha sozinha NÃO abre sessão nenhuma', async () => {
    await ligarMfa();
    const r = await entrar();
    const corpo = await r.json() as { mfaRequerido: boolean; desafio: string };
    expect(corpo.mfaRequerido).toBe(true);
    expect(corpo.desafio).toBeTruthy();
    // O ponto inteiro: nenhum cookie de sessão nesta resposta.
    expect(r.headers.get('Set-Cookie')).toBeNull();
  });

  it('o código do aplicativo completa a entrada', async () => {
    const { segredo } = await ligarMfa();
    const { desafio } = await (await entrar()).json() as { desafio: string };
    // O código usado para confirmar já foi gasto — e isso é proposital. Aqui
    // usamos o do passo seguinte, que é o que a pessoa faz na vida real.
    const r = await post('/api/login/mfa', {
      desafio, codigo: await gerarTotp(segredo, Date.now() + 30_000),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('Set-Cookie')).toContain('pf_sessao=');
  });

  it('código errado não entra', async () => {
    await ligarMfa();
    const { desafio } = await (await entrar()).json() as { desafio: string };
    expect((await post('/api/login/mfa', { desafio, codigo: '000000' })).status).toBe(401);
  });

  it('o MESMO código não serve duas vezes — ombro alheio tem 30 segundos', async () => {
    const { segredo } = await ligarMfa();
    const codigo = await gerarTotp(segredo, Date.now() + 30_000);

    const d1 = await (await entrar()).json() as { desafio: string };
    expect((await post('/api/login/mfa', { desafio: d1.desafio, codigo })).status).toBe(200);

    const d2 = await (await entrar()).json() as { desafio: string };
    const r = await post('/api/login/mfa', { desafio: d2.desafio, codigo });
    expect(r.status).toBe(401);
    expect((await r.json() as { erro: string }).erro).toContain('já foi usado');
  });

  it('desafio não pode ser reusado', async () => {
    const { segredo } = await ligarMfa();
    const { desafio } = await (await entrar()).json() as { desafio: string };
    await post('/api/login/mfa', { desafio, codigo: await gerarTotp(segredo) });
    const r = await post('/api/login/mfa', { desafio, codigo: await gerarTotp(segredo) });
    expect(r.status).toBe(401);
  });

  it('desafio inventado não vale — só quem passou pela senha chega aqui', async () => {
    await ligarMfa();
    const r = await post('/api/login/mfa', {
      desafio: '00000000-0000-4000-8000-000000000000', codigo: '123456',
    });
    expect(r.status).toBe(401);
  });

  it('código de recuperação entra, e só uma vez — celular perdido não é conta perdida', async () => {
    const { codigosRecuperacao } = await ligarMfa();
    expect(codigosRecuperacao).toHaveLength(8);

    const d1 = await (await entrar()).json() as { desafio: string };
    expect((await post('/api/login/mfa', { desafio: d1.desafio, codigo: codigosRecuperacao[0]! })).status).toBe(200);

    const d2 = await (await entrar()).json() as { desafio: string };
    expect((await post('/api/login/mfa', { desafio: d2.desafio, codigo: codigosRecuperacao[0]! })).status).toBe(401);
  });

  it('os códigos de recuperação não ficam legíveis no banco', async () => {
    const { codigosRecuperacao } = await ligarMfa();
    const { results } = await db.prepare('SELECT codigo_hash FROM mfa_recuperacao').all<any>();
    for (const linha of results) {
      expect(linha.codigo_hash).toContain('pbkdf2$');
      for (const c of codigosRecuperacao) expect(linha.codigo_hash).not.toContain(c);
    }
  });

  it('confirmar com código errado não liga o MFA — erro de leitura do QR aparece agora', async () => {
    await post('/api/mfa/iniciar', {}, cookie);
    expect((await post('/api/mfa/confirmar', { codigo: '000000' }, cookie)).status).toBe(400);
    const r = await entrar();
    expect(r.headers.get('Set-Cookie')).toContain('pf_sessao=');   // segue sem MFA
  });

  it('desligar exige senha E código — sessão aberta esquecida não basta', async () => {
    const { segredo } = await ligarMfa();
    const proximo = () => gerarTotp(segredo, Date.now() + 30_000);
    expect((await post('/api/mfa/desativar', { senha: 'errada', codigo: await proximo() }, cookie)).status).toBe(400);
    expect((await post('/api/mfa/desativar', { senha: SENHA, codigo: '000000' }, cookie)).status).toBe(400);
    expect((await post('/api/mfa/desativar', { senha: SENHA, codigo: await proximo() }, cookie)).status).toBe(200);
  });

  it('código já gasto não desliga o segundo fator', async () => {
    // Sem esta trava, o mesmo código servia para ENTRAR e, em seguida, para
    // desativar a proteção — o que anula o segundo fator para quem espiou a tela.
    const { segredo } = await ligarMfa();
    const usadoNaConfirmacao = await gerarTotp(segredo);
    const r = await post('/api/mfa/desativar', { senha: SENHA, codigo: usadoNaConfirmacao }, cookie);
    expect(r.status).toBe(400);
    expect((await r.json() as { erro: string }).erro).toContain('já foi usado');
  });

  it('confirmar não vale com o MFA já ligado — era o caminho para gerar códigos novos', async () => {
    /* Era a falha mais grave da revisão: com o segundo fator JÁ ligado, quem
       tivesse a sessão e um único código de seis dígitos chamava /api/mfa/confirmar
       direto e recebia oito códigos de recuperação novos — bypass permanente —
       além de apagar os que a pessoa tinha guardado. */
    const { segredo, codigosRecuperacao } = await ligarMfa();
    const r = await post('/api/mfa/confirmar', {
      codigo: await gerarTotp(segredo, Date.now() + 30_000),
    }, cookie);
    expect(r.status).toBe(400);

    // E os códigos originais continuam valendo: nada foi apagado.
    const { desafio } = await (await entrar()).json() as { desafio: string };
    expect((await post('/api/login/mfa', { desafio, codigo: codigosRecuperacao[0]! })).status).toBe(200);
  });

  it('o desafio aceita no máximo 5 tentativas', async () => {
    // Seis dígitos são um milhão de combinações; cinco minutos de tentativas
    // livres mordem um pedaço perigoso disso.
    await ligarMfa();
    const { desafio } = await (await entrar()).json() as { desafio: string };
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/login/mfa', { desafio, codigo: '000000' })).status).toBe(401);
    }
    const r = await post('/api/login/mfa', { desafio, codigo: '000000' });
    expect((await r.json() as { erro: string }).erro).toContain('Comece de novo');
  });

  it('a troca do estado do MFA fica na auditoria', async () => {
    await ligarMfa();
    const { results } = await db
      .prepare("SELECT * FROM auditoria WHERE campo = 'mfa'").all<any>();
    expect(results.length).toBe(1);
    expect(results[0].valor_depois).toBe('ligado');
  });
});

describe('limite de tentativas por origem', () => {
  /* O bloqueio de 5 tentativas é por CONTA: trava quem insiste numa conta e não
     faz nada contra quem tenta uma senha em cem contas. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  const tentar = (email: string, ip = '203.0.113.7') =>
    app.fetch(new Request('http://x/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email, senha: 'chute errado aqui' }),
    }), ambiente());

  beforeEach(semear);

  it('20 falhas da mesma origem, mesmo em contas diferentes, travam a origem', async () => {
    for (let i = 0; i < 20; i++) await tentar(`pessoa${i}@alfacontabil.net`);
    const r = await tentar('contadora@alfacontabil.net');
    expect(r.status).toBe(429);
    expect((await r.json() as { erro: string }).erro).toContain('deste computador');
  });

  it('outra origem não é afetada — não derrubamos o escritório inteiro', async () => {
    for (let i = 0; i < 20; i++) await tentar(`pessoa${i}@alfacontabil.net`);
    expect((await tentar('contadora@alfacontabil.net', '198.51.100.9')).status).toBe(401);
  });

  it('abaixo do teto continua respondendo normalmente', async () => {
    for (let i = 0; i < 5; i++) await tentar(`pessoa${i}@alfacontabil.net`);
    expect((await tentar('x@alfacontabil.net')).status).toBe(401);
  });
});

describe('quais rotas dispensam sessão', () => {
  /* A segunda etapa do login é a mais fácil de esquecer nessa lista: ela vem
     depois da senha e antes da sessão. Exigir sessão nela torna o segundo fator
     impossível de completar — e o erro aparece como "não autenticado", que
     manda procurar o problema no lugar errado. Aconteceu. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  beforeEach(semear);

  it('sem cookie, as rotas de entrada NÃO respondem "não autenticado"', async () => {
    for (const caminho of ['/api/login', '/api/login/mfa']) {
      const r = await app.fetch(new Request(`http://x${caminho}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }), ambiente());
      const corpo = await r.text();
      expect(corpo).not.toContain('não autenticado');
    }
  });

  it('e todo o resto continua exigindo sessão', async () => {
    for (const caminho of ['/api/eu', '/api/empresas', '/api/mfa', '/api/trocar-senha']) {
      const r = await app.fetch(new Request(`http://x${caminho}`), ambiente());
      expect(r.status).toBe(401);
    }
  });
});

describe('o que a revisão adversarial encontrou', () => {
  /* Cada caso aqui corresponde a um achado com cenário de exploração descrito.
     Ficam juntos de propósito: se algum voltar, o teste diz qual e por quê. */

  const ambiente = (extra: Record<string, unknown> = {}) => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao', ...extra,
  }) as never;

  const post = (caminho: string, corpo: unknown, ip = '203.0.113.10') =>
    app.fetch(new Request(`http://x${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify(corpo),
    }), ambiente());

  beforeEach(semear);

  it('conta bloqueada responde igual a e-mail inexistente', async () => {
    // A mensagem "conta temporariamente bloqueada" dizia a quem sondasse que
    // aquele e-mail EXISTE. Cinco tentativas por endereço reconstruíam a lista
    // de usuários do escritório.
    for (let i = 0; i < 6; i++) {
      await post('/api/login', { email: 'contadora@alfacontabil.net', senha: 'errada demais' });
    }
    const bloqueada = await post('/api/login', { email: 'contadora@alfacontabil.net', senha: 'x errada' });
    const inexistente = await post('/api/login', { email: 'ninguem@lugar.nenhum', senha: 'x errada' });

    expect(bloqueada.status).toBe(inexistente.status);
    expect(await bloqueada.json()).toEqual(await inexistente.json());
  });

  it('sondar conta bloqueada também conta para o limite por origem', async () => {
    // O retorno antecipado pulava o registro: sondar saía de graça.
    for (let i = 0; i < 6; i++) {
      await post('/api/login', { email: 'contadora@alfacontabil.net', senha: 'errada demais' }, '198.51.100.1');
    }
    const antes = await db
      .prepare("SELECT COUNT(*) AS n FROM tentativas_login WHERE ip = '198.51.100.1'")
      .first<{ n: number }>();
    await post('/api/login', { email: 'contadora@alfacontabil.net', senha: 'de novo' }, '198.51.100.1');
    const depois = await db
      .prepare("SELECT COUNT(*) AS n FROM tentativas_login WHERE ip = '198.51.100.1'")
      .first<{ n: number }>();
    expect(depois!.n).toBeGreaterThan(antes!.n);
  });

  it('sem cabeçalho de IP o limite continua existindo — não falha aberto', async () => {
    const semIp = () => app.fetch(new Request('http://x/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@alfacontabil.net', senha: 'chute errado' }),
    }), ambiente());
    for (let i = 0; i < 20; i++) await semIp();
    expect((await semIp()).status).toBe(429);
  });

  it('/api/local não existe em produção, mesmo com LOGIN_DEMO definido', async () => {
    // Duas travas: um `wrangler secret put` por engano não basta para vazar.
    const r = await app.fetch(new Request('http://x/api/local'),
      ambiente({ LOGIN_DEMO: 'admin@x.com|senha secreta' }));
    expect(r.status).toBe(404);
  });

  it('senha redefinida pelo admin: a sessão só serve para trocar a senha', async () => {
    await db.prepare('UPDATE usuarios SET deve_trocar_senha = 1 WHERE id = ?').bind('u1').run();
    const r = await post('/api/login', {
      email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa',
    });
    const cookie = (r.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    const bloqueada = await app.fetch(new Request('http://x/api/empresas', {
      headers: { Cookie: cookie },
    }), ambiente());
    expect(bloqueada.status).toBe(403);

    // Mas o caminho para sair dessa situação continua aberto.
    const eu = await app.fetch(new Request('http://x/api/eu', { headers: { Cookie: cookie } }), ambiente());
    expect(eu.status).toBe(200);
  });

  it('ler nota exige permissão, não só estar logado', async () => {
    // O recorte por empresa não substitui a permissão: sem ela, um papel
    // montado às pressas lê CNPJ, valor e item de cliente de terceiro.
    await db.prepare("DELETE FROM papel_permissoes WHERE permissao = 'notas.visualizar'").run();
    const r = await post('/api/login', {
      email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa',
    });
    const cookie = (r.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    const notas = await app.fetch(new Request('http://x/api/notas/qualquer', {
      headers: { Cookie: cookie },
    }), ambiente());
    expect(notas.status).toBe(403);
  });

  it('hash com base64 corrompido é "não confere", não exceção', async () => {
    // Entrada suja continua devolvendo false; o que não pode é o catch genérico
    // engolir falha de ambiente, como aconteceu com o teto de iterações.
    const { conferirSenha } = await import('../src/auth/senha');
    await expect(conferirSenha('x', 'pbkdf2$100000$!!!$???')).resolves.toBe(false);
  });
});

describe('permissões por verbo e administração', () => {
  /* Pedido do cliente, com o exemplo dele: "não pode modificar empresas, não
     pode criar empresas, pode X ação". Antes `empresas.gerenciar` respondia por
     ver, criar e editar de uma vez — uma permissão não consegue dizer isso. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  const SENHA = 'uma frase de senha longa';
  let cookieAdmin = '';

  const req = (caminho: string, opts: RequestInit = {}, ck = cookieAdmin) =>
    app.fetch(new Request(`http://x${caminho}`, {
      ...opts,
      headers: { 'content-type': 'application/json', Cookie: ck, ...(opts.headers ?? {}) },
    }), ambiente());

  const entrar = (email: string, senha: string) =>
    app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, senha }),
    }), ambiente());

  beforeEach(async () => {
    await semear();
    const r = await entrar('contadora@alfacontabil.net', SENHA);
    cookieAdmin = (r.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  });

  it('o papel Admin tem TODAS as permissões do catálogo — sem buraco', async () => {
    const { results } = await db
      .prepare(
        `SELECT pp.permissao FROM papel_permissoes pp
           JOIN papeis p ON p.id = pp.papel_id WHERE p.sistema = 1`,
      ).all<{ permissao: string }>();
    const noBanco = new Set(results.map((r) => r.permissao));
    for (const p of TODAS_PERMISSOES) expect(noBanco.has(p)).toBe(true);
  });

  it('criar e editar empresa são poderes separados', async () => {
    // O caso exato que o cliente descreveu.
    const papel = await req('/api/papeis', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Fiscal Jr',
        permissoes: ['notas.visualizar', 'empresas.visualizar', 'empresas.editar'],
      }),
    });
    expect(papel.status).toBe(200);
    const { id: papelId } = await papel.json() as { id: string };

    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'jr@alfacontabil.net', nome: 'Fiscal Jr', papelId }),
    });
    expect(novo.status).toBe(201);
    const { senhaProvisoria } = await novo.json() as { senhaProvisoria: string };

    const login = await entrar('jr@alfacontabil.net', senhaProvisoria);
    const ck = (login.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    // Senha provisória: só a troca funciona. Trocamos e seguimos.
    await app.fetch(new Request('http://x/api/trocar-senha', {
      method: 'POST', headers: { 'content-type': 'application/json', Cookie: ck },
      body: JSON.stringify({ senhaAtual: senhaProvisoria, senhaNova: 'outra frase longa 12' }),
    }), ambiente());
    const login2 = await entrar('jr@alfacontabil.net', 'outra frase longa 12');
    const ck2 = (login2.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    // CRIAR: não pode.
    const criar = await req('/api/empresas', {
      method: 'POST',
      body: JSON.stringify({ cnpj: '11222333000181', razaoSocial: 'Teste LTDA', perfil: 'revenda' }),
    }, ck2);
    expect(criar.status).toBe(403);

    // EDITAR: pode (a empresa não existe, então 404 — mas passou da permissão).
    const editar = await req('/api/empresas/inexistente', {
      method: 'PATCH', body: JSON.stringify({ observacoes: 'x' }),
    }, ck2);
    expect(editar.status).not.toBe(403);
  });

  it('ninguém concede permissão que não tem', async () => {
    // Sem isto, quem edita papéis marca tudo no próprio papel e vira
    // administrador — o que faria de `papeis.gerenciar` a única que importa.
    const papel = await req('/api/papeis', {
      method: 'POST',
      body: JSON.stringify({ nome: 'Limitado', permissoes: ['papeis.gerenciar', 'notas.visualizar'] }),
    });
    const { id: papelId } = await papel.json() as { id: string };
    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'lim@alfacontabil.net', nome: 'Limitado', papelId }),
    });
    const { senhaProvisoria } = await novo.json() as { senhaProvisoria: string };
    const l = await entrar('lim@alfacontabil.net', senhaProvisoria);
    const ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    await app.fetch(new Request('http://x/api/trocar-senha', {
      method: 'POST', headers: { 'content-type': 'application/json', Cookie: ck },
      body: JSON.stringify({ senhaAtual: senhaProvisoria, senhaNova: 'mais uma frase 123' }),
    }), ambiente());
    const l2 = await entrar('lim@alfacontabil.net', 'mais uma frase 123');
    const ck2 = (l2.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    const tentativa = await req('/api/papeis', {
      method: 'POST',
      body: JSON.stringify({ nome: 'Tudo', permissoes: ['usuarios.criar', 'empresas.criar'] }),
    }, ck2);
    expect(tentativa.status).toBe(403);
    expect((await tentativa.json() as { erro: string }).erro).toContain('não pode conceder');
  });

  it('exceção por pessoa: tira do papel e acrescenta ao papel', async () => {
    const papeis = await (await req('/api/papeis')).json() as any[];
    const operador = papeis.find((p) => p.nome === 'Operador')!;
    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({
        email: 'exc@alfacontabil.net', nome: 'Com Exceção', papelId: operador.id,
        excecoes: [
          { permissao: 'notas.importar', concedida: false },   // tira
          { permissao: 'notas.exportar', concedida: true },    // acrescenta
        ],
      }),
    });
    expect(novo.status).toBe(201);
    const { senhaProvisoria } = await novo.json() as { senhaProvisoria: string };
    const l = await entrar('exc@alfacontabil.net', senhaProvisoria);
    const ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    await app.fetch(new Request('http://x/api/trocar-senha', {
      method: 'POST', headers: { 'content-type': 'application/json', Cookie: ck },
      body: JSON.stringify({ senhaAtual: senhaProvisoria, senhaNova: 'terceira frase 45' }),
    }), ambiente());
    const l2 = await entrar('exc@alfacontabil.net', 'terceira frase 45');
    const ck2 = (l2.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    const eu = await (await req('/api/eu', {}, ck2)).json() as { permissoes: string[] };
    expect(eu.permissoes).not.toContain('notas.importar');   // o papel dava
    expect(eu.permissoes).toContain('notas.exportar');       // o papel não dava
    expect(eu.permissoes).toContain('notas.editar_cfop');    // o resto do papel continua
  });

  it('usuário novo nasce com senha provisória e obrigado a trocar', async () => {
    const papeis = await (await req('/api/papeis')).json() as any[];
    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'prov@alfacontabil.net', nome: 'Provisória', papelId: papeis[0].id }),
    });
    const { senhaProvisoria } = await novo.json() as { senhaProvisoria: string };
    expect(senhaProvisoria.length).toBeGreaterThanOrEqual(12);

    const l = await entrar('prov@alfacontabil.net', senhaProvisoria);
    const ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    // Entra, mas a sessão só serve para trocar a senha.
    expect((await req('/api/empresas', {}, ck)).status).toBe(403);
    expect((await req('/api/eu', {}, ck)).status).toBe(200);
  });

  it('mudar permissão derruba as sessões da pessoa na hora', async () => {
    // "Tirei o acesso dele" não pode ser mentira por até 12 horas.
    const papeis = await (await req('/api/papeis')).json() as any[];
    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'ses@alfacontabil.net', nome: 'Sessão', papelId: papeis[0].id }),
    });
    const { id, senhaProvisoria } = await novo.json() as { id: string; senhaProvisoria: string };
    const l = await entrar('ses@alfacontabil.net', senhaProvisoria);
    const ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    await req(`/api/usuarios/${id}`, {
      method: 'PUT', body: JSON.stringify({ nome: 'Sessão', papelId: papeis[0].id }),
    });
    expect((await req('/api/eu', {}, ck)).status).toBe(401);
  });

  it('o papel Admin não pode ser alterado nem apagado', async () => {
    const papeis = await (await req('/api/papeis')).json() as any[];
    const admin = papeis.find((p) => p.sistema)!;
    expect((await req(`/api/papeis/${admin.id}`, {
      method: 'PUT', body: JSON.stringify({ nome: 'Admin', permissoes: [] }),
    })).status).toBe(400);
    expect((await req(`/api/papeis/${admin.id}`, { method: 'DELETE' })).status).toBe(400);
  });

  it('papel em uso não pode ser apagado', async () => {
    const papeis = await (await req('/api/papeis')).json() as any[];
    const operador = papeis.find((p) => p.nome === 'Operador')!;
    await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'uso@alfacontabil.net', nome: 'Em Uso', papelId: operador.id }),
    });
    const r = await req(`/api/papeis/${operador.id}`, { method: 'DELETE' });
    expect(r.status).toBe(400);
    expect((await r.json() as { erro: string }).erro).toContain('em uso');
  });

  it('ninguém desativa a si mesmo', async () => {
    const eu = await (await req('/api/eu')).json() as any;
    const us = await (await req('/api/usuarios')).json() as any[];
    const meu = us.find((u) => u.email === eu.email)!;
    const r = await req(`/api/usuarios/${meu.id}/ativo`, {
      method: 'POST', body: JSON.stringify({ ativo: false }),
    });
    expect(r.status).toBe(400);
  });

  it('desativar derruba a sessão e impede entrar de novo', async () => {
    const papeis = await (await req('/api/papeis')).json() as any[];
    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'des@alfacontabil.net', nome: 'Desativado', papelId: papeis[0].id }),
    });
    const { id, senhaProvisoria } = await novo.json() as { id: string; senhaProvisoria: string };
    const l = await entrar('des@alfacontabil.net', senhaProvisoria);
    const ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    await req(`/api/usuarios/${id}/ativo`, { method: 'POST', body: JSON.stringify({ ativo: false }) });
    expect((await req('/api/eu', {}, ck)).status).toBe(401);
    expect((await entrar('des@alfacontabil.net', senhaProvisoria)).status).toBe(401);
  });

  it('e-mail repetido é recusado', async () => {
    const papeis = await (await req('/api/papeis')).json() as any[];
    const corpo = JSON.stringify({
      email: 'CONTADORA@alfacontabil.net', nome: 'Duplicada', papelId: papeis[0].id,
    });
    const r = await req('/api/usuarios', { method: 'POST', body: corpo });
    expect(r.status).toBe(400);
  });

  it('quem não administra não vê nem a lista de usuários', async () => {
    const papeis = await (await req('/api/papeis')).json() as any[];
    const operador = papeis.find((p) => p.nome === 'Operador')!;
    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'op@alfacontabil.net', nome: 'Operador', papelId: operador.id }),
    });
    const { senhaProvisoria } = await novo.json() as { senhaProvisoria: string };
    const l = await entrar('op@alfacontabil.net', senhaProvisoria);
    const ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    await app.fetch(new Request('http://x/api/trocar-senha', {
      method: 'POST', headers: { 'content-type': 'application/json', Cookie: ck },
      body: JSON.stringify({ senhaAtual: senhaProvisoria, senhaNova: 'quarta frase aqui 9' }),
    }), ambiente());
    const l2 = await entrar('op@alfacontabil.net', 'quarta frase aqui 9');
    const ck2 = (l2.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    expect((await req('/api/usuarios', {}, ck2)).status).toBe(403);
    expect((await req('/api/permissoes', {}, ck2)).status).toBe(403);
  });
});

describe('cadastro público com aprovação', () => {
  /* Uma tela de criar conta é conveniência para o escritório. O que ela não pode
     ser é porta aberta: a conta nasce sem papel nenhum e inerte. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  const post = (caminho: string, corpo: unknown, ck = '', ip = '203.0.113.55') =>
    app.fetch(new Request(`http://x${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, ...(ck ? { Cookie: ck } : {}) },
      body: JSON.stringify(corpo),
    }), ambiente());

  const SENHA = 'uma frase de senha longa';
  const NOVA = 'frase comprida de teste 8';
  let cookieAdmin = '';

  const entrar = (email: string, senha: string) =>
    post('/api/login', { email, senha });

  const cadastrar = () => post('/api/cadastrar', {
    nome: 'Joana Fiscal', email: 'joana@alfacontabil.net', senha: NOVA,
  });

  beforeEach(async () => {
    await semear();
    const r = await entrar('contadora@alfacontabil.net', SENHA);
    cookieAdmin = (r.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  });

  it('qualquer um pode se cadastrar — a rota é pública', async () => {
    const r = await cadastrar();
    expect(r.status).toBe(200);
    expect((await r.json() as { mensagem: string }).mensagem).toContain('administrador');
  });

  it('a conta nasce pendente, sem papel e sem conseguir entrar', async () => {
    await cadastrar();
    const u = await db
      .prepare("SELECT ativo, pendente FROM usuarios WHERE email = 'joana@alfacontabil.net'")
      .first<{ ativo: number; pendente: number }>();
    expect(u!.pendente).toBe(1);
    expect(u!.ativo).toBe(0);

    const papeis = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM usuario_papeis up
           JOIN usuarios u ON u.id = up.usuario_id WHERE u.email = 'joana@alfacontabil.net'`,
      ).first<{ n: number }>();
    expect(papeis!.n).toBe(0);
  });

  it('com a senha certa, ela ouve que falta liberação — e só então', async () => {
    await cadastrar();
    const certa = await entrar('joana@alfacontabil.net', NOVA);
    expect(certa.status).toBe(403);
    expect((await certa.json() as { erro: string }).erro).toContain('não foi liberada');

    // Com a senha errada, a resposta é a genérica: quem não é dono da conta não
    // descobre nem que ela existe.
    const errada = await entrar('joana@alfacontabil.net', 'chute errado aqui');
    expect(errada.status).toBe(401);
    expect((await errada.json() as { erro: string }).erro).toContain('inválidos');
  });

  it('cadastrar e-mail que já existe responde igual — não vira descobridor de usuários', async () => {
    const novo = await post('/api/cadastrar', {
      nome: 'Alguém', email: 'nova@alfacontabil.net', senha: NOVA,
    });
    const repetido = await post('/api/cadastrar', {
      nome: 'Impostor', email: 'contadora@alfacontabil.net', senha: NOVA,
    });
    expect(repetido.status).toBe(novo.status);
    expect(await repetido.json()).toEqual(await novo.json());
  });

  it('e não sobrescreve a conta existente', async () => {
    await post('/api/cadastrar', {
      nome: 'Impostor', email: 'contadora@alfacontabil.net', senha: 'outra frase comprida 9',
    });
    // A senha da contadora continua sendo a dela.
    expect((await entrar('contadora@alfacontabil.net', SENHA)).status).toBe(200);
    expect((await entrar('contadora@alfacontabil.net', 'outra frase comprida 9')).status).toBe(401);
  });

  it('senha fraca é recusada no cadastro', async () => {
    const r = await post('/api/cadastrar', { nome: 'X', email: 'x@alfacontabil.net', senha: 'curta' });
    expect(r.status).toBe(400);
  });

  it('o limite por origem vale aqui também — cadastro em massa não passa', async () => {
    for (let i = 0; i < 20; i++) {
      await post('/api/cadastrar', {
        nome: `Robo ${i}`, email: `robo${i}@alfacontabil.net`, senha: NOVA,
      }, '', '198.51.100.77');
    }
    const r = await post('/api/cadastrar', {
      nome: 'Robo final', email: 'final@alfacontabil.net', senha: NOVA,
    }, '', '198.51.100.77');
    expect(r.status).toBe(429);
  });

  it('depois de liberada, ela entra com a senha que escolheu', async () => {
    await cadastrar();
    const us = await (await app.fetch(new Request('http://x/api/usuarios', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    const joana = us.find((u) => u.email === 'joana@alfacontabil.net')!;
    expect(joana.pendente).toBe(true);

    const papeis = await (await app.fetch(new Request('http://x/api/papeis', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    const operador = papeis.find((p) => p.nome === 'Operador')!;

    const ap = await post(`/api/usuarios/${joana.id}/aprovar`, { papelId: operador.id }, cookieAdmin);
    expect(ap.status).toBe(200);

    const login = await entrar('joana@alfacontabil.net', NOVA);
    expect(login.status).toBe(200);
    // E já entra com o papel que o admin escolheu — sem senha provisória no meio.
    const ck = (login.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    const eu = await (await app.fetch(new Request('http://x/api/eu', {
      headers: { Cookie: ck },
    }), ambiente())).json() as { permissoes: string[] };
    expect(eu.permissoes).toContain('notas.editar_cfop');
    expect(eu.permissoes).not.toContain('usuarios.criar');
  });

  it('quem não tem usuarios.aprovar não libera ninguém', async () => {
    await cadastrar();
    const us = await (await app.fetch(new Request('http://x/api/usuarios', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    const joana = us.find((u) => u.email === 'joana@alfacontabil.net')!;
    const papeis = await (await app.fetch(new Request('http://x/api/papeis', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];

    // Cria alguém sem a permissão de aprovar.
    await db.prepare("DELETE FROM papel_permissoes WHERE permissao = 'usuarios.aprovar'").run();
    const r = await post(`/api/usuarios/${joana.id}/aprovar`, { papelId: papeis[0].id }, cookieAdmin);
    expect(r.status).toBe(403);
  });

  it('recusar apaga o pedido e deixa a pessoa tentar de novo', async () => {
    await cadastrar();
    const us = await (await app.fetch(new Request('http://x/api/usuarios', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    const joana = us.find((u) => u.email === 'joana@alfacontabil.net')!;

    expect((await post(`/api/usuarios/${joana.id}/recusar`, {}, cookieAdmin)).status).toBe(200);
    const sumiu = await db
      .prepare("SELECT id FROM usuarios WHERE email = 'joana@alfacontabil.net'").first();
    expect(sumiu).toBeNull();

    // A trilha guarda o que aconteceu, mesmo com a conta apagada.
    const trilha = await db
      .prepare("SELECT * FROM auditoria WHERE campo = 'aprovacao'").first<any>();
    expect(trilha.valor_depois).toBe('recusado');

    expect((await cadastrar()).status).toBe(200);
  });

  it('aprovar duas vezes não funciona', async () => {
    await cadastrar();
    const us = await (await app.fetch(new Request('http://x/api/usuarios', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    const joana = us.find((u) => u.email === 'joana@alfacontabil.net')!;
    const papeis = await (await app.fetch(new Request('http://x/api/papeis', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    await post(`/api/usuarios/${joana.id}/aprovar`, { papelId: papeis[0].id }, cookieAdmin);
    const dnv = await post(`/api/usuarios/${joana.id}/aprovar`, { papelId: papeis[0].id }, cookieAdmin);
    expect(dnv.status).toBe(404);
  });
});

describe('os três destinos de um login, depois de a senha conferir', () => {
  /* Buscar o usuário filtrando por `ativo = 1` fazia conta pendente cair no
     caminho de "e-mail não existe": a pessoa via "senha inválida" com a senha
     certa e ia procurar o problema onde ele não estava. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;
  const entrar = (email: string, senha: string) =>
    app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, senha }),
    }), ambiente());

  beforeEach(semear);

  it('ativa: entra', async () => {
    expect((await entrar('contadora@alfacontabil.net', 'uma frase de senha longa')).status).toBe(200);
  });

  it('pendente: 403 explicando que falta liberação', async () => {
    await db.prepare('UPDATE usuarios SET pendente = 1, ativo = 0 WHERE id = ?').bind('u1').run();
    const r = await entrar('contadora@alfacontabil.net', 'uma frase de senha longa');
    expect(r.status).toBe(403);
    expect((await r.json() as { erro: string }).erro).toContain('liberada');
  });

  it('desativada: 401 genérico, igual a e-mail inexistente', async () => {
    await db.prepare('UPDATE usuarios SET ativo = 0 WHERE id = ?').bind('u1').run();
    const desativada = await entrar('contadora@alfacontabil.net', 'uma frase de senha longa');
    const inexistente = await entrar('ninguem@lugar.nenhum', 'seja o que for');
    expect(desativada.status).toBe(401);
    expect(await desativada.json()).toEqual(await inexistente.json());
  });
});

describe('esqueci minha senha', () => {
  /* Sem serviço de e-mail, o pedido vira uma linha destacada na tela de usuários
     e o administrador entrega a provisória. Menos automático e, por enquanto,
     mais seguro: não existe link de redefinição circulando por caixa de entrada. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  const post = (caminho: string, corpo: unknown, ck = '', ip = '203.0.113.90') =>
    app.fetch(new Request(`http://x${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, ...(ck ? { Cookie: ck } : {}) },
      body: JSON.stringify(corpo),
    }), ambiente());

  const SENHA = 'uma frase de senha longa';
  let cookieAdmin = '';

  beforeEach(async () => {
    await semear();
    const r = await post('/api/login', { email: 'contadora@alfacontabil.net', senha: SENHA });
    cookieAdmin = (r.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  });

  it('a rota é pública — quem esqueceu a senha não consegue entrar para pedir', async () => {
    const r = await post('/api/esqueci', { email: 'contadora@alfacontabil.net' });
    expect(r.status).toBe(200);
  });

  it('e-mail que não existe responde igual — não é verificador de contas', async () => {
    const existe = await post('/api/esqueci', { email: 'contadora@alfacontabil.net' });
    const nao = await post('/api/esqueci', { email: 'ninguem@lugar.nenhum' });
    expect(nao.status).toBe(existe.status);
    expect(await nao.json()).toEqual(await existe.json());
  });

  it('o pedido aparece para o administrador', async () => {
    await post('/api/esqueci', { email: 'contadora@alfacontabil.net' });
    const us = await (await app.fetch(new Request('http://x/api/usuarios', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    expect(us.find((u) => u.email === 'contadora@alfacontabil.net')!.pediuSenha).toBe(true);
  });

  it('redefinir a senha limpa o pedido — a linha para de piscar', async () => {
    // Outra pessoa, não o próprio admin: redefinir a própria senha revoga as
    // próprias sessões, e a segunda consulta viria com 401. O comportamento está
    // certo; o teste é que precisa de duas pessoas.
    const papeis = await (await app.fetch(new Request('http://x/api/papeis', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    const criado = await post('/api/usuarios', {
      email: 'esqueceu@alfacontabil.net', nome: 'Esqueceu', papelId: papeis[0].id,
    }, cookieAdmin);
    const { id } = await criado.json() as { id: string };
    // Sai do estado de senha provisória, senão o pedido não faz sentido.
    await db.prepare('UPDATE usuarios SET deve_trocar_senha = 0 WHERE id = ?').bind(id).run();

    await post('/api/esqueci', { email: 'esqueceu@alfacontabil.net' });
    const antes = await (await app.fetch(new Request('http://x/api/usuarios', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    expect(antes.find((u) => u.id === id)!.pediuSenha).toBe(true);

    const r = await post(`/api/usuarios/${id}/redefinir-senha`, {
      senhaProvisoria: 'provisoria comprida 7', minhaSenha: SENHA,
    }, cookieAdmin);
    expect(r.status).toBe(200);

    const depois = await (await app.fetch(new Request('http://x/api/usuarios', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    expect(depois.find((u) => u.id === id)!.pediuSenha).toBe(false);
  });

  it('redefinir a própria senha derruba a própria sessão — e isso é o certo', async () => {
    const us = await (await app.fetch(new Request('http://x/api/usuarios', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    const eu = us.find((u) => u.email === 'contadora@alfacontabil.net')!;
    await post(`/api/usuarios/${eu.id}/redefinir-senha`, {
      senhaProvisoria: 'provisoria comprida 7', minhaSenha: SENHA,
    }, cookieAdmin);
    const r = await app.fetch(new Request('http://x/api/eu', {
      headers: { Cookie: cookieAdmin },
    }), ambiente());
    expect(r.status).toBe(401);
  });

  it('pedir não muda a senha nem derruba ninguém', async () => {
    await post('/api/esqueci', { email: 'contadora@alfacontabil.net' });
    expect((await post('/api/login', { email: 'contadora@alfacontabil.net', senha: SENHA })).status).toBe(200);
  });

  it('conta pendente não gera pedido — ela nem tem acesso ainda', async () => {
    await post('/api/cadastrar', {
      nome: 'Pendente', email: 'pend@alfacontabil.net', senha: 'frase comprida de teste 8',
    });
    await post('/api/esqueci', { email: 'pend@alfacontabil.net' });
    const u = await db
      .prepare("SELECT senha_solicitada_em FROM usuarios WHERE email = 'pend@alfacontabil.net'")
      .first<{ senha_solicitada_em: string | null }>();
    expect(u!.senha_solicitada_em).toBeNull();
  });

  it('o limite por origem vale aqui também', async () => {
    for (let i = 0; i < 20; i++) {
      await post('/api/esqueci', { email: `x${i}@alfacontabil.net` }, '', '198.51.100.200');
    }
    const r = await post('/api/esqueci', { email: 'y@alfacontabil.net' }, '', '198.51.100.200');
    expect(r.status).toBe(429);
  });
});

describe('duplicata não é "erro interno"', () => {
  /* Cadastrar um cliente que já existe devolvia 500 com "erro interno". O banco
     dizia exatamente qual constraint falhou; a API jogava fora essa informação e
     mandava o operador procurar defeito no sistema em vez de olhar a lista.

     É a mesma família do bug das iterações do PBKDF2: exceção prevista tratada
     como defeito anônimo. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  let cookie = '';
  const post = (caminho: string, corpo: unknown) =>
    app.fetch(new Request(`http://x${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify(corpo),
    }), ambiente());

  const EMPRESA = {
    cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO LTDA',
    uf: 'SC', perfil: 'revenda' as const,
  };

  beforeEach(async () => {
    await semear();
    const r = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    cookie = (r.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  });

  it('CNPJ repetido diz o que é, e diz o nome de quem já usa', async () => {
    expect((await post('/api/empresas', EMPRESA)).status).toBe(201);
    const r = await post('/api/empresas', { ...EMPRESA, razaoSocial: 'OUTRO NOME LTDA' });
    expect(r.status).toBe(409);
    const { erro } = await r.json() as { erro: string };
    expect(erro).toContain('já está cadastrado');
    expect(erro).toContain('MERCADO PILOTO LTDA');
    expect(erro).not.toContain('erro interno');
  });

  it('o CNPJ é comparado só pelos dígitos — pontuação não cria duplicata', async () => {
    await post('/api/empresas', EMPRESA);
    const r = await post('/api/empresas', { ...EMPRESA, cnpj: '11.222.333/0001-81' });
    expect(r.status).toBe(409);
  });

  it('papel com nome repetido também não vira "erro interno"', async () => {
    await post('/api/papeis', { nome: 'Fiscal Jr', permissoes: ['notas.visualizar'] });
    const r = await post('/api/papeis', { nome: 'Fiscal Jr', permissoes: ['notas.visualizar'] });
    expect(r.status).toBe(409);
    expect((await r.json() as { erro: string }).erro).toContain('papel');
  });

  it('a mesma nota importada duas vezes não estoura', async () => {
    // O importador já trata duplicata como resultado, não como erro — este teste
    // existe para que continue assim.
    const empresa = await (await post('/api/empresas', EMPRESA)).json() as { id: string };
    const form = () => {
      const f = new FormData();
      f.append('arquivos', new File([XML], 'nota.xml', { type: 'text/xml' }));
      return f;
    };
    const subir = () => app.fetch(new Request(`http://x/api/empresas/${empresa.id}/importar`, {
      method: 'POST', headers: { Cookie: cookie }, body: form(),
    }), ambiente());
    expect((await subir()).status).toBe(200);
    const r = await subir();
    expect(r.status).toBe(200);
    const corpo = await r.json() as { arquivos: { status: string }[] };
    // O importador trata duplicata como RESULTADO, não como erro — a nota já
    // estava lá, e isso é uma resposta, não um defeito.
    const lista = (corpo as any).arquivos ?? (corpo as any).resultados ?? [];
    expect(lista[0]?.status).toBe('duplicada');
  });
});

describe('convite: entrar já liberado, sem ninguém aprovar', () => {
  /* O pedido foi "os 3 primeiros que entrarem já entram como admin, para não
     termos trabalho". O objetivo está certo — ninguém aprovar ninguém. O
     critério "os 3 primeiros" é que não dá: o endereço é público, então os três
     primeiros podem ser três desconhecidos que acharam a URL antes dos colegas,
     e seriam administradores de um sistema com nota fiscal de clientes.

     O convite entrega o mesmo resultado com o poder seguindo quem RECEBEU o
     link, e não quem chegou primeiro. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  const post = (caminho: string, corpo: unknown, ck = '') =>
    app.fetch(new Request(`http://x${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.31', ...(ck ? { Cookie: ck } : {}) },
      body: JSON.stringify(corpo),
    }), ambiente());

  const SENHA = 'uma frase de senha longa';
  let cookieAdmin = '';
  let papelAdmin = '';

  beforeEach(async () => {
    await semear();
    const r = await post('/api/login', { email: 'contadora@alfacontabil.net', senha: SENHA });
    cookieAdmin = (r.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    const papeis = await (await app.fetch(new Request('http://x/api/papeis', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    papelAdmin = papeis.find((p) => p.nome === 'Admin')!.id;
  });

  const criarConvite = async (usos = 3, papelId = papelAdmin) =>
    (await (await post('/api/convites', { papelId, usos }, cookieAdmin)).json()) as
      { codigo: string; papel: string; usos: number };

  const cadastrar = (email: string, convite?: string) =>
    post('/api/cadastrar', {
      nome: 'Colega', email, senha: 'frase comprida de teste 8', convite,
    });

  it('quem usa o convite entra na hora, com o papel do convite', async () => {
    const { codigo, papel } = await criarConvite();
    expect(papel).toBe('Admin');

    const r = await cadastrar('c1@alfacontabil.net', codigo);
    expect((await r.json() as { liberado: boolean }).liberado).toBe(true);

    // Entra direto: sem pendência, sem senha provisória, sem aprovação.
    const login = await post('/api/login', {
      email: 'c1@alfacontabil.net', senha: 'frase comprida de teste 8',
    });
    expect(login.status).toBe(200);
    const ck = (login.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    const eu = await (await app.fetch(new Request('http://x/api/eu', {
      headers: { Cookie: ck },
    }), ambiente())).json() as { permissoes: string[] };
    expect(eu.permissoes).toContain('usuarios.criar');
  });

  it('o convite acaba: o quarto usa e não entra', async () => {
    const { codigo } = await criarConvite(3);
    for (const n of [1, 2, 3]) {
      expect((await cadastrar(`c${n}@alfacontabil.net`, codigo)).status).toBe(200);
    }
    const quarto = await cadastrar('c4@alfacontabil.net', codigo);
    expect(quarto.status).toBe(400);
    expect((await quarto.json() as { erro: string }).erro).toContain('convite');
    // E não sobrou conta pendente escondida para o quarto.
    const existe = await db
      .prepare("SELECT id FROM usuarios WHERE email = 'c4@alfacontabil.net'").first();
    expect(existe).toBeNull();
  });

  it('convite errado avisa em vez de criar conta pendente em silêncio', async () => {
    // Quem digitou um código acha que vai entrar direto; deixar virar pendente
    // sem avisar faria a pessoa esperar por algo que nunca vem.
    const r = await cadastrar('errado@alfacontabil.net', 'XXXX-YYYY-ZZZZ');
    expect(r.status).toBe(400);
  });

  it('sem convite, continua o caminho de aprovação', async () => {
    const r = await cadastrar('semconvite@alfacontabil.net');
    expect(r.status).toBe(200);
    const u = await db
      .prepare("SELECT pendente FROM usuarios WHERE email = 'semconvite@alfacontabil.net'")
      .first<{ pendente: number }>();
    expect(u!.pendente).toBe(1);
  });

  it('convite revogado para de valer na hora', async () => {
    const { codigo } = await criarConvite(5);
    const lista = await (await app.fetch(new Request('http://x/api/convites', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    await app.fetch(new Request(`http://x/api/convites/${lista[0].id}`, {
      method: 'DELETE', headers: { Cookie: cookieAdmin },
    }), ambiente());
    expect((await cadastrar('tarde@alfacontabil.net', codigo)).status).toBe(400);
  });

  it('convite vencido não vale', async () => {
    const { codigo } = await criarConvite(5);
    await db.prepare("UPDATE convites SET expira_em = '2020-01-01T00:00:00.000Z'").run();
    expect((await cadastrar('vencido@alfacontabil.net', codigo)).status).toBe(400);
  });

  it('o código não fica legível no banco', async () => {
    const { codigo } = await criarConvite();
    const linha = await db.prepare('SELECT codigo_hash FROM convites').first<{ codigo_hash: string }>();
    expect(linha!.codigo_hash).not.toContain(codigo);
    expect(linha!.codigo_hash).toHaveLength(64);
  });

  it('e a listagem também não devolve o código', async () => {
    await criarConvite();
    const lista = await (await app.fetch(new Request('http://x/api/convites', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    expect(JSON.stringify(lista)).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  });

  it('ninguém convida para um papel mais poderoso que o seu', async () => {
    const papeis = await (await app.fetch(new Request('http://x/api/papeis', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    const operador = papeis.find((p) => p.nome === 'Operador')!;

    // Cria alguém que pode convidar e tem exatamente o que o Operador tem —
    // nem mais, nem menos. Assim o teste isola a regra: convidar para o papel
    // igual ao seu pode; para um mais poderoso, não.
    await post('/api/papeis', {
      nome: 'Convidador', permissoes: [...operador.permissoes, 'usuarios.convidar'],
    }, cookieAdmin);
    const ps = await (await app.fetch(new Request('http://x/api/papeis', {
      headers: { Cookie: cookieAdmin },
    }), ambiente())).json() as any[];
    const conv = ps.find((p) => p.nome === 'Convidador')!;
    const novo = await post('/api/usuarios', {
      email: 'conv@alfacontabil.net', nome: 'Convidador', papelId: conv.id,
    }, cookieAdmin);
    const { senhaProvisoria } = await novo.json() as { senhaProvisoria: string };
    const l = await post('/api/login', { email: 'conv@alfacontabil.net', senha: senhaProvisoria });
    const ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    await post('/api/trocar-senha', { senhaAtual: senhaProvisoria, senhaNova: 'sexta frase aqui 12' }, ck);
    const l2 = await post('/api/login', { email: 'conv@alfacontabil.net', senha: 'sexta frase aqui 12' });
    const ck2 = (l2.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    // Para Admin: recusado. Para Operador: pode.
    expect((await post('/api/convites', { papelId: papelAdmin }, ck2)).status).toBe(403);
    expect((await post('/api/convites', { papelId: operador.id }, ck2)).status).toBe(201);
  });

  it('a origem de cada conta fica registrada', async () => {
    const { codigo } = await criarConvite();
    await cadastrar('origem@alfacontabil.net', codigo);
    const u = await db
      .prepare("SELECT convite_id FROM usuarios WHERE email = 'origem@alfacontabil.net'")
      .first<{ convite_id: string | null }>();
    // Sem isso, daqui a seis meses ninguém sabe dizer por que fulano é Admin.
    expect(u!.convite_id).toBeTruthy();
  });
});
