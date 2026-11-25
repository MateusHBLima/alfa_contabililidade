import { XMLParser } from 'fast-xml-parser';

/**
 * Leiaute 200 – Entradas do Questor SYN, versão 2.00 (25/11, Mateus: "o Questor tem que
 * aceitar como a gente mandar").
 *
 * POR QUE EXISTE. O XML da NF-e só leva o CFOP de 4 dígitos. A natureza do Questor é o
 * CFOP mais um complemento de 3 (1.556.008), e é ela que liga a nota à conta contábil.
 * Importando o XML, o Questor põe o complemento pela tabela dele (um por CFOP) ou não
 * põe nenhum (teste de 24/11 com a NF 5303993 da Copal: entrou 1.101 e 1.556). Pelo
 * leiaute 200 a natureza vai inteira, item por item, como o sistema decidiu.
 *
 * O QUE VAI. Por nota: A (fornecedor; o Questor ignora se já existe), B (produtos; idem),
 * C (cabeçalho), D (impostos por natureza e alíquota), E (itens), G/H (duplicatas, se o
 * XML tiver). F (PIS/COFINS por item) ainda não: as empresas do primeiro teste são do
 * Simples. Ver claude/questor-natureza-importacao.md.
 *
 * FORMATO. Campos separados por `;`, um registro por linha, CRLF, linha em branco no fim.
 * Número com vírgula e duas casas; data DD/MM/AAAA. A quantidade de campos de cada
 * registro segue o EXEMPLO da documentação (C 62, D 10, E 42, A 25, B 24), porque a
 * tabela de posições da página não bate com o próprio exemplo.
 * https://docs.questor.com.br/pt-br/Produtos/Integracoes/SYN/Documentação/DadosVersao2/LayoutTxt/fiscal/200-Entradas
 *
 * Módulo puro: recebe a nota já tratada e devolve o texto. Não sabe nada de banco nem de rede.
 */

export type RegraIcms = 'manter' | 'outras';

export type ItemEntrada = {
  nItem: number;
  cProd: string;
  descricao: string;
  ncm: string | null;
  unidade: string | null;
  quantidade: number;
  valorUnitario: number;
  valorProduto: number;
  desconto: number;
  frete: number;
  seguro: number;
  outras: number;
  baseIcms: number;
  icms: number;
  baseSt: number;
  st: number;
  ipi: number;
  valorContabil: number;
  /** CFOP de entrada, 4 dígitos */
  cfop: string;
  /** natureza completa, 7 dígitos: 1556008 */
  natureza: string;
};

export type NotaEntrada = {
  cnpjEmpresa: string;
  numero: string;
  serie: string | null;
  chave: string;
  /** AAAA-MM-DD */
  dataEmissao: string;
  fornecedor: {
    cnpj: string;
    nome: string;
    uf: string | null;
    ie: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    municipioIbge: string | null;
    cep: string | null;
    fone: string | null;
  };
  /** 0 à vista, 1 a prazo, 2 outros (indPag do XML) */
  indPag: string;
  /** tPag do XML (01 dinheiro ... 99 outros) */
  tPag: string;
  modFrete: string;
  duplicatas: { numero: string; vencimento: string; valor: number }[];
  itens: ItemEntrada[];
  /** alíquota de ICMS e CST (origem + CST/CSOSN) de cada item, vindos do XML */
  icmsDoItem: Map<number, { aliquota: number; cst: string }>;
};

const CRLF = '\r\n';

export const num2 = (v: number | null | undefined): string => (Math.round(Number(v ?? 0) * 100) / 100).toFixed(2).replace('.', ',');
const num6 = (v: number): string => Number(v ?? 0).toFixed(6).replace('.', ',');
const soDigitos = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

