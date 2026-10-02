/**
 * Conferência do relatório por produto com o Questor (02/10/2026, pedido da Taís).
 *
 * Ela importa as notas do SAT no Questor e confere o relatório "Totais ICMS por
 * Produto" de lá com o nosso relatório por produto, produto por produto, valor por
 * valor. Aqui ela sobe o PDF do Questor e o sistema aponta o que não bate.
 *
 * Só produto e Valor Contábil (o que ela pediu). No PDF real que ela mandou (um mês
 * inteiro de uma das empresas), o Valor Contábil do Questor é a soma dos valores dos
 * produtos (vProd): o total bateu ao centavo com o nosso. Então comparamos com
 * `valor` do nosso relatório por produto.
 *
 * O nome no Questor vem com o código do produto lá e o NCM na frente
 * ("123 9999.99.00 555 - PRODUTO DO FORNECEDOR"), cortado na largura da coluna e
 * às vezes com espaços engolidos ("COPOPLASTICO 200"). Por isso a
 * comparação de nomes ignora espaço e pontuação, e aceita o nome do Questor como
 * começo do nosso.
 */

export class ErroQuestor extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ErroQuestor';
  }
}

export type LinhaQuestor = {
  codigo: string;
  ncm: string;
  descricao: string;
  quantidade: number;
  valor: number;
};

export type RelatorioQuestor = {
  empresa: string;
  cnpj: string;
  /** AAAA-MM-DD */
  de: string;
  ate: string;
  linhas: LinhaQuestor[];
  total: number;
};

/** Um pedaço de texto do PDF, na posição em que aparece na página. */
export type TextoNaPagina = { str: string; x: number; y: number; largura?: number };

const NUMERO = String.raw`-?\d{1,3}(?:\.\d{3})*,\d{2,4}`;
const LINHA_PRODUTO = new RegExp(
  String.raw`^(\S+)\s+(\d{4}\.\d{2}\.\d{2}|\d{8})\s+(.*?)\s+(${NUMERO})\s+(${NUMERO})\s+(${NUMERO})\s+(${NUMERO})\s+(${NUMERO})\s+(${NUMERO})\s*$`,
);
const LINHA_TOTAL = new RegExp(String.raw`^Total de Entradas.*?(${NUMERO})\s+(${NUMERO})\s+(${NUMERO})\s+(${NUMERO})\s+(${NUMERO})\s+(${NUMERO})\s*$`, 'i');

export const numeroBr = (s: string): number => Number(s.replace(/\./g, '').replace(',', '.'));
const isoDeBr = (s: string) => s.split('/').reverse().join('-');
const centavos = (v: number) => Math.round(v * 100) / 100;

/** Junta os pedaços de texto de cada página em linhas, de cima para baixo e da esquerda para a direita. */
export function linhasDoPdf(paginas: TextoNaPagina[][]): string[] {
  const saida: string[] = [];
  for (const itens of paginas) {
    const linhas: { y: number; itens: TextoNaPagina[] }[] = [];
    for (const it of itens) {
      if (!it.str) continue;
      const l = linhas.find((x) => Math.abs(x.y - it.y) <= 2);
      if (l) l.itens.push(it);
      else linhas.push({ y: it.y, itens: [it] });
    }
    linhas.sort((a, b) => b.y - a.y);
    for (const l of linhas) {
      // Pedaços colados viram uma palavra só: o PDF do Questor quebra "TOMATE" em "TOMA" + "TE".
      // Espaço só onde o PDF tem espaço ou onde há um vão entre os pedaços.
      let texto = '';
      let fim: number | null = null;
      for (const i of l.itens.sort((a, b) => a.x - b.x)) {
        const vao = fim !== null && i.largura !== undefined ? i.x - fim : (fim === null ? 0 : 99);
        if (texto && vao > 1 && !/\s$/.test(texto) && !/^\s/.test(i.str)) texto += ' ';
        texto += i.str;
        fim = i.largura !== undefined ? i.x + i.largura : null;
      }
      const limpo = texto.replace(/\s+/g, ' ').trim();
      if (limpo) saida.push(limpo);
    }
  }
  return saida;
}

/**
 * Lê o texto do relatório "Totais ICMS por Produto" do Questor. Confere a leitura:
 * a soma das linhas tem que dar o "Total de Entradas" do próprio relatório. Se não
 * der, recusa — número lido errado numa conferência de valor é pior que nada.
 */
