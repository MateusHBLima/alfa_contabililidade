import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { D1Local, R2Local } from './d1-local';
import { Repo } from '../src/db/repo';
import { Auditoria } from '../src/db/auditoria';
import { importarArquivos } from '../src/nfe/importador';
import { gerarXmlCorrigido, verificarInvariantes } from '../src/nfe/serializer';
import { parseNFe, lerEventoNFe } from '../src/nfe/parser';
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
const EVENTO = readFileSync(new URL('./fixtures/evento-cancelamento-sintetico.xml', import.meta.url), 'utf8');
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

/** Lê um zip "store": devolve nome -> conteúdo. Leitor independente do escritor. */
const lerZip = (b: Uint8Array) => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Map<string, string>();
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    const tam = dv.getUint32(p + 18, true);
    const nomeLen = dv.getUint16(p + 26, true);
    const extra = dv.getUint16(p + 28, true);
    const nome = new TextDecoder().decode(b.slice(p + 30, p + 30 + nomeLen));
    const ini = p + 30 + nomeLen + extra;
    out.set(nome, new TextDecoder().decode(b.slice(ini, ini + tam)));
    p = ini + tam;
  }
  return out;
};

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

  /**
   * A primeira nota real do cliente tinha 20 itens e derrubou a importação em
   * produção com "D1_ERROR: too many SQL variables". A nota de teste tinha 3,
   * e o SQLite local aceitava quase mil parâmetros — a suíte ficou verde
   * enquanto o cliente via erro na tela.
   *
   * Este teste monta uma nota grande de propósito. Com o dublê agora recusando
   * mais de 100 parâmetros por consulta, ele falha se alguém voltar a montar
   * uma consulta proporcional ao número de itens.
   */
  it('nota grande importa inteira — a consulta de regras não cresce sem limite', async () => {
    const itens = Array.from({ length: 40 }, (_, i) => {
      const n = i + 1;
      return `<det nItem="${n}">
        <prod><cProd>P${n}</cProd><cEAN>789100010${String(n).padStart(4, '0')}</cEAN>
          <xProd>PRODUTO ${n}</xProd><NCM>1806${String(n % 90).padStart(2, '0')}</NCM>
          <CFOP>5102</CFOP><uCom>UN</uCom><qCom>1.0000</qCom>
          <vUnCom>10.00</vUnCom><vProd>10.00</vProd></prod>
        <imposto><ICMS><ICMS00><CST>00</CST></ICMS00></ICMS></imposto>
      </det>`;
    }).join('\n');

    const grande = XML
      .replace(/<det nItem="1">[\s\S]*<\/det>/, itens)
      .replace(CHAVE_ORIGINAL, CHAVE_ORIGINAL.slice(0, 42) + '99')
      .replace('<nNF>504767</nNF>', '<nNF>504768</nNF>');

    const r = await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'grande.xml', conteudo: grande },
    ]);

    expect(r.arquivos[0]!.status).toBe('importada');
    expect(r.importadas).toBe(1);
    expect(r.arquivos[0]!.itens).toBe(40);
    expect(db.consultar('SELECT * FROM itens')).toHaveLength(40);
  });

  /**
   * Quando a importação falha no meio, não pode sobrar nota sem item na tela —
   * foi exatamente o que o cliente viu: "0 importadas, 1 recusada" e a nota
   * listada com 0 itens.
   */
  it('importação que falha não deixa nota órfã', async () => {
    const quebrado = { ...(r2 as any), put: async () => { throw new Error('R2 fora do ar'); } };

    const r = await importarArquivos(repo, quebrado as any, empresaId, [
      { nome: 'n.xml', conteudo: XML },
    ]);

    expect(r.importadas).toBe(0);
    expect(r.recusadas).toBe(1);
    expect(db.consultar('SELECT * FROM notas')).toHaveLength(0);
  });

  it('nota órfã de uma falha anterior não bloqueia o reenvio do arquivo', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);

    // Reproduz o estado que o cliente viu em produção: a nota ficou na tela,
    // sem item nenhum, porque a gravação dos itens falhou.
    db.consultar('DELETE FROM itens');
    expect(db.consultar('SELECT * FROM notas')).toHaveLength(1);

    const r = await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);

    expect(r.arquivos[0]!.status).toBe('importada');
    expect(db.consultar('SELECT * FROM notas')).toHaveLength(1);
    expect(db.consultar('SELECT * FROM itens')).toHaveLength(3);
  });

  it('nota completa continua sendo recusada como duplicada', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    const r = await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    expect(r.arquivos[0]!.status).toBe('duplicada');
    expect(db.consultar('SELECT * FROM itens')).toHaveLength(3);
  });

  /* Retorno de 16-17/09, primeiro lote real (78 arquivos, importacao quinzenal).
     O medo dela: importar dia 1-15, tratar, e depois importar 1-30 "e desfazer
     tudo que eu tinha feito". O servidor nunca desfez - mas tambem nunca DISSE. */
  it('reimportar nota já tratada não toca em nada — e diz quantos itens ela já tinha conferido', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    db.consultar("UPDATE itens SET revisado = 1, cfop_novo = '1556' WHERE n_item IN (1, 2)");
    const antes = JSON.stringify(db.consultar('SELECT * FROM itens ORDER BY n_item'));

    const r = await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);

    expect(r.arquivos[0]!.status).toBe('duplicada');
    expect(r.arquivos[0]!.itensConferidos).toBe(2);
    expect(r.arquivos[0]!.motivo).toMatch(/2 de 3 itens conferidos/);
    expect(r.arquivos[0]!.motivo).toMatch(/nada foi alterado/);
    expect(r.duplicadasTratadas).toBe(1);
    expect(JSON.stringify(db.consultar('SELECT * FROM itens ORDER BY n_item'))).toBe(antes);
  });

  it('o mesmo arquivo enviado duas vezes AO MESMO TEMPO: uma nota, nenhum item perdido, nenhum erro de banco na tela', async () => {
    const rs = await Promise.all([
      importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]),
      importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]),
    ]);
    const status = rs.map((r) => r.arquivos[0]!.status).sort();
    expect(status).toEqual(['duplicada', 'importada']);
    expect(db.consultar('SELECT * FROM notas')).toHaveLength(1);
    expect(db.consultar('SELECT * FROM itens')).toHaveLength(3);
    for (const r of rs) expect(r.arquivos[0]!.motivo ?? '').not.toMatch(/UNIQUE|constraint/i);
  });

  /* "ali ele fala que importou 77 notas. Ok. Mas na verdade eu tinha 78 XMLs
     porque um deles era um evento." O evento saia como recusada, com mensagem de
     parser. Era um CANCELAMENTO. */
  it('XML de evento não é recusa anônima: diz que é cancelamento, de qual nota, e o que fazer', async () => {
    const r = await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'NFe_Evento.xml', conteudo: EVENTO }]);
    const a = r.arquivos[0]!;
    expect(a.status).toBe('evento');
    expect(r.eventos).toBe(1);
    expect(r.recusadas).toBe(0);
    expect(a.motivo).toMatch(/CANCELAMENTO da NF 123 \(série 1\) em 20\/07\/2026/);
    expect(a.motivo).toMatch(/faturamento incorreto/);
    expect(a.motivo).toMatch(/não está no sistema/);
    expect(a.motivo).toMatch(/Marcar como cancelada/);   // desde 23/09: se ela vier depois
    expect(a.evento).toMatchObject({ tipo: '110111', cancela: true, notaNoSistema: false });
    // Evento nao vira nota nem item.
    expect(db.consultar('SELECT * FROM notas')).toHaveLength(0);
  });

  it('evento de nota que JÁ está no sistema: marca a nota como cancelada, sem mexer nos itens (23/09)', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    db.consultar('UPDATE itens SET revisado = 1');
    const doEvento = EVENTO.replaceAll('42260711222333000181550010000001231000000019', CHAVE_ORIGINAL);

    const r = await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'ev.xml', conteudo: doEvento }]);

    expect(r.arquivos[0]!.motivo).toMatch(/ESTÁ no sistema/);
    expect(r.arquivos[0]!.motivo).toMatch(/3 item\(ns\) já conferido/);
    expect(r.arquivos[0]!.notaId).toBeTruthy();
    expect(r.arquivos[0]!.motivo).toMatch(/Marcada como CANCELADA/);
    expect(db.consultar('SELECT * FROM itens WHERE revisado = 1')).toHaveLength(3);
    const n = db.consultar('SELECT cancelada_em, cancelada_motivo FROM notas')[0] as any;
    expect(n.cancelada_em).toBeTruthy();
    expect(n.cancelada_motivo).toMatch(/faturamento incorreto/);
    // Reimportar o mesmo evento não repete nada.
    const trilha = (db.consultar(`SELECT COUNT(*) AS q FROM auditoria WHERE campo = 'cancelada'`)[0] as any).q;
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'ev.xml', conteudo: doEvento }]);
    expect((db.consultar(`SELECT COUNT(*) AS q FROM auditoria WHERE campo = 'cancelada'`)[0] as any).q).toBe(trilha);
  });

  it('os dois nProt do evento não se confundem: o da nota e o do evento', () => {
    const ev = lerEventoNFe(EVENTO)!;
    expect(ev.protocoloNota).toBe('142260000000001');
    expect(ev.protocoloEvento).toBe('142260000000002');
    expect(lerEventoNFe(XML)).toBeNull();
  });

  /* O primeiro uso real: a contadora abriu as notas, conferiu item a item,
     concordou com o que o motor tinha preenchido — e o sistema entendeu que ela
     não tinha feito nada, porque nenhum valor mudou. "0 de 38 revisados", todas
     as notas de volta como "a revisar", trabalho descartado em silêncio.

     Concordar com a sugestão é a ação MAIS COMUM, porque o motor existe para
     acertar sozinho. Era o caminho mais frequente que não gravava nada. */
  it('confirmar a sugestão sem mudar valor conta como trabalho', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);

    const item = db.consultar('SELECT * FROM itens LIMIT 1')[0];
    expect(item.revisado).toBe(0);

    // Reenvia EXATAMENTE o que já estava lá — é o que a tela manda quando a
    // pessoa olha, concorda e segue.
    await repo.alterarItem(item.id, [
      { campo: 'cfop', valor: item.cfop_novo, origem: 'manual' },
    ]);

    const depois = db.consultar('SELECT * FROM itens WHERE id = ?', [item.id])[0];
    expect(depois.revisado).toBe(1);
    expect(depois.revisado_em).toBeTruthy();
    // O valor não mudou, então não há evento de alteração — mas há de conferência.
    expect(depois.cfop_novo).toBe(item.cfop_novo);
    const trilha = db.consultar("SELECT * FROM auditoria WHERE campo = 'conferido'");
    expect(trilha.length).toBeGreaterThan(0);
  });

  it('conferir a nota inteira marca todos os itens e some do "a tratar"', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    const notaId = db.consultar('SELECT id FROM notas')[0].id;
    const ids = db.consultar('SELECT id FROM itens').map((i: any) => i.id);

    const marcados = await repo.conferirItens(notaId, ids);
    expect(marcados).toBe(3);

    const [nota] = await repo.listarNotas(empresaId);
    expect(nota.itens_revisados).toBe(nota.total_itens);

    // Conferir de novo não conta duas vezes.
    expect(await repo.conferirItens(notaId, ids)).toBe(0);
  });

  it('desconferir devolve o item para pendente', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    const notaId = db.consultar('SELECT id FROM notas')[0].id;
    const item = db.consultar('SELECT * FROM itens LIMIT 1')[0];

    await repo.conferirItens(notaId, [item.id]);
    expect(db.consultar('SELECT * FROM itens WHERE id = ?', [item.id])[0].revisado).toBe(1);

    await repo.desconferirItem(item.id);
    const depois = db.consultar('SELECT * FROM itens WHERE id = ?', [item.id])[0];
    expect(depois.revisado).toBe(0);
    expect(depois.revisado_por).toBeNull();
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

  /* Apagar nota e apagar empresa nasceram de um aperto real: os dados do
     primeiro teste com nota de verdade ficaram presos em produção, sem tela
     nenhuma para tirá-los. Quem deixa importar precisa deixar desfazer. */

  // Sem o helper `req`: FormData precisa definir o proprio content-type com o
  // boundary, e o helper forca application/json.
  const subirNota = async (empresaId: string, xml = XML, ck = cookieAdmin) => {
    const fd = new FormData();
    fd.append('arquivos', new File([xml], 'n.xml', { type: 'text/xml' }));
    return app.fetch(
      new Request(`http://x/api/empresas/${empresaId}/importar`, {
        method: 'POST', body: fd, headers: { Cookie: ck },
      }),
      ambiente(),
    );
  };

  const criarEmpresa = async () => {
    const r = await req('/api/empresas', {
      method: 'POST',
      body: JSON.stringify({
        cnpj: '11222333000181', razaoSocial: 'CLIENTE TESTE', uf: 'SC', perfil: 'revenda',
      }),
    });
    return (await r.json() as { id: string }).id;
  };

  it('apagar nota leva itens e XML junto, mas preserva as regras aprendidas', async () => {
    const empresaId = await criarEmpresa();
    await subirNota(empresaId);
    const notaId = db.consultar('SELECT id FROM notas')[0].id;

    // Aprende alguma coisa antes, para provar que a regra sobrevive.
    const itemId = db.consultar('SELECT id FROM itens LIMIT 1')[0].id;
    await req(`/api/itens/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1556' }], fixar: true }),
    });
    const regrasAntes = db.consultar('SELECT * FROM regras').length;
    expect(regrasAntes).toBeGreaterThan(0);

    const r = await req(`/api/notas/${notaId}`, { method: 'DELETE' });
    expect(r.status).toBe(200);

    expect(db.consultar('SELECT * FROM notas')).toHaveLength(0);
    expect(db.consultar('SELECT * FROM itens')).toHaveLength(0);
    // A regra é conhecimento do escritório sobre o fornecedor, não da nota.
    expect(db.consultar('SELECT * FROM regras')).toHaveLength(regrasAntes);
    expect(
      db.consultar("SELECT * FROM auditoria WHERE acao = 'excluir' AND entidade = 'nota'"),
    ).toHaveLength(1);
  });

  it('quem não tem notas.apagar não apaga nota', async () => {
    const empresaId = await criarEmpresa();
    await subirNota(empresaId);
    const notaId = db.consultar('SELECT id FROM notas')[0].id;

    const papel = await req('/api/papeis', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Só trata',
        permissoes: ['notas.visualizar', 'notas.importar', 'empresas.visualizar'],
      }),
    });
    const { id: papelId } = await papel.json() as { id: string };
    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'op@alfacontabil.net', nome: 'Op', papelId }),
    });
    const { senhaProvisoria } = await novo.json() as { senhaProvisoria: string };
    const login = await entrar('op@alfacontabil.net', senhaProvisoria);
    const ck = (login.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    const r = await req(`/api/notas/${notaId}`, { method: 'DELETE' }, ck);
    expect(r.status).toBe(403);
    expect(db.consultar('SELECT * FROM notas')).toHaveLength(1);
  });

  it('apagar empresa exige o CNPJ digitado — e então leva tudo dela', async () => {
    const empresaId = await criarEmpresa();
    await subirNota(empresaId);

    const semConfirmar = await req(`/api/empresas/${empresaId}`, { method: 'DELETE' });
    expect(semConfirmar.status).toBe(400);
    expect(await semConfirmar.json()).toMatchObject({ cnpjEsperado: '11222333000181' });
    expect(db.consultar('SELECT * FROM empresas')).toHaveLength(1);

    const errado = await req(`/api/empresas/${empresaId}?confirmar=99999999999999`, { method: 'DELETE' });
    expect(errado.status).toBe(400);

    const certo = await req(`/api/empresas/${empresaId}?confirmar=11.222.333/0001-81`, { method: 'DELETE' });
    expect(certo.status).toBe(200);

    expect(db.consultar('SELECT * FROM empresas')).toHaveLength(0);
    expect(db.consultar('SELECT * FROM notas')).toHaveLength(0);
    expect(db.consultar('SELECT * FROM itens')).toHaveLength(0);
    expect(db.consultar('SELECT * FROM regras')).toHaveLength(0);
    expect(db.consultar('SELECT * FROM fornecedores')).toHaveLength(0);
    expect(
      db.consultar("SELECT * FROM auditoria WHERE acao = 'excluir' AND entidade = 'empresa'"),
    ).toHaveLength(1);
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

  /* A contadora, depois do primeiro uso real: "se tivesse um jeito de ele ir
     aparecendo de outra cor o que eu já fiz". O que ela quis dizer é isto —
     a nota seguinte tem que mostrar o que veio DELA, separado do que o sistema
     chutou. Sem este teste, "aprendido" e "chute do perfil" continuam saindo do
     endpoint com a mesma cara, e nenhum teste de função isolada pega, porque o
     que erra é a composição: a origem mora no item, a ficha da regra mora em
     outra tabela, e a decisão de estilo mora num terceiro arquivo. */
  it('na segunda nota, a tela sabe o que veio da contadora e o que é chute do perfil', async () => {
    const empresaId = await criarEmpresa();
    await subirNota(empresaId);

    // Ela corrige o item 1 e ensina o sistema.
    const primeira = db.consultar('SELECT id FROM notas ORDER BY criado_em')[0].id;
    const itens1 = await (await req(`/api/notas/${primeira}`)).json() as any;
    const item1 = itens1.itens[0];

    // Ensina os DOIS campos que decidem a confiança do item. Ensinar só o CFOP
    // deixa a linha amarela para sempre, porque a confiança exige CFOP e
    // descrição — coisa que só aparece rodando o caminho inteiro.
    const ENSINADOS = [
      { campo: 'cfop', valor: '1403' },
      { campo: 'descricao', valor: 'CHOCOLATE AO LEITE POTE 200G' },
    ];
    const patch = await req(`/api/itens/${item1.id}`, {
      method: 'PATCH', body: JSON.stringify({ mudancas: ENSINADOS }),
    });
    expect(patch.status).toBe(200);

    // Competência seguinte: mesma mercadoria, nota nova.
    await subirNota(empresaId, outraNota(XML, '55'));
    const segundaId = db.consultar(
      'SELECT id FROM notas WHERE chave = ?', parseNFe(outraNota(XML, '55')).chave,
    )[0].id;

    const corpo = await (await req(`/api/notas/${segundaId}`)).json() as any;
    const [a, b] = corpo.itens;

    // O item que ela ensinou volta MARCADO como vindo dela — e mesmo assim ainda
    // pede conferência, porque regra vista uma vez só nasce amarela (invariante 5:
    // "ver uma vez não é saber"). São dois eixos diferentes, e é justamente por
    // isso que a procedência não pode viver só dentro do estado da linha: senão
    // tudo que ela ensinou some da tela até a terceira nota.
    expect(a.procedencia.fonte).toBe('aprendida');
    expect(a.estilo.estado).toBe('conferir');

    // O que ninguém ensinou continua sendo chute do perfil — e continua pedindo
    // conferência. Este é o bug que já apareceu uma vez: item desconhecido
    // chegando como "Pronto" é o rótulo que faz pular justo a linha certa.
    expect(b.procedencia.fonte).toBe('perfil');
    expect(b.estilo.estado).toBe('conferir');
    expect(b.estilo.destacar).toBe(true);

    // E o topo da nota conta a história em número.
    expect(corpo.resumo.ensinados).toBe(1);
    expect(corpo.resumo.aprendizado).toContain('vocês já ensinaram');

    // --- ela confere, e a regra vai ganhando lastro -----------------------
    // Regra com um acerto só ainda não é verde: a confiança sobe para 0,67 e o
    // corte é 0,70. Isso é a invariante 5 funcionando ("ver uma vez não é saber"),
    // e tem consequência de produto: o verde chega na QUARTA nota, não na segunda.
    // Enquanto isso a procedência é a única coisa que mostra que ela ensinou —
    // por isso ela não pode viver só dentro do estado da linha.
    let ultimo = a;
    for (const serie of ['57', '58']) {
      const ok = await req(`/api/itens/${ultimo.id}`, {
        method: 'PATCH', body: JSON.stringify({ mudancas: ENSINADOS }),
      });
      expect(ok.status).toBe(200);

      const xml = outraNota(XML, serie);
      await subirNota(empresaId, xml);
      const id = db.consultar('SELECT id FROM notas WHERE chave = ?', parseNFe(xml).chave)[0].id;
      const c = await (await req(`/api/notas/${id}`)).json() as any;
      ultimo = c.itens[0];
      expect(ultimo.procedencia.fonte).toBe('aprendida');
    }

    // Quarta nota: a regra provou histórico e a linha finalmente descansa.
    expect(ultimo.estilo.estado).toBe('aprendido');
    expect(ultimo.estilo.destacar).toBe(false);
    expect(ultimo.estilo.rotulo).toContain('Aprendido');
  });

  /* "Tem empresas aqui, por exemplo, que são 200 notas e que a gente também não
     vai fazer tudo no mesmo dia" — a contadora, no primeiro uso real. Achar a
     nota certa daqui a um ano é o problema que ano e mês resolvem. */
  it('filtra por mês e por ano, e o ano pega os doze meses', async () => {
    const empresaId = await criarEmpresa();

    // Três notas: duas em agosto de 2026, uma em setembro.
    const meses: [string, string][] = [
      ['71', '2026-08-10T09:00:00-03:00'],
      ['72', '2026-08-22T09:00:00-03:00'],
      ['73', '2026-09-03T09:00:00-03:00'],
    ];
    for (const [serie, data] of meses) {
      const xml = outraNota(XML, serie)
        .replace('<dhEmi>2026-08-14T09:31:00-03:00</dhEmi>', `<dhEmi>${data}</dhEmi>`);
      expect((await subirNota(empresaId, xml)).status).toBe(200);
    }

    const buscar = async (q: string) =>
      (await (await req(`/api/empresas/${empresaId}/notas${q}`)).json()) as any[];

    expect(await buscar('')).toHaveLength(3);
    expect(await buscar('?competencia=2026-08')).toHaveLength(2);
    expect(await buscar('?competencia=2026-09')).toHaveLength(1);
    // O ano inteiro, sem escolher mês.
    expect(await buscar('?competencia=2026')).toHaveLength(3);
    expect(await buscar('?competencia=2025')).toHaveLength(0);
  });

  /* O seletor de mês se destruía sozinho: as opções saíam das notas JÁ
     filtradas, então escolher setembro apagava agosto da lista. Quem não
     descobrisse que precisava voltar em "todas" concluiria que as notas de
     agosto tinham sumido do sistema. As opções vêm do universo inteiro. */
  it('a lista de competências não depende do filtro em vigor', async () => {
    const empresaId = await criarEmpresa();
    for (const [serie, data] of [
      ['81', '2026-08-10T09:00:00-03:00'],
      ['82', '2026-09-03T09:00:00-03:00'],
    ] as [string, string][]) {
      await subirNota(
        empresaId,
        outraNota(XML, serie).replace('<dhEmi>2026-08-14T09:31:00-03:00</dhEmi>', `<dhEmi>${data}</dhEmi>`),
      );
    }

    const comps = await (await req(`/api/empresas/${empresaId}/competencias`)).json() as any[];
    expect(comps.map((c) => c.competencia)).toEqual(['2026-09', '2026-08']);
    expect(comps.every((c) => c.notas === 1)).toBe(true);

    // E continua o mesmo com um mês selecionado — é esse o ponto.
    const filtrado = await (await req(`/api/empresas/${empresaId}/notas?competencia=2026-09`)).json() as any[];
    expect(filtrado).toHaveLength(1);
    const depois = await (await req(`/api/empresas/${empresaId}/competencias`)).json() as any[];
    expect(depois.map((c) => c.competencia)).toEqual(['2026-09', '2026-08']);
  });

  it('competências exige permissão de ver nota', async () => {
    const empresaId = await criarEmpresa();
    const semNada = await app.fetch(
      new Request(`http://x/api/empresas/${empresaId}/competencias`),
      ambiente(),
    );
    expect(semNada.status).toBe(401);
  });

  it('o padrão que ela mandou fixar chega como "Padrão seu", não como "Aprendido"', async () => {
    const empresaId = await criarEmpresa();
    await subirNota(empresaId);

    const primeira = db.consultar('SELECT id FROM notas ORDER BY criado_em')[0].id;
    const corpo1 = await (await req(`/api/notas/${primeira}`)).json() as any;

    const patch = await req(`/api/itens/${corpo1.itens[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1403' }], fixar: true }),
    });
    expect(patch.status).toBe(200);

    await subirNota(empresaId, outraNota(XML, '56'));
    const segundaId = db.consultar(
      'SELECT id FROM notas WHERE chave = ?', parseNFe(outraNota(XML, '56')).chave,
    )[0].id;

    const corpo = await (await req(`/api/notas/${segundaId}`)).json() as any;
    const item = corpo.itens[0];

    // Fixar é decisão, não palpite: a regra nasce verde na hora, sem esperar
    // histórico. A procedência do item diz isso já na nota seguinte.
    expect(item.procedencia.fonte).toBe('fixada');
    expect(item.cfop_novo).toBe('1403');

    // E a LINHA fica pronta. Antes não ficava: a confiança exigia CFOP *e*
    // descrição, então a contadora dava a ordem mais forte que o sistema aceita
    // e a linha continuava dizendo "Conferir" para sempre. Quem decide se a
    // linha está pronta é o CFOP, que é a decisão fiscal.
    expect(item.estilo.estado).toBe('padrao');
    expect(item.estilo.rotulo).toBe('Padrão seu');
    expect(item.estilo.destacar).toBe(false);

    // A descrição pendente não some da tela — mas vive no topo da nota, não em
    // cada linha: nas notas reais da ALFA eram 38 de 38, e aviso em 100% das
    // linhas não informa, só ensina a pessoa a ignorar aviso.
    expect(item.descricaoDoFornecedor).toBe(true);
    expect(corpo.resumo.semDescricaoPadrao).toBeGreaterThan(0);
    // e a descrição pendente não tira ESTE item da conta de prontos — os outros
    // dois continuam pedindo atenção porque ninguém ensinou o CFOP deles.
    expect(corpo.resumo.tranquilos).toBe(1);
  });

  it('descrição ensinada tira o aviso, e a linha continua pronta', async () => {
    const empresaId = await criarEmpresa();
    await subirNota(empresaId);
    const primeira = db.consultar('SELECT id FROM notas ORDER BY criado_em')[0].id;
    const c1 = await (await req(`/api/notas/${primeira}`)).json() as any;

    await req(`/api/itens/${c1.itens[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        mudancas: [
          { campo: 'cfop', valor: '1403' },
          { campo: 'descricao', valor: 'CHOCOLATE AO LEITE POTE 200G' },
        ],
        fixar: true,
      }),
    });

    await subirNota(empresaId, outraNota(XML, '59'));
    const id = db.consultar('SELECT id FROM notas WHERE chave = ?', parseNFe(outraNota(XML, '59')).chave)[0].id;
    const corpo = await (await req(`/api/notas/${id}`)).json() as any;

    expect(corpo.itens[0].x_prod_novo).toBe('CHOCOLATE AO LEITE POTE 200G');
    expect(corpo.itens[0].descricaoDoFornecedor).toBe(false);
    expect(corpo.itens[0].estilo.destacar).toBe(false);
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

describe('"é sempre assim": a contadora fixa um produto, não o mundo', () => {
  /* Pedido do Mateus: "preciso de um botão que salve o padrão que ela colocar".
     O sistema já aprendia de toda correção — só que a regra nasce amarela de
     propósito (ver uma vez não é saber) e leva umas quatro notas para ficar
     verde. Faltava ela poder dizer "tenho certeza" e pular essa fila. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  const SENHA = 'uma frase de senha longa';
  let ck = '';
  const req = (c: string, o: RequestInit = {}) =>
    app.fetch(new Request(`http://x${c}`, {
      ...o, headers: { 'content-type': 'application/json', Cookie: ck, ...(o.headers ?? {}) },
    }), ambiente());

  const subir = async (empresaId: string, xml = XML) => {
    const fd = new FormData();
    fd.append('arquivos', new File([xml], 'n.xml', { type: 'text/xml' }));
    return app.fetch(new Request(`http://x/api/empresas/${empresaId}/importar`, {
      method: 'POST', body: fd, headers: { Cookie: ck },
    }), ambiente());
  };

  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: SENHA }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  });

  const criar = async () => {
    const r = await req('/api/empresas', {
      method: 'POST',
      body: JSON.stringify({ cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda' }),
    });
    return (await r.json() as any).id;
  };

  it('fixa o produto e a próxima nota já chega verde — sem esperar quatro notas', async () => {
    const empresaId = await criar();
    await subir(empresaId);
    const nota1 = db.consultar('SELECT id FROM notas ORDER BY criado_em')[0].id;
    const c1 = await (await req(`/api/notas/${nota1}`)).json() as any;

    const r = await req(`/api/itens/${c1.itens[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1403' }], fixar: true }),
    });
    expect(r.status).toBe(200);

    await subir(empresaId, outraNota(XML, '91'));
    const id2 = db.consultar('SELECT id FROM notas WHERE chave = ?', parseNFe(outraNota(XML, '91')).chave)[0].id;
    const c2 = await (await req(`/api/notas/${id2}`)).json() as any;

    expect(c2.itens[0].cfop_novo).toBe('1403');
    expect(c2.itens[0].procedencia.fonte).toBe('fixada');
    expect(c2.itens[0].estilo.estado).toBe('padrao');
  });

  it('e NÃO fixa nada no nível do NCM — regra genérica não vira verde por um botão', async () => {
    // NCM é classificação tributária, não produto: dezenas de mercadorias
    // diferentes dividem o mesmo. Fixar um chocolate não pode carimbar tudo
    // que compartilha o NCM, de qualquer fornecedor. É a invariante 5.
    const empresaId = await criar();
    await subir(empresaId);
    const nota1 = db.consultar('SELECT id FROM notas ORDER BY criado_em')[0].id;
    const c1 = await (await req(`/api/notas/${nota1}`)).json() as any;

    await req(`/api/itens/${c1.itens[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1403' }], fixar: true }),
    });

    const regras = db.consultar('SELECT nivel, fixada FROM regras WHERE campo = ?', 'cfop');
    const niveis = [...new Set(regras.map((x: any) => x.nivel))].sort();
    expect(niveis).toEqual([1, 2]);           // fornecedor+produto e fornecedor+EAN
    expect(niveis).not.toContain(6);          // NCM, qualquer fornecedor
    expect(niveis).not.toContain(5);          // padrão do fornecedor inteiro
    expect(regras.every((x: any) => x.fixada === 1)).toBe(true);
  });

  it('corrigir sem fixar continua aprendendo largo, e amarelo', async () => {
    // A trava vale só para o botão. A correção normal segue como era: aprende
    // em todos os níveis implícitos, e nasce amarela.
    const empresaId = await criar();
    await subir(empresaId);
    const nota1 = db.consultar('SELECT id FROM notas ORDER BY criado_em')[0].id;
    const c1 = await (await req(`/api/notas/${nota1}`)).json() as any;

    await req(`/api/itens/${c1.itens[0].id}`, {
      method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1403' }] }),
    });

    const regras = db.consultar('SELECT nivel, fixada FROM regras WHERE campo = ?', 'cfop');
    expect([...new Set(regras.map((x: any) => x.nivel))].length).toBeGreaterThan(2);
    expect(regras.every((x: any) => x.fixada === 0)).toBe(true);
  });

  it('fixar exige a permissão própria', async () => {
    const empresaId = await criar();
    await subir(empresaId);
    const nota1 = db.consultar('SELECT id FROM notas ORDER BY criado_em')[0].id;
    const c1 = await (await req(`/api/notas/${nota1}`)).json() as any;

    const papel = await req('/api/papeis', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Sem fixar',
        // `empresas.todas` porque sem recorte de empresa o repositório recusa
        // antes de chegar na permissão que este teste quer exercitar.
        permissoes: ['notas.visualizar', 'notas.editar_cfop', 'empresas.visualizar', 'empresas.todas'],
      }),
    });
    const { id: papelId } = await papel.json() as any;
    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ nome: 'Aux', email: 'aux@alfacontabil.net', papelId }),
    });
    const { senhaProvisoria } = await novo.json() as any;

    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'aux@alfacontabil.net', senha: senhaProvisoria }),
    }), ambiente());
    const ck2 = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    await app.fetch(new Request('http://x/api/trocar-senha', {
      method: 'POST', headers: { 'content-type': 'application/json', Cookie: ck2 },
      body: JSON.stringify({ senhaAtual: senhaProvisoria, senhaNova: 'outra frase longa 7' }),
    }), ambiente());
    const l2 = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'aux@alfacontabil.net', senha: 'outra frase longa 7' }),
    }), ambiente());
    const ck3 = (l2.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    const r = await app.fetch(new Request(`http://x/api/itens/${c1.itens[0].id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', Cookie: ck3 },
      body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1403' }], fixar: true }),
    }), ambiente());
    expect(r.status).toBe(403);
  });
});

describe('teste geral de 22/09: o "é sempre assim" aparece na hora, e conferir ensina', () => {
  /* Dois achados do teste geral. (1) Depois do "é sempre assim" a linha continuava
     "palpite do perfil" e o botão continuava lá — o padrão só aparecia na próxima
     nota. (2) "✓ Conferido" não ensinava: o palpite conferido voltava como palpite. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;
  let ck = '';
  const req = (c: string, o: RequestInit = {}) =>
    app.fetch(new Request(`http://x${c}`, {
      ...o, headers: { 'content-type': 'application/json', Cookie: ck, ...(o.headers ?? {}) },
    }), ambiente());
  const json = async (c: string, o: RequestInit = {}) => (await req(c, o)).json() as Promise<any>;
  const entrar = async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  };
  const subir = async (empresaId: string, xml: string) => {
    const fd = new FormData();
    fd.append('arquivos', new File([xml], 'n.xml', { type: 'text/xml' }));
    await app.fetch(new Request(`http://x/api/empresas/${empresaId}/importar`, {
      method: 'POST', body: fd, headers: { Cookie: ck },
    }), ambiente());
    return (db.consultar('SELECT id FROM notas WHERE chave = ?', parseNFe(xml).chave)[0] as any).id as string;
  };
  let empresaId = '';
  beforeEach(async () => {
    await entrar();
    empresaId = (await json('/api/empresas', {
      method: 'POST', body: JSON.stringify({ cnpj: '11222333000181', razaoSocial: 'PILOTO', uf: 'SC', perfil: 'revenda' }),
    })).id;
  });
  const regrasCfop = () => db.consultar(`SELECT * FROM regras WHERE campo = 'cfop' AND ativa = 1`) as any[];

  it('"é sempre assim" no valor que já estava: a linha já volta como PADRÃO FIXADO', async () => {
    const notaId = await subir(empresaId, XML);
    const antes = await json(`/api/notas/${notaId}`);
    const i0 = antes.itens[0];
    expect(i0.procedencia.fonte).toBe('perfil');
    await req(`/api/itens/${i0.id}`, { method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: i0.cfop_novo }], fixar: true }) });
    const depois = await json(`/api/notas/${notaId}`);
    expect(depois.itens[0].procedencia.fonte).toBe('fixada');
    expect(depois.itens[1].procedencia.fonte).toBe('perfil');   // só o que ela fixou
  });

  it('"é sempre assim" trocando o valor, e "salvar todos como padrão": todas as linhas marcadas na hora', async () => {
    const notaId = await subir(empresaId, XML);
    const n = await json(`/api/notas/${notaId}`);
    await req(`/api/itens/${n.itens[0].id}`, { method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1556' }], fixar: true }) });
    expect((await json(`/api/notas/${notaId}`)).itens[0].procedencia.fonte).toBe('fixada');
    const r = await req(`/api/notas/${notaId}/fixar-padrao`, { method: 'POST', body: JSON.stringify({ itens: n.itens.map((i: any) => i.id) }) });
    expect(r.status).toBe(200);
    expect((await json(`/api/notas/${notaId}`)).itens.map((i: any) => i.procedencia.fonte)).toEqual(['fixada', 'fixada', 'fixada']);
  });

  it('padrão fixado para OUTRO CFOP de saída não marca a linha (o pudim em 5949 não fala pelo 5102)', async () => {
    const notaId = await subir(empresaId, XML);
    const i0 = (await json(`/api/notas/${notaId}`)).itens[0];
    db.consultar(`INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, criada_em, fixada, ativa)
                  VALUES ('f5949','alfa',?,1,?,'cfop',?,'2026-09-22',1,1)`, empresaId, `83646984003044|${String(i0.c_prod).toUpperCase()}#5949`, i0.cfop_novo);
    expect((await json(`/api/notas/${notaId}`)).itens[0].procedencia.fonte).toBe('perfil');
  });

  it('conferir ensina: a nota seguinte vem como "vocês ensinaram", com o mesmo CFOP', async () => {
    const n1 = await subir(empresaId, XML);
    const a = await json(`/api/notas/${n1}`);
    expect(a.itens.every((i: any) => i.procedencia.fonte === 'perfil')).toBe(true);
    expect(regrasCfop()).toHaveLength(0);
    const itensAntes = JSON.stringify(db.consultar('SELECT cfop_novo, x_prod_novo, cfop_origem FROM itens ORDER BY n_item'));

    expect((await req(`/api/notas/${n1}/conferir`, { method: 'POST', body: '{}' })).status).toBe(200);
    expect(JSON.stringify(db.consultar('SELECT cfop_novo, x_prod_novo, cfop_origem FROM itens ORDER BY n_item'))).toBe(itensAntes);
    expect(regrasCfop().length).toBeGreaterThan(0);
    expect(regrasCfop().every((r) => r.fixada === 0 && r.chave.includes('#'))).toBe(true);
    expect(db.consultar(`SELECT * FROM regras WHERE campo = 'descricao'`)).toHaveLength(0); // descrição conferida não ensina

    const n2 = await subir(empresaId, outraNota(XML, '81'));
    const b = await json(`/api/notas/${n2}`);
    expect(b.itens.map((i: any) => i.cfop_novo)).toEqual(a.itens.map((i: any) => i.cfop_novo));
    expect(b.itens.every((i: any) => i.procedencia.fonte === 'aprendida')).toBe(true);

    // Conferir a segunda: a regra que sugeriu ganha um acerto.
    const origem = String(b.itens[0].cfop_origem).slice('regra:'.length);
    const usos = (db.consultar('SELECT acertos FROM regras WHERE id = ?', origem)[0] as any).acertos;
    await req(`/api/notas/${n2}/conferir`, { method: 'POST', body: JSON.stringify({ itens: [b.itens[0].id] }) });
    expect((db.consultar('SELECT acertos FROM regras WHERE id = ?', origem)[0] as any).acertos).toBe(usos + 1);
    // Conferir de novo o que já está conferido não conta outra vez.
    await req(`/api/notas/${n2}/conferir`, { method: 'POST', body: JSON.stringify({ itens: [b.itens[0].id] }) });
    expect((db.consultar('SELECT acertos FROM regras WHERE id = ?', origem)[0] as any).acertos).toBe(usos + 1);
  });

  it('linha digitada já ensinou: conferir depois não ensina de novo', async () => {
    const n1 = await subir(empresaId, XML);
    const i0 = (await json(`/api/notas/${n1}`)).itens[0];
    await req(`/api/itens/${i0.id}`, { method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1556' }] }) });
    await req(`/api/itens/${i0.id}/desconferir`, { method: 'POST' });
    const antes = JSON.stringify(regrasCfop());
    await req(`/api/notas/${n1}/conferir`, { method: 'POST', body: JSON.stringify({ itens: [i0.id] }) });
    expect(JSON.stringify(regrasCfop())).toBe(antes);
  });

  it('conferir não passa por cima de padrão fixado', async () => {
    const n1 = await subir(empresaId, XML);
    const i0 = (await json(`/api/notas/${n1}`)).itens[0];
    const chave = `83646984003044|${String(i0.c_prod).toUpperCase()}#${i0.cfop_original}`;
    db.consultar(`INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, criada_em, fixada, ativa)
                  VALUES ('fx','alfa',?,1,?,'cfop','1949','2026-09-22',1,1)`, empresaId, chave);
    await req(`/api/notas/${n1}/conferir`, { method: 'POST', body: '{}' });
    expect((db.consultar(`SELECT valor, fixada FROM regras WHERE id = 'fx'`)[0] as any)).toMatchObject({ valor: '1949', fixada: 1 });
  });

  it('quem não pode editar CFOP confere, mas não ensina', async () => {
    db.consultar(`DELETE FROM papel_permissoes WHERE papel_id = 'papel-admin' AND permissao = 'notas.editar_cfop'`);
    await entrar();
    const n1 = await subir(empresaId, XML);
    const r = await json(`/api/notas/${n1}/conferir`, { method: 'POST', body: '{}' });
    expect(r.conferidos).toBe(3);
    expect(regrasCfop()).toHaveLength(0);
  });
});

describe('23/09: "Resolver" que não saía — conferir resolve, e o ajuste 5949 não vira alarme na compra', () => {
  /* Áudios da Taís, 23/09: maracujá da Italiana com "NCM mudou" — ela conferia e fixava
     e a linha seguia "Resolver"; detergente da OESA numa compra 5102 com "Preço +5950%"
     porque a nota anterior tinha sido um ajuste 5949 de valor simbólico. */
  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;
  let ck = '';
  const req = (c: string, o: RequestInit = {}) =>
    app.fetch(new Request(`http://x${c}`, {
      ...o, headers: { 'content-type': 'application/json', Cookie: ck, ...(o.headers ?? {}) },
    }), ambiente());
  const json = async (c: string, o: RequestInit = {}) => (await req(c, o)).json() as Promise<any>;
  const subir = async (empresaId: string, xml: string) => {
    const fd = new FormData();
    fd.append('arquivos', new File([xml], 'n.xml', { type: 'text/xml' }));
    await app.fetch(new Request(`http://x/api/empresas/${empresaId}/importar`, { method: 'POST', body: fd, headers: { Cookie: ck } }), ambiente());
    return (db.consultar('SELECT id FROM notas WHERE chave = ?', parseNFe(xml).chave)[0] as any).id as string;
  };
  const em = (data: string): [string, string] => ['<dhEmi>2026-08-14T09:31:00-03:00</dhEmi>', `<dhEmi>${data}T09:31:00-03:00</dhEmi>`];
  let empresaId = '';
  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    empresaId = (await json('/api/empresas', {
      method: 'POST', body: JSON.stringify({ cnpj: '11222333000181', razaoSocial: 'ITALIANA', uf: 'SC', perfil: 'revenda' }),
    })).id;
    await subir(empresaId, XML);   // a compra de julho, 5102, R$ 8,50
  });

  it('compra depois de um ajuste 5949 de valor simbólico: nenhum alarme de preço nem de CFOP', async () => {
    await subir(empresaId, outraNota(XML, '61', [
      em('2026-08-15'),
      ['<CFOP>5102</CFOP><uCom>UN</uCom><qCom>10.0000</qCom>\n          <vUnCom>8.5000</vUnCom><vProd>85.00</vProd>',
       '<CFOP>5949</CFOP><uCom>UN</uCom><qCom>10.0000</qCom>\n          <vUnCom>0.1400</vUnCom><vProd>1.40</vProd>'],
    ]));
    const compra = await subir(empresaId, outraNota(XML, '62', [em('2026-08-20')]));
    const i1 = (await json(`/api/notas/${compra}`)).itens.find((i: any) => i.n_item === 1);
    expect(i1.alertas.map((a: any) => a.titulo)).toEqual([]);
    expect(i1.estilo.estado).not.toBe('bloqueado');
  });

  it('NCM mudou: "Resolver" até ela conferir; conferido, sai da conta e o aviso fica como registro', async () => {
    const n = await subir(empresaId, outraNota(XML, '63', [em('2026-08-20'), ['<NCM>18069000</NCM>', '<NCM>17049090</NCM>']]));
    let d = await json(`/api/notas/${n}`);
    let i1 = d.itens.find((i: any) => i.n_item === 1);
    expect(i1.alertas.map((a: any) => a.codigo)).toContain('ncm_mudou');
    expect(i1.estilo.estado).toBe('bloqueado');
    expect(d.resumo.criticos).toBe(1);

    await req(`/api/notas/${n}/conferir`, { method: 'POST', body: '{}' });
    d = await json(`/api/notas/${n}`);
    i1 = d.itens.find((i: any) => i.n_item === 1);
    expect(i1.estilo.estado).toBe('conferido');
    expect(i1.alertas.map((a: any) => a.codigo)).toContain('ncm_mudou');   // continua escrito
    expect(d.resumo.criticos).toBe(0);
    expect(d.resumo.chamada).toContain('Tudo conferido');
  });

  it('primeira vez numa operação nova: um aviso amarelo, uma vez só', async () => {
    const n = await subir(empresaId, outraNota(XML, '64', [em('2026-08-20'), ['<NCM>18069000</NCM><CFOP>5102</CFOP>', '<NCM>18069000</NCM><CFOP>5405</CFOP>']]));
    const i1 = (await json(`/api/notas/${n}`)).itens.find((i: any) => i.n_item === 1);
    expect(i1.alertas.map((a: any) => a.titulo)).toEqual(['Primeira vez em 5405 (antes: 5102)']);
    expect(i1.estilo.estado).toBe('conferir');
    const m = await subir(empresaId, outraNota(XML, '65', [em('2026-08-25'), ['<NCM>18069000</NCM><CFOP>5102</CFOP>', '<NCM>18069000</NCM><CFOP>5405</CFOP>']]));
    const j1 = (await json(`/api/notas/${m}`)).itens.find((i: any) => i.n_item === 1);
    expect(j1.alertas).toEqual([]);
  });
});

