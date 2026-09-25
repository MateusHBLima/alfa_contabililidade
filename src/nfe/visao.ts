import { XMLParser } from 'fast-xml-parser';
import { ErroParserNFe } from './tipos';

/**
 * A nota original, legivel - para conferir o que o sistema leu contra o que o
 * fornecedor escreveu.
 *
 * POR QUE EXISTE. Pedido do Mateus em 17/09: "preciso conseguir abrir o XML
 * original, em uma visao facil de visualizar e comparar com o que o app esta
 * trazendo". Ate aqui o original so existia no R2; para duvidar de um valor na
 * tela era preciso ter o arquivo em maos e ler XML cru. Confianca num sistema que
 * le documento fiscal comeca por poder conferir a leitura.
 *
 * O QUE FAZ. Le o XML ORIGINAL guardado (nunca o corrigido, nunca o banco) e
 * devolve cabecalho, totais e itens num formato de tela - e, item a item, compara
 * com o que esta gravado no banco. Divergencia entre o XML e o banco NAO deveria
 * existir: se aparecer, e defeito de leitura, e a tela grita.
 *
 * So leitura. Invariante 1 intacta: o original nao e tocado.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  transformTagName: (tag) => (tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag),
});

type No = Record<string, any>;
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: unknown): string | null => {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim();
  return s.length ? s : null;
};
const num = (v: unknown): number | null => {
  const s = txt(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export type ParteDaNota = {
  nome: string | null;
  fantasia: string | null;
  doc: string | null;
  ie: string | null;
  endereco: string | null;
  municipio: string | null;
  uf: string | null;
};

export type ItemOriginal = {
  nItem: number;
  cProd: string | null;
  cEAN: string | null;
  xProd: string | null;
  NCM: string | null;
  CEST: string | null;
  CFOP: string | null;
  cst: string | null;
  uCom: string | null;
  qCom: number | null;
  vUnCom: number | null;
  vProd: number | null;
  vDesc: number | null;
  vFrete: number | null;
  vICMS: number | null;
  vICMSST: number | null;
  vIPI: number | null;
  /** Base, alíquota do ICMS e alíquota do IPI do item: para o DANFE (e, depois, a antecipação). */
  vBC?: number | null;
  pICMS?: number | null;
  pIPI?: number | null;
  infAdProd: string | null;
};

export type NotaOriginal = {
  chave: string | null;
  numero: string | null;
  serie: string | null;
  natOp: string | null;
  dhEmi: string | null;
  dhSaiEnt: string | null;
  tipo: string | null;
  finalidade: string | null;
  consumidorFinal: boolean;
  protocolo: string | null;
  dhProtocolo: string | null;
  situacao: string | null;
  emit: ParteDaNota;
  dest: ParteDaNota;
  totais: Record<string, number | null>;
  pagamentos: { forma: string; valor: number | null }[];
  infCpl: string | null;
  infAdFisco: string | null;
  itens: ItemOriginal[];
};

const FINALIDADE: Record<string, string> = { '1': 'Normal', '2': 'Complementar', '3': 'Ajuste', '4': 'Devolução' };
const FORMA_PAG: Record<string, string> = {
  '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito',
  '05': 'Crédito loja', '15': 'Boleto', '16': 'Depósito', '17': 'PIX', '90': 'Sem pagamento', '99': 'Outros',
};

function parte(n: No | undefined, end: string): ParteDaNota {
  const e: No = n?.[end] ?? {};
  const rua = [txt(e['xLgr']), txt(e['nro']), txt(e['xCpl']), txt(e['xBairro'])].filter(Boolean).join(', ');
  return {
    nome: txt(n?.['xNome']),
    fantasia: txt(n?.['xFant']),
    doc: txt(n?.['CNPJ']) ?? txt(n?.['CPF']),
    ie: txt(n?.['IE']),
    endereco: rua || null,
    municipio: txt(e['xMun']),
    uf: txt(e['UF']),
  };
}