export function lerTextoQuestor(linhas: string[]): RelatorioQuestor {
  const texto = linhas.join('\n');
  if (!/Totais\s*ICMS\s*por\s*Produto/i.test(texto)) {
    throw new ErroQuestor('Este arquivo não parece o relatório "Totais ICMS por Produto" do Questor.');
  }
  const cnpj = texto.match(/CNPJ:\s*([\d./-]{14,18})/)?.[1]?.replace(/\D/g, '') ?? '';
  const periodo = texto.match(/Per[ií]odo:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (!periodo) throw new ErroQuestor('Não achei o período no relatório do Questor.');
  const empresa = (linhas.find((l) => /CNPJ:/.test(l)) ? linhas[linhas.findIndex((l) => /CNPJ:/.test(l)) - 1] : '')
    ?.replace(/\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}.*$/, '').replace(/^\d+\s+/, '').trim() ?? '';

  const produtos: LinhaQuestor[] = [];
  let total: number | null = null;
  let secao = '';
  for (const l of linhas) {
    const sec = l.match(/^-\s*(Entradas|Sa[ií]das)\b/i);
    if (sec) { secao = sec[1]!.toLowerCase(); continue; }
    const t = l.match(LINHA_TOTAL);
    if (t) { total = numeroBr(t[2]!); continue; }
    if (secao.startsWith('sa')) continue;
    const m = l.match(LINHA_PRODUTO);
    if (!m) continue;
    produtos.push({
      codigo: m[1]!, ncm: m[2]!.replace(/\D/g, ''), descricao: m[3]!.trim(),
      quantidade: numeroBr(m[4]!), valor: numeroBr(m[5]!),
    });
  }
  if (!produtos.length) throw new ErroQuestor('Não achei nenhuma linha de produto no relatório do Questor.');
  if (total === null) throw new ErroQuestor('Não achei o "Total de Entradas" no fim do relatório do Questor. Mande o relatório inteiro, com a última página.');
  const soma = centavos(produtos.reduce((t, p) => t + p.valor, 0));
  if (Math.abs(soma - total) > 0.011) {
    throw new ErroQuestor(
      `Li ${produtos.length} produtos somando ${soma.toFixed(2).replace('.', ',')}, mas o total do relatório é ${total.toFixed(2).replace('.', ',')}. `
      + 'A leitura não fechou, então não vou comparar. Gere o PDF de novo pelo Questor e tente outra vez.',
    );
  }
  return { empresa, cnpj, de: isoDeBr(periodo[1]!), ate: isoDeBr(periodo[2]!), linhas: produtos, total };
}

/**
 * O PDF é aberto no navegador (pdf.js em public/pdfjs.mjs), que manda para cá
 * só os pedaços de texto com a posição. O pdf.js não roda no Worker da Cloudflare
 * (testado em 02/10), e no navegador roda.
 */
export function lerPaginasQuestor(paginas: TextoNaPagina[][]): RelatorioQuestor {
  const linhas = linhasDoPdf(paginas);
  if (!linhas.some((l) => /\d/.test(l))) {
    throw new ErroQuestor('O PDF não tem texto (parece uma imagem ou foto). Gere o PDF direto do Questor, sem escanear.');
  }
  return lerTextoQuestor(linhas);
}

// ------------------------------------------------------------------ a comparação

/** Um item de nota do mês, do nosso lado. */
export type ItemNosso = {
  original: string;
  padronizado: string;
  unidade: string;
  ncm: string;
  quantidade: number;
  valor: number;
  nota: string;
  fornecedor: string;
};

export type ProdutoNosso = {
  descricao: string;
  unidade: string;
  originais: string[];
  quantidade: number;
  valor: number;
  itens: number;
};

export type GrupoConferencia = {
  situacao: 'ok' | 'diferenca' | 'so_questor' | 'so_alfa';
  /** Juntou por nome parecido (não igual): vale ela olhar. */
  parecido: boolean;
  questor: LinhaQuestor[];
  nossos: ProdutoNosso[];
  valorQuestor: number;
  valorNosso: number;
  /** Questor menos Alfa Fiscal. */
  diferenca: number;
};