describe('23/09: nota cancelada vale zero, e "aplicar na nota toda" numa requisição só', () => {
  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;
  let ck = '';
  const req = (c: string, o: RequestInit = {}) =>
    app.fetch(new Request(`http://x${c}`, {
      ...o, headers: { 'content-type': 'application/json', Cookie: ck, ...(o.headers ?? {}) },
    }), ambiente());
  const json = async (c: string, o: RequestInit = {}) => (await req(c, o)).json() as Promise<any>;
  const post = (c: string, corpo: unknown) => req(c, { method: 'POST', body: JSON.stringify(corpo) });
  const entrar = async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  };
  const subir = async (empresaId: string, xml: string) => {
    const fd = new FormData();
    fd.append('arquivos', new File([xml], 'n.xml', { type: 'text/xml' }));
    await app.fetch(new Request(`http://x/api/empresas/${empresaId}/importar`, { method: 'POST', body: fd, headers: { Cookie: ck } }), ambiente());
    return (db.consultar('SELECT id FROM notas WHERE chave = ?', parseNFe(xml).chave)[0] as any).id as string;
  };
  let empresaId = '';
  beforeEach(async () => {
    await entrar();
    empresaId = (await json('/api/empresas', {
      method: 'POST', body: JSON.stringify({ cnpj: '11222333000181', razaoSocial: 'ITALIANA', uf: 'SC', perfil: 'revenda' }),
    })).id;
  });

  it('marcar como cancelada: continua na lista, sai das somas, relatórios e exportação — e dá para desfazer', async () => {
    const a = await subir(empresaId, outraNota(XML, '71'));
    const b = await subir(empresaId, outraNota(XML, '72'));
    await post(`/api/notas/${a}/conferir`, {});
    await post(`/api/notas/${b}/conferir`, {});
    const antes = await json(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`);
    expect(antes.totais.valorContabil).toBeCloseTo(578, 2);

    expect((await post(`/api/notas/${a}/cancelada`, { cancelada: true })).status).toBe(200);
    const lista = await json(`/api/empresas/${empresaId}/notas`);
    const la = (lista.notas ?? lista).find((n: any) => n.id === a);
    expect(la.cancelada_em).toBeTruthy();
    expect(la.valor_total).toBeCloseTo(289, 2);             // o XML não muda; quem zera é a soma
    const nota = await json(`/api/notas/${a}`);
    expect(nota.totaisCfop.cancelada).toBe(true);

    const cfop = await json(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`);
    expect(cfop.totais.valorContabil).toBeCloseTo(289, 2);
    expect(cfop.totais.notas).toBe(1);
    expect(cfop.canceladas).toBe(1);
    expect((await json(`/api/empresas/${empresaId}/relatorios/produtos?competencia=2026-08`)).totais.valor).toBeCloseTo(289, 2);
    expect((await json(`/api/empresas/${empresaId}/relatorios/analitico?competencia=2026-08`)).linhas).toHaveLength(3);

    const zip = lerZip(new Uint8Array(await (await req(`/api/empresas/${empresaId}/xml-corrigidos.zip?competencia=2026-08`)).arrayBuffer()));
    expect([...zip.keys()].filter((k) => k.endsWith('-corrigido.xml'))).toHaveLength(1);
    expect([...zip.values()].join('')).toMatch(/cancelada/);

    const trilha = db.consultar(`SELECT valor_depois, origem FROM auditoria WHERE entidade = 'nota' AND campo = 'cancelada'`) as any[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].origem).toBe('manual');

    await post(`/api/notas/${a}/cancelada`, { cancelada: false });
    expect((await json(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`)).totais.valorContabil).toBeCloseTo(578, 2);
  });

  it('marcar cancelada exige poder importar', async () => {
    const a = await subir(empresaId, outraNota(XML, '73'));
    db.consultar(`DELETE FROM papel_permissoes WHERE papel_id = 'papel-admin' AND permissao = 'notas.importar'`);
    await entrar();
    expect((await post(`/api/notas/${a}/cancelada`, { cancelada: true })).status).toBe(403);
  });

  it('aplicar CFOP na nota toda: uma requisição, muda, confere, fica na trilha e ensina', async () => {
    const n1 = await subir(empresaId, outraNota(XML, '74'));
    const itens = (await json(`/api/notas/${n1}`)).itens;
    const r = await post(`/api/notas/${n1}/aplicar-cfop`, { cfop: '1949', itens: itens.map((i: any) => i.id) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ alterados: 3, conferidos: 3 });
    const depois = (await json(`/api/notas/${n1}`)).itens;
    expect(depois.every((i: any) => i.cfop_novo === '1949' && i.revisado === 1 && i.cfop_origem === 'manual')).toBe(true);
    const trilha = db.consultar(`SELECT * FROM auditoria WHERE entidade = 'item_nota' AND campo = 'cfop' AND valor_depois = '1949'`);
    expect(trilha).toHaveLength(3);                          // "como estava" continua funcionando
    const n2 = await subir(empresaId, outraNota(XML, '75'));
    const seguinte = (await json(`/api/notas/${n2}`)).itens;
    expect(seguinte.every((i: any) => i.cfop_novo === '1949' && i.procedencia.fonte === 'aprendida')).toBe(true);
  });

  it('fixar para o fornecedor em lote: padrão do fornecedor fixado', async () => {
    const n1 = await subir(empresaId, outraNota(XML, '76'));
    const itens = (await json(`/api/notas/${n1}`)).itens;
    await post(`/api/notas/${n1}/aplicar-cfop`, { cfop: '1556', itens: itens.map((i: any) => i.id), escopo: 'fornecedor' });
    const r5 = db.consultar(`SELECT * FROM regras WHERE nivel = 5 AND campo = 'cfop' AND ativa = 1`) as any[];
    // Um padrão por operação do fornecedor: a nota tem itens em 5102 e em 5405.
    expect(r5.map((r) => r.chave).sort()).toEqual(['83646984003044#5102', '83646984003044#5405']);
    expect(r5.every((r) => r.valor === '1556' && r.fixada === 1)).toBe(true);
  });

  it('CFOP inválido, lista vazia ou maior que 200 são recusados', async () => {
    const n1 = await subir(empresaId, outraNota(XML, '77'));
    const ids = (await json(`/api/notas/${n1}`)).itens.map((i: any) => i.id);
    expect((await post(`/api/notas/${n1}/aplicar-cfop`, { cfop: '19', itens: ids })).status).toBe(400);
    expect((await post(`/api/notas/${n1}/aplicar-cfop`, { cfop: '1949', itens: [] })).status).toBe(400);
    expect((await post(`/api/notas/${n1}/aplicar-cfop`, { cfop: '1949', itens: Array.from({ length: 201 }, () => ids[0]) })).status).toBe(400);
  });
});

describe('23/09: achar o que foi tratado errado, e XML de outra empresa é recusado', () => {
  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;
  let ck = '';
  const req = (c: string, o: RequestInit = {}) =>
    app.fetch(new Request(`http://x${c}`, {
      ...o, headers: { 'content-type': 'application/json', Cookie: ck, ...(o.headers ?? {}) },
    }), ambiente());
  const json = async (c: string, o: RequestInit = {}) => (await req(c, o)).json() as Promise<any>;
  const entrar = async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  };
  const subir = async (empresaId: string, xml: string, nome = 'n.xml') => {
    const fd = new FormData();
    fd.append('arquivos', new File([xml], nome, { type: 'text/xml' }));
    const r = await app.fetch(new Request(`http://x/api/empresas/${empresaId}/importar`, { method: 'POST', body: fd, headers: { Cookie: ck } }), ambiente());
    return (await r.json()) as any;
  };
  const criar = async (cnpj: string, nome: string) => (await json('/api/empresas', {
    method: 'POST', body: JSON.stringify({ cnpj, razaoSocial: nome, uf: 'SC', perfil: 'revenda' }),
  })).id as string;
  let empresaId = '';
  beforeEach(async () => {
    await entrar();
    empresaId = await criar('11222333000181', 'ITALIANA');
  });

  it('procurar "energético" acha o item em qualquer nota, com ou sem acento, e diz qual nota é', async () => {
    await subir(empresaId, outraNota(XML, '81'));
    await subir(empresaId, outraNota(XML, '82', [['<nNF>504782</nNF>', '<nNF>504782</nNF>']]));
    db.consultar(`UPDATE itens SET x_prod_novo = 'ENERGÉTICO LATA 473ML' WHERE n_item = 2 AND nota_id = (SELECT id FROM notas WHERE chave LIKE '%82')`);
    for (const q of ['energético', 'energetico', 'ENERGETICO']) {
      const r = await json(`/api/empresas/${empresaId}/busca-itens?q=${encodeURIComponent(q)}`);
      expect(r.itens, q).toHaveLength(1);
      expect(r.itens[0]).toMatchObject({ numero: '504782', n_item: 2, emit_nome: 'A. ANGELONI & CIA LTDA' });
      expect(r.itens[0].nota_id).toBeTruthy();
      expect(r.itens[0].item_id).toBeTruthy();
    }
    // Pela descrição do fornecedor e pelo código, nas duas notas.
    expect((await json(`/api/empresas/${empresaId}/busca-itens?q=refrig`)).itens).toHaveLength(2);
    expect((await json(`/api/empresas/${empresaId}/busca-itens?q=7893`)).itens).toHaveLength(2);
    // "%" e "_" são letras, não curinga.
    expect((await json(`/api/empresas/${empresaId}/busca-itens?q=%25%25`)).itens).toHaveLength(0);
    expect((await req(`/api/empresas/${empresaId}/busca-itens?q=e`)).status).toBe(400);
  });

  it('24/09: acha pelo nome do fornecedor, pelo CNPJ, pelo valor e por pedaços soltos', async () => {
    const n1 = (await subir(empresaId, outraNota(XML, '91'))).arquivos?.[0];
    await subir(empresaId, outraNota(XML, '92', [['<nNF>504792</nNF>', '<nNF>504792</nNF>']]));
    void n1;
    const busca = async (q: string) => (await json(`/api/empresas/${empresaId}/busca-itens?q=${encodeURIComponent(q)}`)) as any;
    // Nome do fornecedor, inteiro ou pedaço, com ou sem acento/maiúscula: todos os itens das duas notas.
    for (const q of ['angeloni', 'ANGEL', 'Angeloni cia']) expect((await busca(q)).itens, q).toHaveLength(6);
    // CNPJ do fornecedor com ou sem pontuação.
    expect((await busca('83646984003044')).itens).toHaveLength(6);
    expect((await busca('83.646.984/0030-44')).itens).toHaveLength(6);
    // Valor da nota (289,00) em vários jeitos de digitar: os itens das duas notas.
    for (const q of ['289', '289,00', 'R$ 289,00', 'R$289,00', '289.00']) expect((await busca(q)).itens, q).toHaveLength(6);
    // Valor do item.
    const v = await busca('38,40');
    expect(v.itens).toHaveLength(2);
    expect(v.itens.every((i: any) => i.n_item === 3)).toBe(true);
    // Valor com milhar, só numa nota.
    db.consultar(`UPDATE notas SET valor_total = 1234.56 WHERE chave LIKE '%92'`);
    for (const q of ['1.234,56', '1234,56']) {
      const r = await busca(q);
      expect(r.itens, q).toHaveLength(3);
      expect(r.itens.every((i: any) => i.numero === '504792'), q).toBe(true);
    }
    // Palavras soltas: todas precisam bater (em qualquer coluna).
    expect((await busca('refrig angeloni')).itens).toHaveLength(2);
    expect((await busca('refrig 504792')).itens).toHaveLength(1);
    expect((await busca('refrig rescaroli')).itens).toHaveLength(0);
    // Seis palavras não estouram o limite de parâmetros do D1.
    expect((await req(`/api/empresas/${empresaId}/busca-itens?q=${encodeURIComponent('1.234,56 83646984 angeloni refrig 289 cia')}`)).status).toBe(200);
  });

  it('24/09: nada na empresa escolhida → diz em qual outra empresa tem', async () => {
    const sailor = await criar('51714504000104', 'THE SAILOR LTDA');
    const daSailor = outraNota(XML, '93', [['<dest><CNPJ>11222333000181</CNPJ>', '<dest><CNPJ>51714504000104</CNPJ>']]);
    expect((await subir(sailor, daSailor)).importadas).toBe(1);
    const r = await json(`/api/empresas/${empresaId}/busca-itens?q=refrig`);
    expect(r.itens).toHaveLength(0);
    expect(r.outras).toEqual([{ empresaId: sailor, razaoSocial: 'THE SAILOR LTDA', itens: 1 }]);
    // Achou aqui: não procura nas outras.
    const aqui = await json(`/api/empresas/${sailor}/busca-itens?q=refrig`);
    expect(aqui.itens).toHaveLength(1);
    expect(aqui.outras).toEqual([]);
    // Nem aqui nem lá.
    expect((await json(`/api/empresas/${empresaId}/busca-itens?q=rescaroli`)).outras).toEqual([]);
  });

  it('relatório por produto: clicar no produto lista as notas dele', async () => {
    await subir(empresaId, outraNota(XML, '83'));
    await subir(empresaId, outraNota(XML, '84'));
    const rel = await json(`/api/empresas/${empresaId}/relatorios/produtos?competencia=2026-08`);
    const refri = rel.linhas.find((l: any) => /REFRIG/.test(l.descricao));
    const q = new URLSearchParams({ produto: refri.descricao, unidade: refri.unidade, competencia: '2026-08' });
    const r = await json(`/api/empresas/${empresaId}/busca-itens?${q}`);
    expect(r.itens).toHaveLength(refri.itens);
    expect(new Set(r.itens.map((i: any) => i.nota_id)).size).toBe(refri.notas);
  });

  it('últimas alterações: a mudança de CFOP mais recente primeiro, com a nota; conferir não entra', async () => {
    await subir(empresaId, outraNota(XML, '85'));
    const nota = (db.consultar(`SELECT id FROM notas WHERE chave LIKE '%85'`)[0] as any).id;
    const itens = (await json(`/api/notas/${nota}`)).itens;
    await req(`/api/itens/${itens[1].id}`, { method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1556' }] }) });
    await req(`/api/notas/${nota}/conferir`, { method: 'POST', body: '{}' });
    const r = await json(`/api/empresas/${empresaId}/ultimas-alteracoes`);
    expect(r.alteracoes[0]).toMatchObject({ campo: 'cfop', valor_depois: '1556', nota_id: nota, item_id: itens[1].id, numero: '504785' });
    expect(r.alteracoes.every((a: any) => a.campo !== 'conferido')).toBe(true);
    db.consultar(`DELETE FROM papel_permissoes WHERE papel_id = 'papel-admin' AND permissao = 'auditoria.visualizar'`);
    await entrar();
    expect((await req(`/api/empresas/${empresaId}/ultimas-alteracoes`)).status).toBe(403);
  });

  it('XML de outra empresa é recusado, e a mensagem diz de qual empresa ele é', async () => {
    const sailor = await criar('51714504000104', 'THE SAILOR LTDA');
    const daSailor = outraNota(XML, '86', [['<dest><CNPJ>11222333000181</CNPJ>', '<dest><CNPJ>51714504000104</CNPJ>']]);
    const r = await subir(empresaId, daSailor, 'sailor.xml');
    expect(r.importadas).toBe(0);
    expect(r.recusadas).toBe(1);
    expect(r.arquivos[0].motivo).toMatch(/não é desta empresa/);
    expect(r.arquivos[0].motivo).toMatch(/THE SAILOR LTDA/);
    expect(db.consultar('SELECT * FROM notas')).toHaveLength(0);
    // Na empresa certa, entra.
    expect((await subir(sailor, daSailor)).importadas).toBe(1);
    // CNPJ que ninguém tem: recusa, dizendo para conferir o arquivo.
    const deNinguem = outraNota(XML, '87', [['<dest><CNPJ>11222333000181</CNPJ>', '<dest><CNPJ>99888777000166</CNPJ>']]);
    expect((await subir(empresaId, deNinguem)).arquivos[0].motivo).toMatch(/Nenhuma empresa cadastrada/);
  });

  it('nota de entrada emitida pela própria empresa (ela é a emitente) continua entrando', async () => {
    const propria = outraNota(XML, '88', [
      ['<emit><CNPJ>83646984003044</CNPJ>', '<emit><CNPJ>11222333000181</CNPJ>'],
      ['<dest><CNPJ>11222333000181</CNPJ>', '<dest><CNPJ>83646984003044</CNPJ>'],
    ]);
    expect((await subir(empresaId, propria)).importadas).toBe(1);
  });
});

describe('"quero ver como que tava" — a trilha do item', () => {
  /* Último pedido da contadora no primeiro uso real, e o único que faltava.
     Até aqui o `desfazer` da linha só tirava a marca de conferido — o VALOR
     ficava onde ela deixou, e não havia como saber o que havia antes.

     A trilha é gravada desde o primeiro dia, com valor_antes e valor_depois.
     Não havia como ler: `auditoria.visualizar` podia ser concedida e não levava
     a lugar nenhum. É também compromisso de contrato. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  const SENHA = 'uma frase de senha longa';
  let ck = '';
  const req = (c: string, o: RequestInit = {}, cookie = ck) =>
    app.fetch(new Request(`http://x${c}`, {
      ...o, headers: { 'content-type': 'application/json', Cookie: cookie, ...(o.headers ?? {}) },
    }), ambiente());

  const subir = async (empresaId: string, xml = XML) => {
    const fd = new FormData();
    fd.append('arquivos', new File([xml], 'n.xml', { type: 'text/xml' }));
    return app.fetch(new Request(`http://x/api/empresas/${empresaId}/importar`, {
      method: 'POST', body: fd, headers: { Cookie: ck },
    }), ambiente());
  };

  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: SENHA }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
  });

  const prepararItem = async () => {
    const r = await req('/api/empresas', {
      method: 'POST',
      body: JSON.stringify({ cnpj: '11222333000181', razaoSocial: 'MERCADO PILOTO', uf: 'SC', perfil: 'revenda' }),
    });
    const { id: empresaId } = await r.json() as any;
    await subir(empresaId);
    const notaId = db.consultar('SELECT id FROM notas ORDER BY criado_em')[0].id;
    const corpo = await (await req(`/api/notas/${notaId}`)).json() as any;
    return { empresaId, notaId, item: corpo.itens[0] };
  };

  it('mostra o que havia antes, quem mudou e quando', async () => {
    const { item } = await prepararItem();
    const antes = item.cfop_novo;
    expect(antes).toBeTruthy();

    await req(`/api/itens/${item.id}`, {
      method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1403' }] }),
    });

    const trilha = await (await req(`/api/itens/${item.id}/trilha`)).json() as any[];
    const mudanca = trilha.find((e) => e.campo === 'cfop');
    expect(mudanca).toBeDefined();
    expect(mudanca.valor_antes).toBe(antes);
    expect(mudanca.valor_depois).toBe('1403');
    expect(mudanca.usuario_email).toBe('contadora@alfacontabil.net');
    expect(mudanca.quando).toBeTruthy();
  });

  it('e voltar atrás também fica registrado — a trilha nunca é apagada', async () => {
    const { item } = await prepararItem();
    const original = item.cfop_novo;

    await req(`/api/itens/${item.id}`, {
      method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1403' }] }),
    });
    await req(`/api/itens/${item.id}`, {
      method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: original }] }),
    });

    const trilha = await (await req(`/api/itens/${item.id}/trilha`)).json() as any[];
    const cfops = trilha.filter((e) => e.campo === 'cfop');
    // As DUAS alterações estão lá: a ida e a volta.
    expect(cfops).toHaveLength(2);
    // Mais recente primeiro — é assim que se procura "o que eu fiz ontem".
    expect(cfops[0].valor_depois).toBe(original);
    expect(cfops[1].valor_depois).toBe('1403');
  });

  it('a conferência aparece na trilha, distinta de mudança de valor', async () => {
    const { item } = await prepararItem();
    // Confirmar sem mudar valor: o caso que a contadora perdeu em 14/09.
    await req(`/api/itens/${item.id}`, { method: 'PATCH', body: JSON.stringify({ mudancas: [] }) });

    const trilha = await (await req(`/api/itens/${item.id}/trilha`)).json() as any[];
    expect(trilha.find((e) => e.campo === 'conferido')).toBeDefined();
  });

  it('sem a permissão, não se lê a trilha de ninguém', async () => {
    const { item } = await prepararItem();

    const papel = await req('/api/papeis', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Sem trilha',
        permissoes: ['notas.visualizar', 'empresas.visualizar', 'empresas.todas'],
      }),
    });
    const { id: papelId } = await papel.json() as any;
    const novo = await req('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ nome: 'Aux', email: 'semtrilha@alfacontabil.net', papelId }),
    });
    const { senhaProvisoria } = await novo.json() as any;

    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'semtrilha@alfacontabil.net', senha: senhaProvisoria }),
    }), ambiente());
    const ck2 = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    await req('/api/trocar-senha', {
      method: 'POST',
      body: JSON.stringify({ senhaAtual: senhaProvisoria, senhaNova: 'quinta frase longa 3' }),
    }, ck2);
    const l2 = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'semtrilha@alfacontabil.net', senha: 'quinta frase longa 3' }),
    }), ambiente());
    const ck3 = (l2.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    expect((await req(`/api/itens/${item.id}/trilha`, {}, ck3)).status).toBe(403);
  });
});

describe('relatórios por CFOP e por produto — o instrumento da comparação do fim do mês', () => {
  /* Pedido da contadora em 17/09: ela trata no sistema, a colega trata do jeito
     antigo, e no fim do mês batem os dois relatórios. Se o relatório mentir, a
     comparação inteira mente - por isso o teste que importa aqui é o que CRUZA o
     relatório com a soma crua dos itens. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  let ck = '';
  let empresaId = '';
  const req = (c: string) =>
    app.fetch(new Request(`http://x${c}`, { headers: { Cookie: ck } }), ambiente());

  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;

    empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'RESTAURANTE PILOTO LTDA', uf: 'SC', perfil: 'industrializacao',
    });
    // Julho: a nota original. Agosto: duas notas do mesmo fornecedor, mesmos produtos.
    await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'jul.xml', conteudo: XML },
      { nome: 'ago1.xml', conteudo: outraNota(XML, '11') },
      { nome: 'ago2.xml', conteudo: outraNota(XML, '22') },
    ]);
    // Ela trata um item de agosto: muda o CFOP e confere.
    db.consultar(`UPDATE itens SET cfop_novo = '1556', revisado = 1
                   WHERE n_item = 1 AND nota_id IN (SELECT id FROM notas WHERE competencia = '2026-08')`);
  });

  it('por CFOP: os totais batem com a soma crua dos itens da competência — nem um centavo, nem um item a mais', async () => {
    const r: any = await (await req(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`)).json();
    const cru = db.consultar(`SELECT COUNT(*) AS n, SUM(i.valor_total) AS v, SUM(i.revisado) AS c
                                FROM itens i JOIN notas n ON n.id = i.nota_id
                               WHERE n.competencia = '2026-08'`)[0] as any;
    expect(r.totais.itens).toBe(cru.n);
    expect(r.totais.itens).toBe(6);
    expect(r.totais.conferidos).toBe(cru.c);
    expect(r.totais.valor).toBeCloseTo(cru.v, 2);
    expect(r.linhas.reduce((s: number, l: any) => s + l.itens, 0)).toBe(cru.n);

    // "Os CFOPs que eu tratei, como ficou": o 1556 que ela pôs aparece, com natureza.
    const l1556 = r.linhas.find((l: any) => l.cfop === '1556');
    expect(l1556).toMatchObject({ itens: 2, conferidos: 2, natureza: 'Compra de material para uso ou consumo' });
    expect(l1556.origem).toMatch(/^\d{4} \(2\)$/);
  });

  it('julho não vaza para agosto, e o ano soma os dois', async () => {
    const jul: any = await (await req(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-07`)).json();
    const ano: any = await (await req(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026`)).json();
    expect(jul.totais.itens).toBe(3);
    expect(ano.totais.itens).toBe(9);
  });

  it('por produto: a quantidade do mês é a SOMA das notas, e unitário médio × quantidade fecha com o total', async () => {
    const r: any = await (await req(`/api/empresas/${empresaId}/relatorios/produtos?competencia=2026-08`)).json();
    const umaNota = db.consultar(`SELECT i.quantidade AS q, i.valor_total AS v, i.x_prod_original AS d
                                    FROM itens i JOIN notas n ON n.id = i.nota_id
                                   WHERE n.competencia = '2026-08' ORDER BY n.chave, i.n_item LIMIT 3`) as any[];
    expect(r.linhas).toHaveLength(3); // 3 produtos, não 6 linhas: duas notas do mesmo produto viram uma
    for (const item of umaNota) {
      const linha = r.linhas.find((l: any) => l.descricaoOriginal === item.d);
      expect(linha, item.d).toBeTruthy();
      expect(linha.notas).toBe(2);
      expect(linha.quantidade).toBeCloseTo(item.q * 2, 4);
      expect(linha.valor).toBeCloseTo(item.v * 2, 2);
      expect(linha.valorUnitarioMedio * linha.quantidade).toBeCloseTo(linha.valor, 1);
    }
    const cru = db.consultar(`SELECT SUM(i.valor_total) AS v FROM itens i JOIN notas n ON n.id = i.nota_id
                               WHERE n.competencia = '2026-08'`)[0] as any;
    expect(r.totais.valor).toBeCloseTo(cru.v, 2);
  });

  it('a descrição que ela padronizou é a que agrupa — e a original continua visível', async () => {
    db.consultar(`UPDATE itens SET x_prod_novo = 'ALFACE AMERICANA' WHERE n_item = 2`);
    const r: any = await (await req(`/api/empresas/${empresaId}/relatorios/produtos?competencia=2026-08`)).json();
    const l = r.linhas.find((x: any) => x.descricao === 'ALFACE AMERICANA');
    expect(l).toBeTruthy();
    expect(l.descricaoOriginal).not.toBe('ALFACE AMERICANA');
    expect(l.notas).toBe(2);
  });

  it('a planilha sai da mesma conta: abre no Excel brasileiro e fecha com a tela', async () => {
    const resp = await req(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08&formato=csv`);
    expect(resp.headers.get('content-type')).toMatch(/text\/csv/);
    expect(resp.headers.get('content-disposition')).toMatch(/relatorio-cfop-11222333000181-2026-08\.csv/);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM: sem ele o Excel quebra os acentos
    const texto = new TextDecoder().decode(bytes);
    const linhas = texto.trim().split('\r\n');
    expect(linhas[0]).toContain('CFOP de entrada;Natureza;Notas;Itens;Itens conferidos;Valor contábil');
    const tela: any = await (await req(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`)).json();
    const br = (v: number) => v.toFixed(2).replace('.', ',');
    const t = tela.totais;
    expect(linhas.at(-1)).toBe(`TOTAL;;${t.notas};6;2;${br(t.valorContabil)};${br(t.baseIcms)};${br(t.icms)};${br(t.st)};${br(t.ipi)};${br(t.valor)};`);
  });

  it('descrição de fornecedor que começa com "=" não vira fórmula na planilha', async () => {
    db.consultar(`UPDATE itens SET x_prod_novo = '=HYPERLINK("http://x")' WHERE n_item = 3`);
    const texto = await (await req(`/api/empresas/${empresaId}/relatorios/produtos?competencia=2026-08&formato=csv`)).text();
    expect(texto).toContain(`"'=HYPERLINK(""http://x"")"`);
  });

  it('outra empresa não aparece, e competência malformada é recusada', async () => {
    const outra = await repo.criarEmpresa({ cnpj: '99888777000166', razaoSocial: 'OUTRA', uf: 'SC', perfil: 'revenda' });
    const r: any = await (await req(`/api/empresas/${outra}/relatorios/cfop?competencia=2026-08`)).json();
    expect(r.totais.itens).toBe(0);
    expect((await req(`/api/empresas/${empresaId}/relatorios/cfop?competencia=agosto`)).status).toBe(400);
    expect((await req(`/api/empresas/${empresaId}/relatorios/outro`)).status).toBe(404);
    expect((await app.fetch(new Request(`http://x/api/empresas/${empresaId}/relatorios/cfop`), ambiente())).status).toBe(401);
  });
});

describe('nota original: o XML do fornecedor, legível, cruzado com o que o app mostra', () => {
  /* Pedido do Mateus em 17/09: abrir o original numa visão fácil e comparar com o
     que o app traz. A leitura vem do ARQUIVO guardado, nunca do banco - senão
     estaríamos comparando o banco com ele mesmo. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  let ck = '';
  let notaId = '';
  const req = (c: string, cookie = ck) =>
    app.fetch(new Request(`http://x${c}`, { headers: { Cookie: cookie } }), ambiente());

  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    const empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'RESTAURANTE PILOTO LTDA', uf: 'SC', perfil: 'industrializacao',
    });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'n.xml', conteudo: XML }]);
    notaId = (db.consultar('SELECT id FROM notas')[0] as any).id;
  });

  it('nota recém-importada: tudo que o app guarda confere com o XML', async () => {
    const r: any = await (await req(`/api/notas/${notaId}/original`)).json();
    const lida = parseNFe(XML);
    expect(r.divergencias).toBe(0);
    expect(r.itens).toHaveLength(lida.itens.length);
    expect(r.nota.chave).toBe(CHAVE_ORIGINAL);
    expect(r.nota.emit.nome).toBeTruthy();
    expect(r.nota.totais.vNF).toBeCloseTo(lida.vNF!, 2);
    for (const i of r.itens) {
      expect(i.divergencias).toEqual([]);
      expect(i.app).toBeTruthy();
    }
  });

  it('o que a contadora decidiu aparece AO LADO, não como divergência', async () => {
    db.consultar(`UPDATE itens SET cfop_novo = '1556', x_prod_novo = 'DETERGENTE NEUTRO', revisado = 1 WHERE n_item = 3`);
    const r: any = await (await req(`/api/notas/${notaId}/original`)).json();
    const i3 = r.itens.find((i: any) => i.nItem === 3);
    expect(r.divergencias).toBe(0);
    expect(i3.app).toMatchObject({ cfopEntrada: '1556', descricao: 'DETERGENTE NEUTRO', revisado: true });
    expect(i3.descricaoAlterada).toBe(true);
    expect(i3.xProd).not.toBe('DETERGENTE NEUTRO'); // o XML continua dizendo o que o fornecedor escreveu
  });

  it('se o banco divergir do XML, a tela fica sabendo: campo, valor no XML e valor no app', async () => {
    db.consultar(`UPDATE itens SET quantidade = 999, ncm = '00000000' WHERE n_item = 1`);
    db.consultar(`DELETE FROM itens WHERE n_item = 2`);
    const r: any = await (await req(`/api/notas/${notaId}/original`)).json();
    const i1 = r.itens.find((i: any) => i.nItem === 1);
    expect(i1.divergencias.map((d: any) => d.campo).sort()).toEqual(['NCM', 'quantidade']);
    expect(i1.divergencias.find((d: any) => d.campo === 'quantidade').noApp).toBe('999');
    expect(r.itens.find((i: any) => i.nItem === 2).app).toBeNull();
    expect(r.divergencias).toBe(3);
  });

  it('baixar devolve o arquivo byte a byte como o fornecedor assinou', async () => {
    const resp = await req(`/api/notas/${notaId}/original?formato=xml`);
    expect(resp.headers.get('content-disposition')).toContain(`${CHAVE_ORIGINAL}-original.xml`);
    expect(await resp.text()).toBe(XML);
  });

  it('ler a nota original não altera nada e exige sessão', async () => {
    const antes = JSON.stringify(db.consultar('SELECT * FROM itens ORDER BY n_item'));
    const trilha = db.consultar('SELECT COUNT(*) AS n FROM auditoria')[0] as any;
    await req(`/api/notas/${notaId}/original`);
    expect(JSON.stringify(db.consultar('SELECT * FROM itens ORDER BY n_item'))).toBe(antes);
    expect((db.consultar('SELECT COUNT(*) AS n FROM auditoria')[0] as any).n).toBe(trilha.n);
    expect((await req(`/api/notas/${notaId}/original`, '')).status).toBe(401);
    expect((await req(`/api/notas/nao-existe/original`)).status).toBe(404);
  });
});

describe('XML corrigido: a página deixa de ser beco — prévia real e exportação em lote', () => {
  /* Relato do Mateus em 17/09: "não está aparecendo nenhum". Pelo menu a página
     abria vazia, a prévia era um resumo montado na tela, e não havia como baixar a
     competência inteira. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  let ck = '';
  let empresaId = '';
  const req = (c: string, cookie = ck) =>
    app.fetch(new Request(`http://x${c}`, { headers: { Cookie: cookie } }), ambiente());


  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'RESTAURANTE PILOTO LTDA', uf: 'SC', perfil: 'industrializacao',
    });
    await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'a.xml', conteudo: outraNota(XML, '11') },
      { nome: 'b.xml', conteudo: outraNota(XML, '22') },
    ]);
    // A nota ...11 ela tratou inteira (e mudou um CFOP e uma descrição); a ...22 ficou pela metade.
    const [n11, n22] = db.consultar('SELECT id FROM notas ORDER BY chave') as any[];
    db.consultar(`UPDATE itens SET revisado = 1 WHERE nota_id = '${n11.id}'`);
    db.consultar(`UPDATE itens SET cfop_novo = '1556', x_prod_novo = 'DETERGENTE NEUTRO' WHERE nota_id = '${n11.id}' AND n_item = 3`);
    db.consultar(`UPDATE itens SET revisado = 1 WHERE nota_id = '${n22.id}' AND n_item = 1`);
  });

  it('a prévia é o arquivo de verdade: o mesmo XML que o download entrega, com a lista do que mudou', async () => {
    const n11 = (db.consultar('SELECT id FROM notas ORDER BY chave')[0] as any).id;
    const previa: any = await (await req(`/api/notas/${n11}/xml-corrigido/previa`)).json();
    const baixado = await (await req(`/api/notas/${n11}/xml-corrigido`)).text();
    expect(previa.xml).toBe(baixado);
    expect(previa.exportavel).toBe(true);
    expect(previa.conferidos).toBe(3);
    const i3 = previa.alteracoes.filter((a: any) => a.nItem === 3);
    expect(i3.find((a: any) => a.campo === 'CFOP')).toMatchObject({ depois: '1556' });
    expect(i3.find((a: any) => a.campo === 'xProd')).toMatchObject({ depois: 'DETERGENTE NEUTRO' });
    expect(previa.xml).toContain('<xProd>DETERGENTE NEUTRO</xProd>');
    expect(previa.invariantes.every((i: any) => i.ok)).toBe(true);
  });

  it('ver a prévia não conta como exportação: nada entra na trilha', async () => {
    const n11 = (db.consultar('SELECT id FROM notas ORDER BY chave')[0] as any).id;
    const antes = (db.consultar('SELECT COUNT(*) AS n FROM auditoria')[0] as any).n;
    await req(`/api/notas/${n11}/xml-corrigido/previa`);
    expect((db.consultar('SELECT COUNT(*) AS n FROM auditoria')[0] as any).n).toBe(antes);
  });

  it('a lista diz a situação de cada nota: conferidos e itens sem CFOP', async () => {
    db.consultar(`UPDATE itens SET cfop_novo = NULL WHERE n_item = 2 AND nota_id IN (SELECT id FROM notas WHERE chave LIKE '%22')`);
    const notas: any[] = await (await req(`/api/empresas/${empresaId}/notas?competencia=2026-08`)).json() as any;
    const n22 = notas.find((n) => String(n.chave).endsWith('22'));
    const n11 = notas.find((n) => String(n.chave).endsWith('11'));
    expect(n22.itens_sem_cfop).toBe(1);
    expect(n11.itens_sem_cfop).toBe(0);
    expect(n11.itens_revisados).toBe(n11.total_itens);
  });

  it('o zip leva SÓ a nota 100% conferida; a outra fica de fora, com motivo, no LEIA-ME — e fica na trilha', async () => {
    const resp = await req(`/api/empresas/${empresaId}/xml-corrigidos.zip?competencia=2026-08`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-disposition')).toContain('xml-corrigidos-11222333000181-2026-08.zip');
    const arquivos = lerZip(new Uint8Array(await resp.arrayBuffer()));

    const nomes = [...arquivos.keys()].sort();
    expect(nomes).toHaveLength(2); // uma nota + LEIA-ME
    const xmlNome = nomes.find((n) => n.endsWith('-corrigido.xml'))!;
    expect(xmlNome.slice(0, 44).endsWith('11')).toBe(true);

    // O que está no zip é byte a byte o que o download individual entrega.
    const n11 = (db.consultar('SELECT id FROM notas ORDER BY chave')[0] as any).id;
    expect(arquivos.get(xmlNome)).toBe(await (await req(`/api/notas/${n11}/xml-corrigido`)).text());

    const leia = arquivos.get('LEIA-ME.txt')!;
    expect(leia).toMatch(/NESTE ARQUIVO: 1 nota/);
    expect(leia).toMatch(/FICARAM DE FORA: 1 nota/);
    expect(leia).toMatch(/1 de 3 itens conferidos/);

    const trilha = db.consultar(`SELECT valor_depois FROM auditoria WHERE acao = 'exportar' AND entidade = 'empresa'`) as any[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].valor_depois).toMatch(/2026-08 · 1 nota\(s\), 1 de fora/);
  });

  it('sem nenhuma nota 100% conferida o zip não sai vazio: recusa e diz por quê', async () => {
    db.consultar('UPDATE itens SET revisado = 0');
    const resp = await req(`/api/empresas/${empresaId}/xml-corrigidos.zip?competencia=2026-08`);
    expect(resp.status).toBe(422);
    const corpo: any = await resp.json();
    expect(corpo.erro).toMatch(/100% conferida/);
    expect(corpo.falhas).toHaveLength(2);
  });

  it('exige competência, sessão e permissão de exportar', async () => {
    expect((await req(`/api/empresas/${empresaId}/xml-corrigidos.zip`)).status).toBe(400);
    expect((await req(`/api/empresas/${empresaId}/xml-corrigidos.zip?competencia=2026-08`, '')).status).toBe(401);
  });
});

describe('importações: os lotes de 20 de um mesmo envio viram UMA importação', () => {
  /* "Veio uns 70 XML de uma vez. Seria interessante agrupar." A tela manda os
     arquivos em lotes de 20 com um id de envio; a lista precisa devolver o envio
     inteiro, com o resultado por arquivo — inclusive o aviso de evento. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  let ck = '';
  let empresaId = '';
  const req = (c: string) =>
    app.fetch(new Request(`http://x${c}`, { headers: { Cookie: ck } }), ambiente());
  const subir = (arquivos: [string, string][], envio?: string) => {
    const fd = new FormData();
    for (const [nome, xml] of arquivos) fd.append('arquivos', new File([xml], nome, { type: 'text/xml' }));
    if (envio) fd.append('envio', envio);
    return app.fetch(new Request(`http://x/api/empresas/${empresaId}/importar`, {
      method: 'POST', body: fd, headers: { Cookie: ck },
    }), ambiente());
  };

  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'RESTAURANTE PILOTO LTDA', uf: 'SC', perfil: 'industrializacao',
    });
  });

  it('dois lotes com o mesmo envio aparecem como uma importação só, somando os resultados e guardando o evento', async () => {
    const envio = 'envio-teste-0001';
    await subir([['a.xml', outraNota(XML, '11')], ['b.xml', outraNota(XML, '22')]], envio);
    await subir([['c.xml', outraNota(XML, '33')], ['NFe_Evento.xml', EVENTO], ['b.xml', outraNota(XML, '22')]], envio);
    // Um envio antigo, separado.
    await subir([['d.xml', outraNota(XML, '44')]]);

    const lista: any[] = await (await req(`/api/empresas/${empresaId}/importacoes`)).json() as any;
    expect(lista).toHaveLength(2);
    const grande = lista.find((i) => i.id === envio);
    expect(grande).toMatchObject({ arquivos: 5, importadas: 3, duplicadas: 1, eventos: 1, recusadas: 0, notas: 3 });
    expect(grande.lotes).toHaveLength(2);
    expect(grande.resultados.find((r: any) => r.status === 'evento').motivo).toMatch(/CANCELAMENTO/);
    // As notas sabem de qual lote vieram, e os lotes pertencem ao envio.
    const notas: any[] = await (await req(`/api/empresas/${empresaId}/notas`)).json() as any;
    expect(notas.filter((n) => grande.lotes.includes(n.lote_id))).toHaveLength(3);
  });

  it('envio inválido é ignorado, não recusado', async () => {
    const r = await subir([['a.xml', outraNota(XML, '11')]], 'x');
    expect(r.status).toBe(200);
    const lista: any[] = await (await req(`/api/empresas/${empresaId}/importacoes`)).json() as any;
    expect(lista).toHaveLength(1);
    expect(lista[0].id).not.toBe('x');
  });
});


describe('o mesmo produto em 5102 e em nota de ajuste 5949 — cada um aprende o seu CFOP', () => {
  /* Áudios da Taís, 22/09: "o mesmo pudim que veio 5102, esse fornecedor fez um
     ajuste e emitiu outra nota no 5949 (...) cada um tem que entrar de uma maneira
     (...) ele não poderia aprender a ser 1949 esse produto sempre."
     Caso real: The Sailor, NF 2987604 da OESA. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  let ck = '';
  let empresaId = '';
  const req = (c: string, o: RequestInit = {}) =>
    app.fetch(new Request(`http://x${c}`, {
      ...o, headers: { 'content-type': 'application/json', Cookie: ck, ...(o.headers ?? {}) },
    }), ambiente());

  /** Nota do mesmo fornecedor, mesmos produtos, com outro CFOP de saída em todos os itens. */
  const comCfop = (sufixo: string, cfop: string) =>
    outraNota(XML, sufixo).replace(/<CFOP>\d{4}<\/CFOP>/g, `<CFOP>${cfop}</CFOP>`);

  const itensDa = (sufixo: string) =>
    db.consultar(`SELECT i.* FROM itens i JOIN notas n ON n.id = i.nota_id WHERE n.chave LIKE '%${sufixo}' ORDER BY i.n_item`) as any[];

  const corrigir = async (itemId: string, cfop: string) =>
    req(`/api/itens/${itemId}`, { method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: cfop }] }) });

  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    empresaId = await repo.criarEmpresa({
      cnpj: '11222333000181', razaoSocial: 'THE SAILOR TESTE', uf: 'SC', perfil: 'revenda',
    });
  });

  it('ensinar 1949 na nota de ajuste NÃO muda o que o produto recebe na próxima compra em 5102', async () => {
    // 1) compra normal em 5102: ela ensina 1101
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'compra.xml', conteudo: comCfop('11', '5102') }]);
    for (const i of itensDa('11')) await corrigir(i.id, '1101');

    // 2) nota de ajuste em 5949 com os mesmos produtos: ela ensina 1949
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'ajuste.xml', conteudo: comCfop('22', '5949') }]);
    for (const i of itensDa('22')) await corrigir(i.id, '1949');

    // 3) nova compra em 5102: tem de vir 1101, pela regra — não 1949
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'compra2.xml', conteudo: comCfop('33', '5102') }]);
    for (const i of itensDa('33')) {
      expect(i.cfop_novo, `item ${i.n_item} em 5102`).toBe('1101');
      expect(String(i.cfop_origem)).toMatch(/^regra:/);
    }

    // 4) novo ajuste em 5949: tem de vir 1949
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'ajuste2.xml', conteudo: comCfop('44', '5949') }]);
    for (const i of itensDa('44')) expect(i.cfop_novo, `item ${i.n_item} em 5949`).toBe('1949');
  });

  it('outro fornecedor, mesmo NCM, em 5102: a regra de NCM aprendida no ajuste não contamina', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'ajuste.xml', conteudo: comCfop('22', '5949') }]);
    for (const i of itensDa('22')) await corrigir(i.id, '1949');

    // Mesmo NCM, OUTRO fornecedor, produto nunca visto, em 5102.
    const outroForn = comCfop('55', '5102')
      .replaceAll('83646984003044', '99888777000166')
      .replace(/<cProd>[^<]+<\/cProd>/g, (m, off) => `<cProd>NOVO${off}</cProd>`)
      .replace(/<cEAN>[^<]+<\/cEAN>/g, '<cEAN>SEM GTIN</cEAN>');
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'outro.xml', conteudo: outroForn }]);
    for (const i of itensDa('55')) expect(i.cfop_novo, `item ${i.n_item}`).not.toBe('1949');
  });

  it('descrição continua sendo do produto: ensinada no 5102, vale também na nota de ajuste', async () => {
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'compra.xml', conteudo: comCfop('11', '5102') }]);
    const i1 = itensDa('11')[0];
    await req(`/api/itens/${i1.id}`, { method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'descricao', valor: 'PUDIM MORANGO 520G' }] }) });
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'ajuste.xml', conteudo: comCfop('22', '5949') }]);
    expect(itensDa('22')[0].x_prod_novo).toBe('PUDIM MORANGO 520G');
  });
});