export function cnpjFormatado(c: string): string {
  const d = soDigitos(c);
  if (d.length !== 14) return d;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** AAAA-MM-DD (ou ISO com hora) → DD/MM/AAAA */
export function dataBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Texto sem os separadores que o Questor proíbe (; | ") e cortado no tamanho do campo. */
export function textoCampo(s: string | null | undefined, max: number): string {
  return String(s ?? '').replace(/[;|"\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Tipo do item (Anexo H) pelo CFOP de entrada: revenda, matéria-prima, uso e consumo, imobilizado. */
export function tipoDoItem(cfop: string): string {
  const fim = cfop.slice(1);
  if (fim === '102' || fim === '403') return '0';
  if (fim === '101' || fim === '401') return '1';
  if (fim === '556' || fim === '407' || fim === '128') return '7';
  if (fim === '551' || fim === '406') return '8';
  return '99';
}

const linha = (campos: string[]) => campos.join(';');

function registroA(n: NotaEntrada): string {
  const f = n.fornecedor;
  const fone = soDigitos(f.fone);
  const numeroEnd = /^\d{1,6}$/.test(String(f.numero ?? '').trim()) ? String(f.numero).trim() : '';
  // 25 campos, como no exemplo (o 23 do exemplo é "~"; aqui vazio)
  return linha([
    'A', textoCampo(f.nome, 50), '2', cnpjFormatado(f.cnpj), '', '', '',
    textoCampo(f.logradouro, 40), numeroEnd, textoCampo(f.complemento, 20), textoCampo(f.bairro, 30),
    textoCampo(f.uf, 2), soDigitos(f.municipioIbge), soDigitos(f.cep),
    fone.length >= 10 ? fone.slice(0, 2) : '', fone.length >= 10 ? fone.slice(2).slice(-8) : '',
    '', '', 'N', '', textoCampo(f.ie, 25), '', '', '', '',
  ]);
}

function registroB(n: NotaEntrada, i: ItemEntrada): string {
  // 24 campos, como no exemplo. Grupo "1": o Questor tem o de-para de grupo de produtos
  // na própria tela de importação do SYN (F11).
  return linha([
    'B', cnpjFormatado(n.cnpjEmpresa), textoCampo(i.cProd, 15), '1', textoCampo(i.descricao, 40),
    soDigitos(i.ncm), textoCampo(i.unidade || 'UN', 10), tipoDoItem(i.cfop), 'N', '0',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '',
  ]);
}

function totaisDaNota(n: NotaEntrada) {
  const s = (k: keyof ItemEntrada) => n.itens.reduce((t, i) => t + Number(i[k] ?? 0), 0);
  return {
    valorContabil: s('valorContabil'), ipi: s('ipi'), desconto: s('desconto'),
    frete: s('frete'), seguro: s('seguro'), outras: s('outras'),
  };
}

function registroC(n: NotaEntrada): string {
  const t = totaisDaNota(n);
  const data = dataBr(n.dataEmissao);
  const campos = [
    'C', cnpjFormatado(n.cnpjEmpresa), cnpjFormatado(n.fornecedor.cnpj), soDigitos(n.numero), 'NFE',
    soDigitos(n.serie), '', data, data, data,
    num2(t.valorContabil), '0,00', num2(t.ipi), '0,00', num2(t.valorContabil - t.ipi), '0,00', '0,00', '0,00',
    '55', soDigitos(n.chave), '', '',
    num2(t.desconto), '0,00', num2(t.frete), '0,00', num2(t.seguro), num2(t.outras),
    'T', '0', /^[012]$/.test(n.indPag) ? n.indPag : '2', textoCampo(n.tPag || '99', 2), '0', '0',
    /^\d$/.test(n.modFrete) ? n.modFrete : '9', textoCampo(n.fornecedor.uf, 2),
  ];
  while (campos.length < 62) campos.push('');
  return linha(campos);
}

/** D: um por natureza e alíquota. Na regra "outras" (Simples), o valor contábil vai inteiro em Outras. */
function registrosD(n: NotaEntrada, regras: Map<string, RegraIcms>): string[] {
  const grupos = new Map<string, { natureza: string; aliq: number; vc: number; base: number; icms: number }>();
  for (const i of n.itens) {
    const outras = regras.get(i.cfop) === 'outras';
    const aliq = outras ? 0 : (n.icmsDoItem.get(i.nItem)?.aliquota ?? 0);
    const k = `${i.natureza}|${aliq}`;
    const g = grupos.get(k) ?? { natureza: i.natureza, aliq, vc: 0, base: 0, icms: 0 };
    g.vc += i.valorContabil;
    if (!outras) { g.base += i.baseIcms; g.icms += i.icms; }
    grupos.set(k, g);
  }
  return [...grupos.values()].map((g) => linha([
    'D', g.natureza, '1', num2(g.vc), num2(g.base), num2(g.aliq), num2(g.icms), '0,00',
    num2(Math.max(0, g.vc - g.base)), '0.00',
  ]));
}

function registroE(n: NotaEntrada, i: ItemEntrada, regras: Map<string, RegraIcms>): string {
  const outras = regras.get(i.cfop) === 'outras';
  const xml = n.icmsDoItem.get(i.nItem);
  const origem = (xml?.cst ?? '0').slice(0, 1) || '0';
  const cst = outras ? `${origem}90` : (xml?.cst ?? `${origem}90`);
  const base = outras ? 0 : i.baseIcms;
  const icms = outras ? 0 : i.icms;
  const aliq = outras ? 0 : (xml?.aliquota ?? 0);
  // 42 campos, na ordem do exemplo da documentação
  return linha([
    'E', String(i.nItem), i.natureza, textoCampo(i.cProd, 15), textoCampo(i.unidade || 'UN', 10),
    num6(i.quantidade), num2(i.valorUnitario), num2(i.valorProduto),
    cst, num2(base), num2(aliq), num2(icms), '0,00', num2(Math.max(0, i.valorContabil - base)),
    i.ipi > 0 ? '00' : '49', '0,00', '0,00', num2(i.ipi), '0,00', num2(i.valorContabil - i.ipi),
    '0', '0.00', '0.00', '0.00', '0.00', '0.00',
    '0', num2(i.baseSt), '0,00', num2(i.st), '0,00', '0,00',
    num2(i.desconto), num2(i.outras), '1', '0', num2(i.frete), '0,00', num2(i.seguro), '0,00', '1', '0,00',
  ]);
}

function registrosDuplicatas(n: NotaEntrada): string[] {
  if (!n.duplicatas.length) return [];
  const titulo = soDigitos(n.numero);
  return [
    linha(['G', '00', titulo]),
    ...n.duplicatas.map((d, k) => linha([
      'H', '00', titulo, textoCampo(d.numero || String(k + 1).padStart(3, '0'), 5), dataBr(d.vencimento), num2(d.valor),
    ])),
  ];
}

/** As linhas de uma nota (sem a linha em branco final). */
export function registrosDaNota(n: NotaEntrada, regras: Map<string, RegraIcms>): string[] {
  const produtos = new Map<string, ItemEntrada>();
  for (const i of n.itens) if (!produtos.has(i.cProd)) produtos.set(i.cProd, i);
  return [
    registroA(n),
    ...[...produtos.values()].map((i) => registroB(n, i)),
    registroC(n),
    ...registrosD(n, regras),
    ...n.itens.map((i) => registroE(n, i, regras)),
    ...registrosDuplicatas(n),
  ];
}

/** O arquivo inteiro: registros com CRLF e uma linha em branco no fim, como pede a documentação. */
export function montarEntradas200(notas: NotaEntrada[], regras: Map<string, RegraIcms>): string {
  return notas.flatMap((n) => registrosDaNota(n, regras)).join(CRLF) + CRLF + CRLF;
}

// ------------------------------------------------------------------ leitura do XML

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  trimValues: true,
  transformTagName: (tag) => (tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag),
});

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: unknown): string | null => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

/** O que o leiaute pede e o resto do sistema não guarda: endereço do fornecedor, pagamento, duplicatas, alíquota e CST de cada item. */
export function lerExtrasDoXml(xml: string): {
  fornecedor: Omit<NotaEntrada['fornecedor'], 'cnpj' | 'nome'> & { cnpj: string | null; nome: string | null };
  indPag: string; tPag: string; modFrete: string;
  duplicatas: NotaEntrada['duplicatas'];
  icmsDoItem: NotaEntrada['icmsDoItem'];
} {
  const doc = parser.parse(xml);
  const nfe = doc.nfeProc?.NFe ?? doc.NFe;
  const inf = nfe?.infNFe ?? {};
  const emit = inf.emit ?? {};
  const end = emit.enderEmit ?? {};
  const detPag = arr(inf.pag?.detPag)[0] ?? {};
  const icmsDoItem = new Map<number, { aliquota: number; cst: string }>();
  for (const det of arr(inf.det)) {
    const nItem = Number(det['@nItem']);
    const grupo = det.imposto?.ICMS ? Object.values(det.imposto.ICMS)[0] as Record<string, unknown> : undefined;
    if (!grupo) continue;
    const orig = txt(grupo.orig) ?? '0';
    const cst = txt(grupo.CST) ?? txt(grupo.CSOSN) ?? '90';
    icmsDoItem.set(nItem, { aliquota: Number(txt(grupo.pICMS) ?? 0) || 0, cst: `${orig}${cst}`.slice(0, 4) });
  }
  return {
    fornecedor: {
      cnpj: txt(emit.CNPJ), nome: txt(emit.xNome), uf: txt(end.UF), ie: txt(emit.IE),
      logradouro: txt(end.xLgr), numero: txt(end.nro), complemento: txt(end.xCpl), bairro: txt(end.xBairro),
      municipioIbge: txt(end.cMun), cep: txt(end.CEP), fone: txt(end.fone),
    },
    indPag: txt(detPag.indPag) ?? txt(inf.ide?.indPag) ?? '2',
    tPag: txt(detPag.tPag) ?? '99',
    modFrete: txt(inf.transp?.modFrete) ?? '9',
    duplicatas: arr(inf.cobr?.dup).map((d: any) => ({
      numero: txt(d.nDup) ?? '', vencimento: txt(d.dVenc) ?? '', valor: Number(txt(d.vDup) ?? 0) || 0,
    })),
    icmsDoItem,
  };
}