export type ResultadoConferencia = {
  grupos: GrupoConferencia[];
  /** Frases que apontam a causa provável: item lançado no produto errado, etc. */
  pistas: string[];
  totais: { questor: number; nosso: number; diferenca: number; ok: number; diferencas: number; soQuestor: number; soAlfa: number; parecidos: number };
};

/** Nome para comparar: sem acento, sem espaço, sem pontuação, maiúsculo. */
export function nomeComparavel(s: string): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function pares(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
  return m;
}

/** Semelhança de Dice por pares de letras: 1 = igual, 0 = nada em comum. */
export function semelhanca(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pa = pares(a), pb = pares(b);
  let comum = 0;
  for (const [k, n] of pa) comum += Math.min(n, pb.get(k) ?? 0);
  return (2 * comum) / (Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0) || 1);
}

const TAMANHO_MINIMO_PREFIXO = 6;
const moedaBr = (v: number) => Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Linha = {
  original: string; padronizado: string; unidade: string; ncm: string;
  quantidade: number; valor: number; itens: ItemNosso[];
};

/**
 * Compara o relatório do Questor com os itens do mês.
 *
 * Cada linha do Questor casa com as nossas pelo nome (igual, ou o do Questor sendo o
 * começo do nosso — ele corta o nome) e, se não achar, pelo nome mais parecido. O que
 * casa vira um grupo, e o grupo compara a soma dos dois lados: se o Questor juntou
 * dois produtos nossos em um (ou o contrário), a comparação continua valendo.
 */