describe('migração 0012: regras de CFOP refeitas com o CFOP de saída na chave', () => {
  /* Simula o banco de produção de 22/09: regras no formato antigo (sem '#'), uma
     delas fixada, e itens que a Taís conferiu — o pudim em 5102 (1101) e o mesmo
     pudim numa nota de ajuste em 5949 (1949). Aplica a 0012 de novo e confere. */
  const SQL_0012 = readFileSync(new URL('../migrations/0012_regra_cfop_por_operacao.sql', import.meta.url), 'utf8');

  it('as antigas ficam inativas (não somem), as novas nascem por operação, e a fixada continua fixada', async () => {
    const empresaId = await repo.criarEmpresa({ cnpj: '11222333000181', razaoSocial: 'SAILOR', uf: 'SC', perfil: 'revenda' });
    const comCfop = (s: string, c: string) => outraNota(XML, s).replace(/<CFOP>\d{4}<\/CFOP>/g, `<CFOP>${c}</CFOP>`);
    await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'compra.xml', conteudo: comCfop('11', '5102') },
      { nome: 'ajuste.xml', conteudo: comCfop('22', '5949') },
      { nome: 'palpite.xml', conteudo: comCfop('33', '5102') },
    ]);
    const nota = (s: string) => (db.consultar(`SELECT id FROM notas WHERE chave LIKE '%${s}'`)[0] as any).id;
    // Ela conferiu a compra (1101) no dia 17 e o ajuste (1949) no dia 18. A nota ...33 ficou no palpite, sem ninguém olhar.
    db.consultar(`UPDATE itens SET cfop_novo='1101', revisado=1, revisado_em='2026-09-17T10:00:00Z', cfop_origem='manual' WHERE nota_id=?`, nota('11'));
    db.consultar(`UPDATE itens SET cfop_novo='1949', revisado=1, revisado_em='2026-09-18T10:00:00Z', cfop_origem='manual' WHERE nota_id=?`, nota('22'));
    db.consultar(`UPDATE itens SET cfop_novo='1556', revisado=0, cfop_origem='perfil' WHERE nota_id=?`, nota('33'));

    // O estado antigo: regras sem o CFOP de saída. A última gravação (o ajuste) venceu.
    db.consultar(`DELETE FROM regras`);
    const item1 = db.consultar(`SELECT * FROM itens WHERE nota_id=? AND n_item=1`, nota('11'))[0] as any;
    const antigaBase = `83646984003044|${String(item1.c_prod).toUpperCase()}`;
    db.consultar(`INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, usos, acertos, confianca, criada_em, fixada, fixada_em)
                  VALUES ('velha-fix','alfa',?,1,?,'cfop','1101',2,2,0.75,'2026-09-17',1,'2026-09-17T10:00:00Z')`, empresaId, antigaBase);
    db.consultar(`INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, usos, acertos, confianca, criada_em)
                  VALUES ('velha-ncm','alfa',?,6,?,'cfop','1949',1,1,0.66,'2026-09-18')`, empresaId, String(item1.ncm));
    db.consultar(`INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, criada_em)
                  VALUES ('desc','alfa',?,1,?,'descricao','PUDIM','2026-09-18')`, empresaId, antigaBase);
    const itensAntes = JSON.stringify(db.consultar('SELECT * FROM itens ORDER BY id'));

    (db as any).db.exec(SQL_0012);

    // Nada do trabalho dela mudou.
    expect(JSON.stringify(db.consultar('SELECT * FROM itens ORDER BY id'))).toBe(itensAntes);
    // As antigas de CFOP ficam, inativas. A de descrição não é tocada.
    expect((db.consultar(`SELECT ativa FROM regras WHERE id='velha-ncm'`)[0] as any).ativa).toBe(0);
    expect((db.consultar(`SELECT ativa FROM regras WHERE id='velha-fix'`)[0] as any).ativa).toBe(0);
    expect((db.consultar(`SELECT ativa FROM regras WHERE id='desc'`)[0] as any).ativa).toBe(1);

    const nova = (nivel: number, chave: string) =>
      db.consultar(`SELECT * FROM regras WHERE ativa=1 AND campo='cfop' AND nivel=? AND chave=?`, nivel, chave)[0] as any;
    // Produto: uma regra por operação.
    expect(nova(1, `${antigaBase}#5102`)).toMatchObject({ valor: '1101', fixada: 1, fixada_em: '2026-09-17T10:00:00Z' });
    expect(nova(1, `${antigaBase}#5949`)).toMatchObject({ valor: '1949', fixada: 0 });
    // NCM de qualquer fornecedor: o 1949 fica preso ao 5949.
    expect(nova(6, `${item1.ncm}#5949`).valor).toBe('1949');
    expect(nova(6, `${item1.ncm}#5102`).valor).toBe('1101');
    // Palpite que ninguém conferiu não virou regra.
    expect(db.consultar(`SELECT * FROM regras WHERE ativa=1 AND campo='cfop' AND valor='1556'`)).toHaveLength(0);

    // E o motor, com as regras refeitas, sugere certo numa nota nova de cada tipo.
    await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'compra2.xml', conteudo: comCfop('44', '5102') },
      { nome: 'ajuste2.xml', conteudo: comCfop('55', '5949') },
    ]);
    const cfopDe = (s: string) => (db.consultar(`SELECT cfop_novo FROM itens WHERE nota_id=? ORDER BY n_item`, nota(s)) as any[]).map((i) => i.cfop_novo);
    expect(new Set(cfopDe('44'))).toEqual(new Set(['1101']));
    expect(new Set(cfopDe('55'))).toEqual(new Set(['1949']));
  });
});

