import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { D1Local, R2Local } from './d1-local';
import { Repo } from '../src/db/repo';
import { importarArquivos } from '../src/nfe/importador';
import { TODAS_PERMISSOES, type Sessao } from '../src/auth/permissoes';

/**
 * O tamanho real, não o tamanho do exemplo.
 *
 * A nota de teste tem 3 itens. As notas da ALFA têm 15. O leiaute da NF-e
 * admite até 990 por nota — e é nesse teto que o sistema tem que funcionar,
 * não na média confortável.
 *
 * Este projeto já tropeçou duas vezes no mesmo lugar: a primeira nota real de
 * 20 itens derrubou a importação porque o D1 corta em 100 parâmetros, com a
 * suíte toda verde. O que não é simulado aqui é latência — por isso o que se
 * mede não é o milissegundo, é o NÚMERO DE IDAS AO BANCO. Local, 4.000
 * consultas rodam em 100ms e não doem; no D1 cada uma é uma ida e volta.
 */

const XML = readFileSync(new URL('./fixtures/nfe-exemplo.xml', import.meta.url), 'utf8');
const SEED = 'semente-de-teste';

function notaGrande(n: number, mesmoEan = false): string {
  const um = XML.match(/<det nItem="1">[\s\S]*?<\/det>/)![0];
  const ultimo = Math.max(...[...XML.matchAll(/<det nItem="(\d+)"/g)].map((m) => Number(m[1])));
  const extras = [];
  for (let i = ultimo + 1; i <= n; i++) {
    let d = um.replace('nItem="1"', `nItem="${i}"`)
      .replace('<cProd>7891</cProd>', `<cProd>P${String(i).padStart(5, '0')}</cProd>`);
    // `mesmoEan` reproduz o caso real de dois itens da mesma nota dividindo o
    // código de barras — lotes diferentes, preços diferentes, mesmo produto.
    if (!mesmoEan) d = d.replace('<cEAN>7891000100103</cEAN>', `<cEAN>78910${String(i).padStart(8, '0')}</cEAN>`);
    extras.push(d);
  }
  return XML.replace(um, um + extras.join(''));
}

let db: D1Local, r2: R2Local, repo: Repo;

beforeEach(() => {
  db = new D1Local(); db.migrar(); r2 = new R2Local();
  const sessao: Sessao = {
    usuarioId: 'u1', tenantId: 'alfa', email: 'c@a.net', nome: 'Taís',
    permissoes: new Set(TODAS_PERMISSOES), empresas: null, deveTrocarSenha: false,
  };
  repo = new Repo(db as any, { sessao, ip: '1.2.3.4', requestId: 'r' }, SEED);
});

/** Conta idas e voltas ao banco — `batch` conta como uma só. */
function contarIdas(): { ler: () => number; parar: () => void } {
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
  return {
    ler: () => idas,
    parar: () => { (db as any).prepare = oPrepare; (db as any).batch = oBatch; },
  };
}

const criarEmpresa = () => repo.criarEmpresa({
  cnpj: '11222333000181', razaoSocial: 'GRANDE', uf: 'SC', perfil: 'revenda',
});

describe('a nota no tamanho máximo que a NF-e admite', () => {
  it('importa 990 itens e fixa o padrão de todos', async () => {
    const empresaId = await criarEmpresa();
    const imp = await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'g.xml', conteudo: notaGrande(990) },
    ]);
    expect(imp.importadas).toBe(1);

    const notaId = db.consultar('SELECT id FROM notas')[0].id;
    const ids = db.consultar('SELECT id FROM itens WHERE nota_id = ?', notaId).map((i: any) => i.id);
    expect(ids).toHaveLength(990);

    const r = await repo.fixarPadraoDeItens(notaId, ids);
    expect(r.fixados).toBe(990);
    expect(r.semCfop).toBe(0);
    expect(await repo.conferirItens(notaId, ids)).toBe(990);
  }, 60000);

  it('e faz isso sem estourar o banco de idas e voltas', async () => {
    // A versão ingênua chamava o aprendizado item a item: 4 consultas por item,
    // 3.978 numa nota de 990, tudo numa requisição só. Passava local e morreria
    // em produção. Em lote são ~90.
    const empresaId = await criarEmpresa();
    await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'g.xml', conteudo: notaGrande(990) },
    ]);
    const notaId = db.consultar('SELECT id FROM notas')[0].id;
    const ids = db.consultar('SELECT id FROM itens WHERE nota_id = ?', notaId).map((i: any) => i.id);

    const c = contarIdas();
    await repo.fixarPadraoDeItens(notaId, ids);
    const idas = c.ler();
    c.parar();

    expect(idas, `${idas} idas ao banco para 990 itens — voltou a ser uma por item?`)
      .toBeLessThan(200);
  }, 60000);

  it('dois itens dividindo o código de barras não derrubam o lote inteiro', async () => {
    // Acontece de verdade: mesmo produto, lotes diferentes, na mesma nota. Sem
    // juntar as regras repetidas antes de gravar, o banco recusa o lote e leva
    // junto os 900 itens que estavam certos.
    const empresaId = await criarEmpresa();
    await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'g.xml', conteudo: notaGrande(120, true) },
    ]);
    const notaId = db.consultar('SELECT id FROM notas')[0].id;
    const ids = db.consultar('SELECT id FROM itens WHERE nota_id = ?', notaId).map((i: any) => i.id);

    const r = await repo.fixarPadraoDeItens(notaId, ids);
    expect(r.fixados).toBe(120);

    // A regra daquele código de barras existe UMA vez, não 118 — os outros
    // níveis 2 que aparecem são dos itens próprios da nota de exemplo.
    const compartilhado = db.consultar(
      "SELECT COUNT(*) AS n FROM regras WHERE nivel = 2 AND chave LIKE '%7891000100103'",
    )[0].n;
    expect(compartilhado).toBe(1);
  }, 60000);

  it('item sem CFOP é pulado, e o resto passa', async () => {
    const empresaId = await criarEmpresa();
    await importarArquivos(repo, r2 as any, empresaId, [
      { nome: 'g.xml', conteudo: notaGrande(20) },
    ]);
    const notaId = db.consultar('SELECT id FROM notas')[0].id;
    const ids = db.consultar('SELECT id FROM itens WHERE nota_id = ?', notaId).map((i: any) => i.id);

    await db.prepare('UPDATE itens SET cfop_novo = NULL WHERE id IN (?,?)')
      .bind(ids[0], ids[1]).run();

    const r = await repo.fixarPadraoDeItens(notaId, ids);
    expect(r.semCfop).toBe(2);
    expect(r.fixados).toBe(18);
  }, 60000);
});