export function conferirComQuestor(questor: LinhaQuestor[], itens: ItemNosso[]): ResultadoConferencia {
  // O nosso lado em linhas: mesma descrição da nota, mesmo nome padronizado, unidade e NCM.
  const porChave = new Map<string, Linha>();
  for (const it of itens) {
    const k = [it.original, it.padronizado, it.unidade, it.ncm].join('\u0001');
    const l = porChave.get(k) ?? { original: it.original, padronizado: it.padronizado, unidade: it.unidade, ncm: it.ncm, quantidade: 0, valor: 0, itens: [] };
    l.quantidade += it.quantidade; l.valor += it.valor; l.itens.push(it);
    porChave.set(k, l);
  }
  const nossos = [...porChave.values()];

  // Union-find: cada linha do Questor e cada linha nossa é um nó; o que casa vira um grupo.
  const pai: number[] = [];
  const achar = (i: number): number => (pai[i] === i ? i : (pai[i] = achar(pai[i]!)));
  const unir = (a: number, b: number) => { const ra = achar(a), rb = achar(b); if (ra !== rb) pai[rb] = ra; };
  const nq = questor.length;
  for (let i = 0; i < nq + nossos.length; i++) pai.push(i);

  const nomesNossos = nossos.map((r) => [...new Set([nomeComparavel(r.original), nomeComparavel(r.padronizado)].filter(Boolean))]);
  // Linhas que no nosso relatório são o mesmo produto (mesmo nome na tela + unidade) andam juntas.
  const naTela = (r: { original: string; padronizado: string; unidade: string }) =>
    `${nomeComparavel(r.padronizado || r.original)}|${r.unidade.trim().toUpperCase()}`;
  const porTela = new Map<string, number>();
  nossos.forEach((r, j) => {
    const k = naTela(r);
    if (porTela.has(k)) unir(nq + porTela.get(k)!, nq + j);
    else porTela.set(k, j);
  });

  const ligada = new Array<boolean>(nossos.length).fill(false);
  const parecidoEm = new Set<number>();
  const semPar: number[] = [];

  questor.forEach((q, i) => {
    const nomes = [nomeComparavel(q.descricao), nomeComparavel(q.descricao.replace(/^\S+\s*-\s*/, ''))].filter(Boolean);
    let achados = nossos.map((_, j) => j).filter((j) => nomesNossos[j]!.some((n) => nomes.includes(n)));
    if (!achados.length) {
      achados = nossos.map((_, j) => j).filter((j) =>
        nomesNossos[j]!.some((n) => nomes.some((qn) => qn.length >= TAMANHO_MINIMO_PREFIXO && n.startsWith(qn))));
      if (achados.length > 1) {
        const mesmoNcm = achados.filter((j) => nossos[j]!.ncm === q.ncm);
        if (mesmoNcm.length) achados = mesmoNcm;
      }
    }
    if (!achados.length) { semPar.push(i); return; }
    for (const j of achados) { unir(i, nq + j); ligada[j] = true; }
  });

  // Segunda volta: nome parecido (abreviação, letra trocada), de preferência com o mesmo NCM.
  for (const i of semPar) {
    const q = questor[i]!;
    const qn = nomeComparavel(q.descricao);
    let melhor = -1, nota = 0;
    nossos.forEach((r, j) => {
      for (const n of nomesNossos[j]!) {
        const s = semelhanca(qn, n.slice(0, qn.length + 2));
        const exige = r.ncm && r.ncm === q.ncm ? 0.8 : 0.92;
        const pontos = s - (ligada[j] ? 0.05 : 0);
        if (s >= exige && pontos > nota) { nota = pontos; melhor = j; }
      }
    });
    if (melhor >= 0) { unir(i, nq + melhor); ligada[melhor] = true; parecidoEm.add(i); }
  }

  const grupos = new Map<number, { q: number[]; n: number[] }>();
  for (let k = 0; k < nq + nossos.length; k++) {
    const r = achar(k);
    const g = grupos.get(r) ?? { q: [], n: [] };
    if (k < nq) g.q.push(k); else g.n.push(k - nq);
    grupos.set(r, g);
  }

  const saida: (GrupoConferencia & { _itens: ItemNosso[] })[] = [];
  for (const g of grupos.values()) {
    const qs = g.q.map((i) => questor[i]!);
    const telas = new Map<string, ProdutoNosso>();
    const doGrupo: ItemNosso[] = [];
    for (const j of g.n) {
      const r = nossos[j]!;
      doGrupo.push(...r.itens);
      const k = naTela(r);
      const t = telas.get(k) ?? { descricao: (r.padronizado || r.original).trim(), unidade: r.unidade.trim(), originais: [], quantidade: 0, valor: 0, itens: 0 };
      if (r.original && !t.originais.includes(r.original.trim())) t.originais.push(r.original.trim());
      t.quantidade += r.quantidade; t.valor += r.valor; t.itens += r.itens.length;
      telas.set(k, t);
    }
    const ns = [...telas.values()].map((t) => ({ ...t, quantidade: Math.round(t.quantidade * 10000) / 10000, valor: centavos(t.valor) }));
    const valorQuestor = centavos(qs.reduce((t, q) => t + q.valor, 0));
    const valorNosso = centavos(ns.reduce((t, n) => t + n.valor, 0));
    const diferenca = centavos(valorQuestor - valorNosso);
    const situacao: GrupoConferencia['situacao'] = !ns.length ? 'so_questor' : !qs.length ? 'so_alfa'
      : Math.abs(diferenca) < 0.005 ? 'ok' : 'diferenca';
    saida.push({ situacao, parecido: g.q.some((i) => parecidoEm.has(i)), questor: qs, nossos: ns, valorQuestor, valorNosso, diferenca, _itens: doGrupo });
  }

  const ordem = { diferenca: 0, so_questor: 1, so_alfa: 2, ok: 3 };
  const nome = (g: GrupoConferencia) => (g.questor[0]?.descricao ?? g.nossos[0]?.descricao ?? '');
  saida.sort((a, b) => ordem[a.situacao] - ordem[b.situacao]
    || (a.situacao === 'ok' ? nome(a).localeCompare(nome(b)) : Math.abs(b.diferenca) - Math.abs(a.diferenca))
    || nome(a).localeCompare(nome(b)));

  const pistas = acharPistas(saida);
  const conta = (s: GrupoConferencia['situacao']) => saida.filter((g) => g.situacao === s).length;
  const totalQ = centavos(questor.reduce((t, q) => t + q.valor, 0));
  const totalN = centavos(itens.reduce((t, n) => t + n.valor, 0));
  return {
    grupos: saida.map(({ _itens, ...g }) => g),
    pistas,
    totais: {
      questor: totalQ, nosso: totalN, diferenca: centavos(totalQ - totalN),
      ok: conta('ok'), diferencas: conta('diferenca'), soQuestor: conta('so_questor'), soAlfa: conta('so_alfa'),
      parecidos: saida.filter((g) => g.parecido).length,
    },
  };
}

/**
 * O que costuma explicar uma diferença: um item que no Questor foi para outro produto.
 * Aí a diferença de um produto é igual (com sinal trocado) à de outro, ou à soma de
 * produtos que só aparecem de um lado.
 */