describe('migração 0014: o "é sempre assim" que só tinha aparecido em nota de ajuste volta para a compra', () => {
  /* Conferência em produção, 22/09: na Sailor, touca e luva da OESA fixadas em 1556 e
     canela em 1101 só tinham vindo numa nota de ajuste 5949, lançada 1949. A 0012
     refez "#5949 = 1949" e o padrão fixado dela sumiu da compra normal. */
  const SQL_0012 = readFileSync(new URL('../migrations/0012_regra_cfop_por_operacao.sql', import.meta.url), 'utf8');
  const SQL_0014 = readFileSync(new URL('../migrations/0014_fixadas_voltam_na_compra.sql', import.meta.url), 'utf8');

  it('recria o fixado em #5102, não toca no ajuste nem em decisão dela numa compra, e a próxima compra vem com o padrão', async () => {
    const empresaId = await repo.criarEmpresa({ cnpj: '11222333000181', razaoSocial: 'SAILOR', uf: 'SC', perfil: 'revenda' });
    const comCfop = (s: string, c: string) => outraNota(XML, s).replace(/<CFOP>\d{4}<\/CFOP>/g, `<CFOP>${c}</CFOP>`);
    await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'ajuste.xml', conteudo: comCfop('22', '5949') },
      { nome: 'compra.xml', conteudo: comCfop('11', '5102') },
    ]);
    const nota = (s: string) => (db.consultar(`SELECT id FROM notas WHERE chave LIKE '%${s}'`)[0] as any).id;
    const itens = db.consultar(`SELECT * FROM itens WHERE nota_id=? ORDER BY n_item`, nota('22')) as any[];
    const base = (i: any) => `83646984003044|${String(i.c_prod).toUpperCase()}`;
    // Ajuste lançado 1949 por ela. Na compra, só o item 2 foi decidido por ela (1102); o resto é palpite.
    db.consultar(`UPDATE itens SET cfop_novo='1949', revisado=1, revisado_em='2026-09-18T10:00:00Z', cfop_origem='manual' WHERE nota_id=?`, nota('22'));
    db.consultar(`UPDATE itens SET cfop_novo='1101', revisado=0, cfop_origem='perfil' WHERE nota_id=?`, nota('11'));
    db.consultar(`UPDATE itens SET cfop_novo='1102', revisado=1, revisado_em='2026-09-19T10:00:00Z', cfop_origem='manual' WHERE nota_id=? AND n_item=2`, nota('11'));
    // Estado de antes da 0012: os itens 1 e 2 fixados (sem o CFOP de saída na chave).
    db.consultar(`DELETE FROM regras`);
    db.consultar(`INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, usos, acertos, confianca, criada_em, fixada, fixada_por, fixada_em)
                  VALUES ('fix-1','alfa',?,1,?,'cfop','1556',2,2,0.75,'2026-09-15','1',?,'2026-09-15T10:00:00Z')`, empresaId, base(itens[0]), 'u1');
    db.consultar(`INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, usos, acertos, confianca, criada_em, fixada, fixada_em)
                  VALUES ('fix-2','alfa',?,1,?,'cfop','1556',2,2,0.75,'2026-09-15','1','2026-09-15T10:00:00Z')`, empresaId, base(itens[1]));
    const itensAntes = JSON.stringify(db.consultar('SELECT * FROM itens ORDER BY id'));

    (db as any).db.exec(SQL_0012);
    const regra = (chave: string) => db.consultar(`SELECT * FROM regras WHERE ativa=1 AND campo='cfop' AND nivel=1 AND chave=?`, chave)[0] as any;
    expect(regra(`${base(itens[0])}#5102`)).toBeUndefined();  // o problema visto em produção

    (db as any).db.exec(SQL_0014);
    (db as any).db.exec(SQL_0014);                              // rodar de novo não duplica nem muda nada

    expect(JSON.stringify(db.consultar('SELECT * FROM itens ORDER BY id'))).toBe(itensAntes);
    expect(regra(`${base(itens[0])}#5102`)).toMatchObject({ valor: '1556', fixada: 1, fixada_por: 'u1', fixada_em: '2026-09-15T10:00:00Z' });
    expect(regra(`${base(itens[0])}#5949`)).toMatchObject({ valor: '1949', fixada: 0 });      // o ajuste continua 1949
    expect(regra(`${base(itens[1])}#5102`)).toMatchObject({ valor: '1102' });                 // decisão dela numa compra vence
    expect(db.consultar(`SELECT * FROM regras WHERE chave LIKE '%#5102' AND nivel=1 AND chave=?`, `${base(itens[0])}#5102`)).toHaveLength(1);
    expect((db.consultar(`SELECT ativa, observacao FROM regras WHERE id='fix-1'`)[0] as any)).toMatchObject({ ativa: 0 });
    expect((db.consultar(`SELECT observacao FROM regras WHERE id='fix-1'`)[0] as any).observacao).toContain('[0014]');
    expect((db.consultar(`SELECT observacao FROM regras WHERE id='fix-2'`)[0] as any).observacao).not.toContain('[0014]');

    // A próxima compra normal traz o padrão fixado dela, e diz de onde veio.
    await importarArquivos(repo, r2 as any, empresaId, [{ nome: 'compra2.xml', conteudo: comCfop('44', '5102') }]);
    const novo = db.consultar(`SELECT * FROM itens WHERE nota_id=? AND n_item=1`, nota('44'))[0] as any;
    expect(novo.cfop_novo).toBe('1556');
    const origem = String(novo.cfop_origem).slice('regra:'.length);
    expect((db.consultar(`SELECT fixada FROM regras WHERE id=?`, origem)[0] as any).fixada).toBe(1);
  });
});

