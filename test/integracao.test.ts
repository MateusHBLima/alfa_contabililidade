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
import { TODAS_PERMISSOES, PAPEIS_SEMENTE, type Sessao } from '../src/auth/permissoes';
import { gerarHashSenha, conferirSenha } from '../src/auth/senha';

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

  await db.prepare('INSERT INTO tenants (id, nome, criado_em) VALUES (?,?,?)')
    .bind('alfa', 'ALFA CONTABILIDADE', new Date().toISOString()).run();

  for (const p of TODAS_PERMISSOES) {
    await db.prepare('INSERT INTO permissoes (chave, grupo, descricao) VALUES (?,?,?)')
      .bind(p, 'g', p).run();
  }

  const admin = PAPEIS_SEMENTE.find((p) => p.nome === 'Admin')!;
  await db.prepare('INSERT INTO papeis (id, tenant_id, nome, sistema) VALUES (?,?,?,1)')
    .bind('papel-admin', 'alfa', admin.nome).run();
  for (const perm of admin.permissoes) {
    await db.prepare('INSERT INTO papel_permissoes (papel_id, permissao) VALUES (?,?)')
      .bind('papel-admin', perm).run();
  }

  await db.prepare(
    'INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, criado_em) VALUES (?,?,?,?,?,?)',
  ).bind('u1', 'alfa', 'contadora@alfacontabil.net', 'Contadora',
    await gerarHashSenha('uma frase de senha longa'), new Date().toISOString()).run();

  await db.prepare('INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES (?,?)')
    .bind('u1', 'papel-admin').run();

  sessao = {
    usuarioId: 'u1', tenantId: 'alfa', email: 'contadora@alfacontabil.net', nome: 'Contadora',
    permissoes: new Set(TODAS_PERMISSOES), empresas: null,
  };

  repo = new Repo(db as any, { sessao, ip: '1.2.3.4', requestId: 'req-1' }, SEED);
}

beforeEach(semear);

describe('as migrações aplicam num SQLite real', () => {
  it('cria as 17 tabelas', () => {
    const tabelas = db.consultar<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(tabelas.length).toBe(17);
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