function acharPistas(grupos: (GrupoConferencia & { _itens: ItemNosso[] })[]): string[] {
  const pistas: string[] = [];
  const nomeQ = (g: GrupoConferencia) => g.questor.map((q) => q.descricao).join(' + ') || g.nossos.map((n) => n.descricao).join(' + ');
  const nomeN = (g: GrupoConferencia) => g.nossos.map((n) => n.descricao).join(' + ') || nomeQ(g);
  const igual = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const usados = new Set<GrupoConferencia>();
  const difs = grupos.filter((g) => g.situacao === 'diferenca');

  // Um item que, aqui, está num produto e, no Questor, em outro.
  const itemDe = (g: { _itens: ItemNosso[] }, valor: number) => {
    const it = g._itens.find((i) => igual(i.valor, valor));
    return it ? ` (aqui é o item de R$ ${moedaBr(it.valor)} da nota ${it.nota}${it.fornecedor ? `, ${it.fornecedor}` : ''})` : '';
  };

  for (const a of difs) {
    if (a.diferenca <= 0 || usados.has(a)) continue;
    const b = difs.find((x) => x !== a && !usados.has(x) && igual(x.diferenca, -a.diferenca));
    if (!b) continue;
    usados.add(a); usados.add(b);
    pistas.push(`${nomeQ(a)} está R$ ${moedaBr(a.diferenca)} a mais no Questor e ${nomeN(b)} R$ ${moedaBr(b.diferenca)} a menos: `
      + `provavelmente um item de ${nomeN(b)} foi lançado no Questor como ${nomeQ(a)}${itemDe(b, a.diferenca)}.`);
  }

  // Diferença que é a soma de produtos que só aparecem de um lado (até 3).
  const soma = (gs: GrupoConferencia[], k: 'valorQuestor' | 'valorNosso') => gs.reduce((t, g) => t + g[k], 0);
  const combinacoes = <T>(lista: T[], max: number): T[][] => {
    const out: T[][] = [];
    const ir = (ini: number, atual: T[]) => {
      if (atual.length) out.push(atual);
      if (atual.length === max) return;
      for (let i = ini; i < lista.length; i++) ir(i + 1, [...atual, lista[i]!]);
    };
    ir(0, []);
    return out;
  };
  const soAlfa = grupos.filter((g) => g.situacao === 'so_alfa').slice(0, 25);
  const soQuestor = grupos.filter((g) => g.situacao === 'so_questor').slice(0, 25);
  for (const a of difs) {
    if (usados.has(a)) continue;
    if (a.diferenca > 0) {
      const c = combinacoes(soAlfa.filter((g) => !usados.has(g)), 3).find((gs) => igual(soma(gs, 'valorNosso'), a.diferenca));
      if (!c) continue;
      usados.add(a); c.forEach((g) => usados.add(g));
      pistas.push(`A diferença de ${nomeQ(a)} (R$ ${moedaBr(a.diferenca)} a mais no Questor) é o valor de `
        + `${c.map((g) => `${nomeN(g)} (R$ ${moedaBr(g.valorNosso)})`).join(' + ')}, que não aparece no Questor: `
        + `provavelmente foi lançado lá como ${nomeQ(a)}.`);
    } else {
      const c = combinacoes(soQuestor.filter((g) => !usados.has(g)), 3).find((gs) => igual(soma(gs, 'valorQuestor'), -a.diferenca));
      if (!c) continue;
      usados.add(a); c.forEach((g) => usados.add(g));
      pistas.push(`A diferença de ${nomeN(a)} (R$ ${moedaBr(a.diferenca)} a menos no Questor) é o valor de `
        + `${c.map((g) => `${nomeQ(g)} (R$ ${moedaBr(g.valorQuestor)})`).join(' + ')}, que só aparece no Questor: `
        + `provavelmente um item de ${nomeN(a)}${itemDe(a, -a.diferenca)} foi lançado lá com esse nome.`);
    }
  }

  // O que sobrou: se a diferença é exatamente um item, aponta qual.
  for (const a of difs) {
    if (usados.has(a) || a.diferenca >= 0) continue;
    const it = itemDe(a, -a.diferenca);
    if (it) pistas.push(`${nomeN(a)} está R$ ${moedaBr(a.diferenca)} a menos no Questor — é exatamente um item${it}. Veja se ele entrou no Questor.`);
  }
  return pistas;
}