describe('relatório no formato do livro de entradas: valor contábil, ICMS e analítico por CFOP', () => {
  /* Áudios da Taís, 22/09: o total do relatório (R$ 10.351,25) não fechava com o de
     "Notas recebidas" (R$ 10.393,68) — R$ 42,43 de frete e outras despesas de duas
     notas. E "só um CFOP fechou": ela precisa abrir o CFOP e ver as notas, com ICMS. */

  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;

  let ck = '';
  let empresaId = '';
  const req = (c: string) => app.fetch(new Request(`http://x${c}`, { headers: { Cookie: ck } }), ambiente());
  const json = async (c: string) => (await req(c)).json() as Promise<any>;

  /** Como a nota da SOS: frete 19,98 e outras 3,86 no item 1, e o vNF inclui os dois. */
  const comFrete = (sufixo: string) =>
    outraNota(XML, sufixo)
      .replace('<vProd>85.00</vProd>', '<vProd>85.00</vProd><vFrete>19.98</vFrete><vOutro>3.86</vOutro>')
      .replace('<vNF>289.00</vNF>', '<vNF>312.84</vNF>');

  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    empresaId = await repo.criarEmpresa({ cnpj: '11222333000181', razaoSocial: 'SAILOR', uf: 'SC', perfil: 'industrializacao' });
    await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'a.xml', conteudo: comFrete('11') },
      { nome: 'b.xml', conteudo: outraNota(XML, '22') },
    ]);
    // Ela tratou: na nota ...11 o item 1 foi para 1556; o resto ficou 1101.
    db.consultar(`UPDATE itens SET cfop_novo = '1101'`);
    db.consultar(`UPDATE itens SET cfop_novo = '1556' WHERE n_item = 1 AND nota_id = (SELECT id FROM notas WHERE chave LIKE '%11')`);
  });

  it('o total do relatório por CFOP fecha com o total das notas (vNF) — o caso dos R$ 42,43 da Sailor', async () => {
    const r = await json(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`);
    const somaVNF = (db.consultar(`SELECT SUM(valor_total) AS v FROM notas`)[0] as any).v;
    expect(r.totais.valorContabil).toBeCloseTo(somaVNF, 2);
    expect(r.totais.valorContabil).toBeCloseTo(289 + 312.84, 2);
    expect(r.totais.valor).toBeCloseTo(289 * 2, 2); // só produtos: a diferença é exatamente frete + outras
    expect(r.totais.valorContabil - r.totais.valor).toBeCloseTo(23.84, 2);
    // O frete caiu no CFOP do item que o carrega.
    const l1556 = r.linhas.find((l: any) => l.cfop === '1556');
    expect(l1556).toMatchObject({ notas: 1, itens: 1 });
    expect(l1556.valorContabil).toBeCloseTo(85 + 23.84, 2);
    expect(l1556.icms).toBeCloseTo(15.3, 2);
    expect(r.totais.icms).toBeCloseTo((15.3 + 6.91) * 2, 2);
    expect(r.totais.notas).toBe(2);
  });

  it('clicar no CFOP: as notas dele, somando só os itens daquele CFOP', async () => {
    const r = await json(`/api/empresas/${empresaId}/relatorios/notas?competencia=2026-08&cfop=1101`);
    expect(r.notas).toHaveLength(2);
    const comDois = r.notas.find((n: any) => n.itens === 2);   // a nota ...11: um item foi para 1556
    expect(comDois.valorContabil).toBeCloseTo(165.6 + 38.4, 2);
    expect(comDois.valorNota).toBeCloseTo(312.84, 2);             // a nota inteira, para ela ver que há outro CFOP
    const soma = r.notas.reduce((s: number, n: any) => s + n.valorContabil, 0);
    const sint = await json(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`);
    expect(soma).toBeCloseTo(sint.linhas.find((l: any) => l.cfop === '1101').valorContabil, 2);
  });

  it('planilha analítica: um item por linha, filtrável por CFOP, e o total bate com o sintético', async () => {
    const resp = await req(`/api/empresas/${empresaId}/relatorios/analitico?competencia=2026-08&cfop=1556&formato=csv`);
    expect(resp.headers.get('content-disposition')).toContain('relatorio-analitico-11222333000181-2026-08-cfop-1556.csv');
    const linhas = (await resp.text()).trim().split('\r\n');
    expect(linhas[0]).toContain('Número;Série;Fornecedor');
    expect(linhas[0]).toContain('Valor contábil;Base de cálculo ICMS;ICMS');
    expect(linhas).toHaveLength(3); // cabeçalho + 1 item + TOTAL
    expect(linhas[1]).toContain(';1556;');
    expect(linhas[1]).toContain(';19,98;');       // frete na coluna dele
    expect(linhas[1]).toContain(';108,84;');      // valor contábil do item
    const todos = (await (await req(`/api/empresas/${empresaId}/relatorios/analitico?competencia=2026-08&formato=csv`)).text()).trim().split('\r\n');
    expect(todos).toHaveLength(1 + 6 + 1);
  });

  it('notas importadas antes desta versão: os valores são lidos do XML guardado, sem tocar no original', async () => {
    const antes = await json(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`);
    db.consultar(`UPDATE itens SET v_frete = NULL, v_outro = NULL, v_icms = NULL, valor_contabil = NULL, valores_lidos = 0`);
    const xmlAntes = JSON.stringify([...r2.objetos.entries()]);
    expect(r2.objetos.size).toBe(2);
    const depois = await json(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`);
    expect(depois.totais).toEqual(antes.totais);
    expect(db.consultar(`SELECT * FROM itens WHERE valores_lidos = 0`)).toHaveLength(0);
    expect(JSON.stringify([...r2.objetos.entries()])).toBe(xmlAntes);
  });

  // ---- tela de tratamento (áudios de 22/09, 15h23–15h30): valor contábil por item e total por CFOP da nota
  const idDa = (sufixo: string) =>
    (db.consultar(`SELECT id FROM notas WHERE chave LIKE '%${sufixo}'`)[0] as any).id as string;

  it('abrir a nota: cada item traz o valor contábil, e o rodapé soma por CFOP só daquela nota', async () => {
    const r = await json(`/api/notas/${idDa('11')}`);
    const item1 = r.itens.find((i: any) => i.n_item === 1);
    expect(item1.valor_total).toBeCloseTo(85, 2);          // a coluna "Valor" continua sendo o produto
    expect(item1.valor_contabil).toBeCloseTo(108.84, 2);   // ao lado: produto + frete + outras
    const t = r.totaisCfop;
    expect(t.linhas.map((l: any) => l.cfop)).toEqual(['1101', '1556']);
    const l1556 = t.linhas.find((l: any) => l.cfop === '1556');
    expect(l1556).toMatchObject({ itens: 1 });
    expect(l1556.valor).toBeCloseTo(85, 2);
    expect(l1556.valorContabil).toBeCloseTo(108.84, 2);
    expect(t.linhas.find((l: any) => l.cfop === '1101').valorContabil).toBeCloseTo(204, 2);
    expect(t.totais.valor).toBeCloseTo(289, 2);
    expect(t.totais.valorContabil).toBeCloseTo(312.84, 2);  // fecha com o vNF
    expect(t.valorNota).toBeCloseTo(312.84, 2);
    expect(t.diferenca).toBe(0);
    expect(t.valoresLidos).toBe(true);
  });

  it('o rodapé da nota usa a mesma conta do relatório por CFOP', async () => {
    const nota = (await json(`/api/notas/${idDa('11')}`)).totaisCfop;
    const outra = (await json(`/api/notas/${idDa('22')}`)).totaisCfop;
    const rel = await json(`/api/empresas/${empresaId}/relatorios/cfop?competencia=2026-08`);
    for (const l of rel.linhas) {
      const soma = [nota, outra].flatMap((t: any) => t.linhas).filter((x: any) => x.cfop === l.cfop)
        .reduce((s: number, x: any) => s + x.valorContabil, 0);
      expect(soma).toBeCloseTo(l.valorContabil, 2);
    }
  });

  it('trocar o CFOP de um item move o valor dele no rodapé', async () => {
    const id = idDa('11');
    const item2 = (db.consultar(`SELECT id FROM itens WHERE nota_id = '${id}' AND n_item = 2`)[0] as any).id;
    const resp = await app.fetch(new Request(`http://x/api/itens/${item2}`, {
      method: 'PATCH', headers: { Cookie: ck, 'content-type': 'application/json' },
      body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1556' }] }),
    }), ambiente());
    expect(resp.status).toBe(200);
    const t = (await json(`/api/notas/${id}`)).totaisCfop;
    expect(t.linhas.find((l: any) => l.cfop === '1556').itens).toBe(2);
    expect(t.totais.valorContabil).toBeCloseTo(312.84, 2);  // o total da nota não muda
  });

  it('nota importada antes desta versão: abrir lê frete e despesas do XML guardado, sem mexer no que ela fez', async () => {
    const id = idDa('11');
    db.consultar(`UPDATE itens SET revisado = 1 WHERE nota_id = '${id}' AND n_item = 1`);
    db.consultar(`UPDATE itens SET v_frete = NULL, v_outro = NULL, valor_contabil = NULL, valores_lidos = 0 WHERE nota_id = '${id}'`);
    const decisoes = () => JSON.stringify(db.consultar(`SELECT n_item, cfop_novo, x_prod_novo, revisado, cfop_origem FROM itens WHERE nota_id = '${id}' ORDER BY n_item`));
    const antes = decisoes();
    const trilha = (db.consultar(`SELECT COUNT(*) AS n FROM auditoria`)[0] as any).n;
    const xml = JSON.stringify([...r2.objetos.entries()]);
    const r = await json(`/api/notas/${id}`);
    expect(r.itens.find((i: any) => i.n_item === 1).valor_contabil).toBeCloseTo(108.84, 2);
    expect(r.totaisCfop.diferenca).toBe(0);
    expect(db.consultar(`SELECT * FROM itens WHERE nota_id = '${id}' AND valores_lidos = 0`)).toHaveLength(0);
    expect(decisoes()).toBe(antes);
    expect((db.consultar(`SELECT COUNT(*) AS n FROM auditoria`)[0] as any).n).toBe(trilha);
    expect(JSON.stringify([...r2.objetos.entries()])).toBe(xml);
  });

  it('sem o XML original guardado: a tela avisa que o valor contábil está incompleto, e não inventa frete', async () => {
    const id = idDa('11');
    db.consultar(`UPDATE notas SET r2_original = NULL WHERE id = '${id}'`);
    db.consultar(`UPDATE itens SET v_frete = NULL, v_outro = NULL, valor_contabil = NULL, valores_lidos = 0 WHERE nota_id = '${id}'`);
    const r = await json(`/api/notas/${id}`);
    expect(r.totaisCfop.valoresLidos).toBe(false);
    expect(r.totaisCfop.totais.valorContabil).toBeCloseTo(289, 2);   // cai para o valor do produto
    expect(r.totaisCfop.diferenca).toBeCloseTo(23.84, 2);             // e a diferença fica à mostra
  });

  it('CFOP malformado é recusado, e "notas" exige o CFOP', async () => {
    expect((await req(`/api/empresas/${empresaId}/relatorios/notas?competencia=2026-08`)).status).toBe(400);
    expect((await req(`/api/empresas/${empresaId}/relatorios/analitico?competencia=2026-08&cfop=x1'`)).status).toBe(400);
  });
});

