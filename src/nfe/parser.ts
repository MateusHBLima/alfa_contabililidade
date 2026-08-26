import { XMLParser } from 'fast-xml-parser';
import { ErroParserNFe, type ItemNFe, type NotaFiscal } from './tipos';

/**
 * Leitor de NF-e (modelo 55).
 *
 * Aceita tanto o XML de autorizacao (`nfeProc`, com protocolo) quanto a NF-e crua (`NFe`).
 * O parser e usado SOMENTE para leitura. A geracao do XML corrigido nao passa por aqui
 * - ver serializer.ts e o comentario la sobre por que nao reserializamos.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false, // tudo string: evita 0110 virar 110 e 7.50 virar 7.5
  parseAttributeValue: false,
  trimValues: true,
  // A NF-e usa namespace default, mas alguns emissores mandam prefixo (ns0:, nfe:).
  // Removemos o prefixo para que o caminho de acesso seja sempre o mesmo.
  transformTagName: (tag) => (tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag),
});

type No = Record<string, any>;

function comoArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function texto(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function numero(v: unknown): number | null {
  const s = texto(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A tag do ICMS varia com o regime (ICMS00, ICMS60, ICMSSN102...). Achamos qual veio. */
function extrairCstIcms(imposto: No | undefined): string | null {
  const icms = imposto?.['ICMS'];
  if (!icms || typeof icms !== 'object') return null;
  for (const chave of Object.keys(icms)) {
    const grupo = icms[chave];
    if (grupo && typeof grupo === 'object') {
      const cst = texto(grupo['CST']) ?? texto(grupo['CSOSN']);
      if (cst) return cst;
    }
  }
  return null;
}

export function parseNFe(xml: string): NotaFiscal {
  let raiz: No;
  try {
    raiz = parser.parse(xml) as No;
  } catch (e) {
    throw new ErroParserNFe(`XML invalido: ${(e as Error).message}`);
  }

  const proc = raiz['nfeProc'];
  const nfe = proc?.['NFe'] ?? raiz['NFe'];
  if (!nfe) {
    throw new ErroParserNFe(
      'Nao encontrei o elemento NFe. O arquivo e uma NF-e modelo 55? (CT-e, NFS-e e NF3-e estao fora do escopo)',
    );
  }

  const infNFe = nfe['infNFe'];
  if (!infNFe) throw new ErroParserNFe('NFe sem infNFe.');

  // O Id vem como "NFe" + 44 digitos.
  const id = texto(infNFe['@Id']) ?? '';
  const chave = id.replace(/^NFe/i, '').replace(/\D/g, '');
  if (chave.length !== 44) {
    throw new ErroParserNFe(`Chave de acesso invalida (esperava 44 digitos, veio "${id}").`);
  }

  const ide = infNFe['ide'] ?? {};
  const modelo = texto(ide['mod']);
  if (modelo && modelo !== '55') {
    throw new ErroParserNFe(
      `Modelo ${modelo} fora do escopo. A plataforma trata NF-e modelo 55 (cláusula 1.2.3 do contrato).`,
    );
  }

  const dhEmi = texto(ide['dhEmi']) ?? texto(ide['dEmi']);
  const competencia = dhEmi ? dhEmi.slice(0, 7) : null;

  const emit = infNFe['emit'] ?? {};
  const emitCnpj = (texto(emit['CNPJ']) ?? texto(emit['CPF']) ?? '').replace(/\D/g, '');
  if (!emitCnpj) throw new ErroParserNFe('Nota sem CNPJ/CPF do emitente.');

  const dest = infNFe['dest'] ?? {};
  const total = infNFe['total']?.['ICMSTot'] ?? {};

  const dets = comoArray<No>(infNFe['det']);
  if (dets.length === 0) throw new ErroParserNFe('Nota sem itens (det).');

  const itens: ItemNFe[] = dets.map((det, i) => {
    const prod = det['prod'] ?? {};
    const nItem = Number(texto(det['@nItem']) ?? String(i + 1));
    const cfop = texto(prod['CFOP']);
    const xProd = texto(prod['xProd']);
    if (!cfop) throw new ErroParserNFe(`Item ${nItem} sem CFOP.`);
    if (!xProd) throw new ErroParserNFe(`Item ${nItem} sem xProd.`);

    // cEAN vem como "SEM GTIN" quando o produto nao tem codigo de barras.
    const ean = texto(prod['cEAN']);
    const eanValido = ean && /^\d{8,14}$/.test(ean) ? ean : null;

    return {
      nItem,
      cProd: texto(prod['cProd']),
      cEAN: eanValido,
      xProd,
      NCM: texto(prod['NCM']),
      CEST: texto(prod['CEST']),
      CFOP: cfop,
      uCom: texto(prod['uCom']),
      qCom: numero(prod['qCom']),
      vUnCom: numero(prod['vUnCom']),
      vProd: numero(prod['vProd']),
      cstIcms: extrairCstIcms(det['imposto']),
      temIbsCbs: det['imposto']?.['IBSCBS'] !== undefined,
    };
  });

  return {
    chave,
    numero: texto(ide['nNF']),
    serie: texto(ide['serie']),
    modelo,
    dhEmi,
    competencia,
    emit: {
      cnpj: emitCnpj,
      nome: texto(emit['xNome']),
      uf: texto(emit['enderEmit']?.['UF']),
    },
    dest: {
      cnpj: (texto(dest['CNPJ']) ?? texto(dest['CPF']) ?? '').replace(/\D/g, '') || null,
      nome: texto(dest['xNome']),
      uf: texto(dest['enderDest']?.['UF']),
    },
    vNF: numero(total['vNF']),
    protocolo: texto(proc?.['protNFe']?.['infProt']?.['nProt']),
    itens,
  };
}

/** SHA-256 do XML original, em hex. Prova de que o arquivo guardado e o que chegou. */
export async function hashXml(xml: string): Promise<string> {
  const bytes = new TextEncoder().encode(xml);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