/** Procura um valor dentro do grupo de imposto, qualquer que seja a variante (ICMS00, ICMSSN102...). */
function doGrupo(grupo: No | undefined, campo: string): string | null {
  if (!grupo || typeof grupo !== 'object') return null;
  for (const k of Object.keys(grupo)) {
    const g = grupo[k];
    if (g && typeof g === 'object') {
      const v = txt(g[campo]);
      if (v !== null) return v;
    }
  }
  return null;
}

export function lerNotaOriginal(xml: string): NotaOriginal {
  let raiz: No;
  try {
    raiz = parser.parse(xml) as No;
  } catch (e) {
    throw new ErroParserNFe(`XML invalido: ${(e as Error).message}`);
  }
  const proc = raiz['nfeProc'];
  const inf: No | undefined = (proc?.['NFe'] ?? raiz['NFe'])?.['infNFe'];
  if (!inf) throw new ErroParserNFe('Nao encontrei a NF-e dentro do arquivo guardado.');

  const ide: No = inf['ide'] ?? {};
  const tot: No = inf['total']?.['ICMSTot'] ?? {};
  const prot: No = proc?.['protNFe']?.['infProt'] ?? {};
  const id = txt(inf['@Id']);

  const itens = arr<No>(inf['det']).map((det) => {
    const p: No = det['prod'] ?? {};
    const imp: No = det['imposto'] ?? {};
    const ean = txt(p['cEAN']);
    return {
      nItem: Number(det['@nItem']),
      cProd: txt(p['cProd']),
      cEAN: ean && ean.toUpperCase() !== 'SEM GTIN' ? ean : null,
      xProd: txt(p['xProd']),
      NCM: txt(p['NCM']),
      CEST: txt(p['CEST']),
      CFOP: txt(p['CFOP']),
      cst: doGrupo(imp['ICMS'], 'CST') ?? doGrupo(imp['ICMS'], 'CSOSN'),
      uCom: txt(p['uCom']),
      qCom: num(p['qCom']),
      vUnCom: num(p['vUnCom']),
      vProd: num(p['vProd']),
      vDesc: num(p['vDesc']),
      vFrete: num(p['vFrete']),
      vICMS: num(doGrupo(imp['ICMS'], 'vICMS')),
      vICMSST: num(doGrupo(imp['ICMS'], 'vICMSST')),
      vIPI: num(doGrupo(imp['IPI'], 'vIPI')),
      vBC: num(doGrupo(imp['ICMS'], 'vBC')),
      pICMS: num(doGrupo(imp['ICMS'], 'pICMS')),
      pIPI: num(doGrupo(imp['IPI'], 'pIPI')),
      infAdProd: txt(det['infAdProd']),
    };
  });

  const totais: Record<string, number | null> = {};
  for (const k of ['vProd', 'vDesc', 'vFrete', 'vSeg', 'vOutro', 'vBC', 'vICMS', 'vBCST', 'vST', 'vFCPST', 'vIPI', 'vPIS', 'vCOFINS', 'vNF']) {
    totais[k] = num(tot[k]);
  }

  return {
    chave: id ? id.replace(/^NFe/, '') : null,
    numero: txt(ide['nNF']),
    serie: txt(ide['serie']),
    natOp: txt(ide['natOp']),
    dhEmi: txt(ide['dhEmi']) ?? txt(ide['dEmi']),
    dhSaiEnt: txt(ide['dhSaiEnt']),
    tipo: ide['tpNF'] === '0' ? 'Entrada' : ide['tpNF'] === '1' ? 'Saída' : null,
    finalidade: FINALIDADE[String(ide['finNFe'] ?? '')] ?? null,
    consumidorFinal: ide['indFinal'] === '1',
    protocolo: txt(prot['nProt']),
    dhProtocolo: txt(prot['dhRecbto']),
    situacao: txt(prot['xMotivo']),
    emit: parte(inf['emit'], 'enderEmit'),
    dest: parte(inf['dest'], 'enderDest'),
    totais,
    pagamentos: arr<No>(inf['pag']?.['detPag']).map((d) => ({
      forma: FORMA_PAG[String(d['tPag'] ?? '')] ?? `código ${txt(d['tPag']) ?? '?'}`,
      valor: num(d['vPag']),
    })),
    infCpl: txt(inf['infAdic']?.['infCpl']),
    infAdFisco: txt(inf['infAdic']?.['infAdFisco']),
    itens,
  };
}