describe('25/09: PDF da nota, regime e responsáveis da empresa', () => {
  const ambiente = () => ({
    DB: db, XML_ORIGINAL: r2, XML_TRABALHO: r2,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
    SESSION_SECRET: 's', AUDIT_SEED: SEED, AMBIENTE: 'producao',
  }) as never;
  let ck = '';
  const req = (c: string, o: RequestInit = {}) =>
    app.fetch(new Request(`http://x${c}`, {
      ...o, headers: { 'content-type': 'application/json', Cookie: ck, ...(o.headers ?? {}) },
    }), ambiente());
  const json = async (c: string, o: RequestInit = {}) => (await req(c, o)).json() as Promise<any>;
  const subir = async (empresaId: string, xml: string) => {
    const fd = new FormData();
    fd.append('arquivos', new File([xml], 'n.xml', { type: 'text/xml' }));
    const r = await app.fetch(new Request(`http://x/api/empresas/${empresaId}/importar`, { method: 'POST', body: fd, headers: { Cookie: ck } }), ambiente());
    return (await r.json()) as any;
  };
  let empresaId = '';
  beforeEach(async () => {
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    empresaId = (await json('/api/empresas', {
      method: 'POST', body: JSON.stringify({ cnpj: '11222333000181', razaoSocial: 'ITALIANA', uf: 'SC', perfil: 'revenda', regime: 'simples' }),
    })).id;
  });

  it('PDF da nota: DANFE do XML original, com chave, código de barras e itens do fornecedor', async () => {
    await subir(empresaId, XML);
    const nota = (db.consultar('SELECT id FROM notas')[0] as any).id;
    // Trata um item: o DANFE continua mostrando o que o fornecedor emitiu.
    const itens = (await json(`/api/notas/${nota}`)).itens;
    await req(`/api/itens/${itens[0].id}`, { method: 'PATCH', body: JSON.stringify({ mudancas: [{ campo: 'cfop', valor: '1556' }, { campo: 'descricao', valor: 'NOME TRATADO' }] }) });
    const r = await req(`/api/notas/${nota}/danfe`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    expect(html).toContain('DANFE');
    expect(html).toContain(CHAVE_ORIGINAL.replace(/(\d{4})(?=\d)/g, '$1 '));
    expect(html).toContain('<svg');
    expect(html).toContain('A. ANGELONI &amp; CIA LTDA');
    expect(html).toContain('<title>NF-e 504767 - A. ANGELONI &amp; CIA LTDA</title>');
    expect(html).toContain('289,00');
    expect(html).not.toContain('NOME TRATADO');
    expect(html).not.toContain('1556');
    expect(html).not.toContain('NOTA CANCELADA');
    // Cancelada no sistema: sai com o carimbo.
    await req(`/api/notas/${nota}/cancelada`, { method: 'POST', body: JSON.stringify({ cancelada: true, motivo: 'teste' }) });
    expect(await (await req(`/api/notas/${nota}/danfe`)).text()).toContain('NOTA CANCELADA');
    // Sem login, não abre.
    const semLogin = await app.fetch(new Request(`http://x/api/notas/${nota}/danfe`), ambiente());
    expect(semLogin.status).toBe(401);
  });

  it('ler a sessão é UMA ida ao banco (antes eram 4, ~0,5 s em toda tela)', async () => {
    let idas = 0;
    const oPrepare = (db as any).prepare.bind(db);
    const oBatch = (db as any).batch.bind(db);
    (db as any).prepare = (sql: string) => {
      const st = oPrepare(sql);
      for (const m of ['all', 'run', 'first'] as const) {
        const o = st[m]?.bind(st);
        if (o) st[m] = (...a: any[]) => { idas += 1; return o(...a); };
      }
      return st;
    };
    (db as any).batch = (cs: any[]) => { idas += 1; return oBatch(cs); };
    try {
      const r = await req('/api/eu');
      expect(r.status).toBe(200);
      expect(idas).toBe(1);
    } finally {
      (db as any).prepare = oPrepare;
      (db as any).batch = oBatch;
    }
    // E continua recusando sessão revogada.
    db.consultar('UPDATE sessoes SET revogada = 1');
    expect((await req('/api/eu')).status).toBe(401);
  });

  it('regime: grava no cadastro e na edição, e aparece na lista', async () => {
    let e = (await json('/api/empresas')).find((x: any) => x.id === empresaId);
    expect(e.regime).toBe('simples');
    await req(`/api/empresas/${empresaId}`, { method: 'PATCH', body: JSON.stringify({ regime: 'presumido' }) });
    e = (await json('/api/empresas')).find((x: any) => x.id === empresaId);
    expect(e.regime).toBe('presumido');
  });

  it('responsáveis: mais de uma pessoa por empresa, quem vê tudo vem travado', async () => {
    for (const [id, nome] of [['u2', 'Auxiliar'], ['u3', 'Analista']]) {
      await db.prepare('INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, criado_em) VALUES (?,?,?,?,?,?)')
        .bind(id, 'alfa', `${id}@alfacontabil.net`, nome, 'x', new Date().toISOString()).run();
      await db.prepare('INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES (?,?)').bind(id, 'papel-operador').run();
    }
    await db.prepare('INSERT INTO sessoes (id, usuario_id, criada_em, expira_em, revogada) VALUES (?,?,?,?,0)')
      .bind('s-u2', 'u2', new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString()).run().catch(() => undefined);
    let r = await json(`/api/empresas/${empresaId}/responsaveis`);
    const por = (id: string) => r.usuarios.find((u: any) => u.id === id);
    expect(por('u1')).toMatchObject({ todas: true });
    expect(por('u2')).toMatchObject({ vinculado: false, todas: false });

    expect((await json(`/api/empresas/${empresaId}/responsaveis`, { method: 'PUT', body: JSON.stringify({ usuarios: ['u2', 'u3'] }) })).mudou).toBe(2);
    r = await json(`/api/empresas/${empresaId}/responsaveis`);
    expect(por('u2').vinculado && por('u3').vinculado).toBe(true);
    // O mesmo vínculo da tela de usuário.
    expect((await json('/api/usuarios/u2')).empresas).toEqual([empresaId]);
    // Tirar um não mexe no outro, e fica na trilha.
    await req(`/api/empresas/${empresaId}/responsaveis`, { method: 'PUT', body: JSON.stringify({ usuarios: ['u3'] }) });
    expect(db.consultar(`SELECT usuario_id FROM usuario_empresas WHERE empresa_id = '${empresaId}'`)).toEqual([{ usuario_id: 'u3' }]);
    expect(db.consultar(`SELECT campo FROM auditoria WHERE entidade = 'empresa' AND campo = 'responsaveis'`)).toHaveLength(2);
    // Usuário de fora do escritório não entra.
    expect((await req(`/api/empresas/${empresaId}/responsaveis`, { method: 'PUT', body: JSON.stringify({ usuarios: ['zzz'] }) })).status).toBe(404);
    // Sem permissão de editar usuários, não altera.
    db.consultar(`DELETE FROM papel_permissoes WHERE papel_id = 'papel-admin' AND permissao = 'usuarios.editar'`);
    const l = await app.fetch(new Request('http://x/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'contadora@alfacontabil.net', senha: 'uma frase de senha longa' }),
    }), ambiente());
    ck = (l.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    expect((await req(`/api/empresas/${empresaId}/responsaveis`, { method: 'PUT', body: JSON.stringify({ usuarios: [] }) })).status).toBe(403);
  });
});