// ------------------------------------------------------------------ comparacao

export type Divergencia = { campo: string; noXml: string; noApp: string };

export type ItemComparado = ItemOriginal & {
  /** o que o app guarda e mostra para este item; null = o app nao tem este item */
  app: {
    id: string; cfopEntrada: string | null; cfopOrigem: string | null;
    descricao: string | null; revisado: boolean;
  } | null;
  descricaoAlterada: boolean;
  divergencias: Divergencia[];
};

const igualNum = (a: number | null, b: unknown) => {
  const n = b == null ? null : Number(b);
  if (a === null || n === null || !Number.isFinite(n)) return a === n || (a === null && n === null);
  return Math.abs(a - n) < 0.00005;
};
const igualTxt = (a: string | null, b: unknown) => (a ?? '') === String(b ?? '').trim();

/**
 * Cruza os itens do XML com as linhas do banco, pelo numero do item.
 * So compara o que o app COPIA do XML (os campos "original"). CFOP de entrada e
 * descricao tratada sao decisao da contabilidade: diferem do XML por definicao, e
 * aparecem ao lado, nao como divergencia.
 */
export function compararComApp(nota: NotaOriginal, itensDoBanco: any[]): {
  itens: ItemComparado[];
  divergencias: number;
  soNoApp: number[];
} {
  const porNumero = new Map<number, any>(itensDoBanco.map((i) => [Number(i.n_item), i]));
  let total = 0;

  const itens = nota.itens.map((x) => {
    const b = porNumero.get(x.nItem);
    porNumero.delete(x.nItem);
    const div: Divergencia[] = [];
    if (!b) {
      div.push({ campo: 'item', noXml: 'existe', noApp: 'não existe no app' });
    } else {
      const t = (campo: string, a: string | null, v: unknown) => {
        if (!igualTxt(a, v)) div.push({ campo, noXml: a ?? '—', noApp: String(v ?? '—') });
      };
      const n = (campo: string, a: number | null, v: unknown) => {
        if (!igualNum(a, v)) div.push({ campo, noXml: a === null ? '—' : String(a), noApp: String(v ?? '—') });
      };
      t('descrição', x.xProd, b.x_prod_original);
      t('código', x.cProd, b.c_prod);
      t('EAN', x.cEAN, b.c_ean);
      t('NCM', x.NCM, b.ncm);
      t('CFOP', x.CFOP, b.cfop_original);
      t('unidade', x.uCom, b.unidade);
      n('quantidade', x.qCom, b.quantidade);
      n('valor unitário', x.vUnCom, b.valor_unitario);
      n('valor total', x.vProd, b.valor_total);
    }
    total += div.length;
    const descricao = b ? (String(b.x_prod_novo ?? '').trim() || null) : null;
    return {
      ...x,
      app: b
        ? {
            id: b.id, cfopEntrada: b.cfop_novo ?? null, cfopOrigem: b.cfop_origem ?? null,
            descricao, revisado: b.revisado === 1,
          }
        : null,
      descricaoAlterada: descricao !== null && descricao !== (x.xProd ?? ''),
      divergencias: div,
    };
  });

  const soNoApp = [...porNumero.keys()].sort((a, b) => a - b);
  return { itens, divergencias: total + soNoApp.length, soNoApp };
}
