/**
 * Cliente do Web Service de Download de NF-e da SEF/SC (30/09/2026).
 *
 * Fonte: Boletim Técnico SC-2026-003 v2.02-1 e os XSD que vêm com ele
 * (distNFeSC, retDistNFeSC, loteDistNFeSC). Resumo em claude/captura-sef-sc.md.
 *
 * Aqui só tem o que não depende de banco: montar o pedido, ler a resposta, abrir o
 * lote compactado e decidir quanto tempo esperar. A agenda e a importação ficam em
 * captura.ts.
 *
 * O certificado NÃO passa por aqui: quem chama entrega um `fetch` que já sai com o
 * certificado do cofre mTLS da Cloudflare (binding `mtls_certificates`).
 */

export const URL_SEF_SC = 'https://satnfe.sef.sc.gov.br/ws/distribuicao/nfedownloadV2.asmx';
export const NS_DIST = 'http://www.satnfe.sef.sc.gov.br/ws/distribuicao-v2';
export const VER_APLIC = 'AlfaFiscal 1.0';

/** Destinatário: só as notas em que a empresa é quem recebe. */
export const IND_ATOR_DESTINATARIO = 2;

export type Busca = (input: string, init?: RequestInit) => Promise<Response>;

/** Como o serviço quer ser chamado. Vem do WSDL; o padrão é o que o fórum do ACBr mostra para a v1. */
export type Operacao = {
  namespace: string;
  metodo: string;
  soapAction: string;
  parametro: string;
  /** O parâmetro é texto (XML escapado) em vez de XML dentro do envelope. */
  parametroTexto: boolean;
};

export const OPERACAO_PADRAO: Operacao = {
  namespace: NS_DIST,
  metodo: 'NfeDownloadContab',
  soapAction: `${NS_DIST}/NfeDownloadContab`,
  parametro: 'pXml',
  parametroTexto: false,
};

/**
 * Lê do WSDL (ASMX) o nome da operação, o SOAPAction, o namespace e o parâmetro.
 * Devolve null se não achar a operação de download do contabilista.
 */
export function lerWsdl(wsdl: string): Operacao | null {
  const acoes = [...wsdl.matchAll(/<(?:\w+:)?operation\b[^>]*\bsoapAction="([^"]*DownloadContab[^"]*)"/gi)];
  if (!acoes.length) return null;
  const soapAction = acoes[0]![1]!;
  // O nome da operação é o que vem depois da última barra do soapAction; confere com
  // um <operation name="..."> do WSDL para não inventar.
  const candidato = soapAction.split('/').pop() ?? '';
  const nomes = [...wsdl.matchAll(/<(?:\w+:)?operation\s+name="([^"]+)"/gi)].map((m) => m[1]!);
  const metodo = nomes.find((n) => n.toLowerCase() === candidato.toLowerCase())
    ?? nomes.find((n) => /downloadcontab/i.test(n));
  if (!metodo) return null;

  const tns = wsdl.match(/<(?:\w+:)?definitions\b[^>]*\btargetNamespace="([^"]+)"/i)?.[1]
    ?? soapAction.slice(0, soapAction.length - candidato.length - 1);

  // <s:element name="NfeDownloadContab"><s:complexType><s:sequence><s:element ... name="pXml" type="s:string"/>
  let parametro = OPERACAO_PADRAO.parametro;
  let parametroTexto = false;
  const ini = wsdl.search(new RegExp(`<(?:\\w+:)?element\\s+name="${metodo}"`, 'i'));
  if (ini >= 0) {
    const resto = wsdl.slice(ini + 10);
    const fim = resto.search(/<\/(?:\w+:)?complexType>/i);
    const bloco = fim >= 0 ? resto.slice(0, fim) : resto.slice(0, 2000);
    const el = bloco.match(/<(?:\w+:)?element\b([^>]*)>/i);
    const nome = el?.[1]?.match(/\bname="([^"]+)"/)?.[1];
    if (nome) {
      parametro = nome;
      parametroTexto = /\btype="[^"]*:?string"/i.test(el![1]!);
    }
  }
  return { namespace: tns, metodo, soapAction, parametro, parametroTexto };
}

function escaparXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function desescaparXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** CNPJ (14, pode ser alfanumérico) ou CPF (11), só letras e números. */
export function documentoLimpo(doc: string): { tag: 'CNPJ' | 'CPF'; valor: string } | null {
  const v = (doc ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (v.length === 14) return { tag: 'CNPJ', valor: v };
  if (v.length === 11 && /^\d+$/.test(v)) return { tag: 'CPF', valor: v };
  return null;
}

/**
 * O pedido, sem espaço nem quebra de linha entre as tags (rejeição 588) e sem
 * prefixo de namespace (404).
 */
export function montarPedido(doc: { tag: 'CNPJ' | 'CPF'; valor: string }, ultNsu: string): string {
  return `<distNFeSC versao="2.00" xmlns="${NS_DIST}">`
    + '<tpAmb>1</tpAmb>'
    + `<verAplic>${VER_APLIC}</verAplic>`
    + '<cUF>42</cUF>'
    + `<${doc.tag}>${doc.valor}</${doc.tag}>`
    + `<solRel><indXML>1</indXML><indAtor>${IND_ATOR_DESTINATARIO}</indAtor><ultNuNSU>${ultNsu || '0'}</ultNuNSU></solRel>`
    + '</distNFeSC>';
}

export function montarEnvelope(op: Operacao, pedido: string): string {
  const corpo = op.parametroTexto ? escaparXml(pedido) : pedido;
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
    + `<soap:Body><${op.metodo} xmlns="${op.namespace}"><${op.parametro}>${corpo}</${op.parametro}></${op.metodo}></soap:Body>`
    + '</soap:Envelope>';
}

export type Retorno = {
  cStat: string;
  xMotivo: string;
  ultNuNSURet: string | null;
  qtDfeRet: number | null;
  loteDistComp: string | null;
};

function tag(xml: string, nome: string): string | null {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`));
  return m ? m[1]!.trim() : null;
}

export class ErroSef extends Error {
  constructor(msg: string) { super(msg); this.name = 'ErroSef'; }
}

/** Lê o retDistNFeSC, venha ele dentro do envelope como XML ou como texto escapado. */
export function lerRetorno(resposta: string): Retorno {
  let xml = resposta;
  if (!/<(?:\w+:)?retDistNFeSC[\s>]/.test(xml) && /&lt;(?:\w+:)?retDistNFeSC/.test(xml)) {
    xml = desescaparXml(xml);
  }
  const ret = tag(xml, 'retDistNFeSC');
  if (ret === null) {
    const falha = tag(resposta, 'faultstring') ?? tag(resposta, 'Text') ?? tag(resposta, 'Reason');
    if (falha) throw new ErroSef(`a SEF recusou a chamada: ${desescaparXml(falha).slice(0, 300)}`);
    throw new ErroSef(`resposta inesperada da SEF: ${resposta.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  const cStat = tag(ret, 'cStat');
  if (!cStat) throw new ErroSef('a SEF respondeu sem código de situação (cStat)');
  const qt = tag(ret, 'qtDfeRet');
  return {
    cStat,
    xMotivo: tag(ret, 'xMotivo') ?? '',
    ultNuNSURet: tag(ret, 'ultNuNSURet'),
    qtDfeRet: qt !== null && qt !== '' ? Number(qt) : null,
    loteDistComp: tag(ret, 'loteDistComp')?.replace(/\s+/g, '') || null,
  };
}

export async function descompactar(base64: string): Promise<string> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const fluxo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(fluxo).text();
}

export type DocumentoDistribuido = {
  nsu: string;
  chave: string | null;
  tipo: 'nota' | 'evento' | 'outro';
  /** tpEvento, quando é evento. */
  tpEvento: string | null;
  xml: string;
};

const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';

/** Separa o loteDistNFeSC em documentos, cada um como um arquivo XML independente. */
export function abrirLote(lote: string): DocumentoDistribuido[] {
  const nsLote = lote.match(/<(?:\w+:)?loteDistNFeSC\b[^>]*\bxmlns="([^"]+)"/)?.[1] ?? null;
  const docs: DocumentoDistribuido[] = [];
  const re = /<(?:\w+:)?distNFeSC\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?distNFeSC>)/g;
  for (const m of lote.matchAll(re)) {
    const attrs = m[1] ?? '';
    const nsu = attrs.match(/\bNSU="([^"]*)"/)?.[1] ?? '';
    const chave = attrs.match(/\bchAcesso="([^"]*)"/)?.[1] ?? null;
    let xml = (m[2] ?? '').trim().replace(/^<\?xml[^>]*\?>\s*/, '');
    const raiz = xml.match(/^<(?:\w+:)?(\w+)/)?.[1] ?? '';
    const tipo = raiz === 'nfeProc' || raiz === 'NFe' ? 'nota' : raiz === 'procEventoNFe' ? 'evento' : 'outro';
    // Se o namespace da NF-e veio declarado só na raiz do lote, a nota precisa dele
    // na própria raiz para continuar sendo o documento que foi assinado.
    if (xml && !/^<[^>]*\bxmlns=/.test(xml) && (nsLote === NS_NFE)) {
      xml = xml.replace(/^<((?:\w+:)?\w+)/, `<$1 xmlns="${NS_NFE}"`);
    }
    const tpEvento = tipo === 'evento' ? (xml.match(/<(?:\w+:)?tpEvento>(\d+)</)?.[1] ?? null) : null;
    docs.push({
      nsu, chave, tipo, tpEvento,
      xml: xml ? `<?xml version="1.0" encoding="UTF-8"?>${xml}` : '',
    });
  }
  return docs;
}

/** Cancelamento (110111), cancelamento por substituição (110112) e carta de correção (110110). */
export const EVENTOS_QUE_IMPORTAM = new Set(['110111', '110112', '110110']);

const HORA = 3600_000;

/**
 * Quanto esperar até a próxima consulta desta empresa. As regras são da SEF
 * (item 03.2 e 03.4 do boletim); desrespeitar dá bloqueio 657 e pode suspender o
 * serviço para o escritório inteiro.
 */
export function esperaDepois(cStat: string | null, documentos: number, errosSeguidos: number): { ms: number; erro: boolean } {
  switch (cStat) {
    case '118': return documentos >= 50 ? { ms: 0, erro: false } : { ms: 12 * HORA, erro: false };
    case '117': return { ms: 12 * HORA, erro: false };
    case '110': case '108': return { ms: 1 * HORA, erro: false };
    case '109': return { ms: 6 * HORA, erro: true };
    case '657': return { ms: 12 * HORA, erro: true };
    case null:
      // Sem resposta da SEF (rede, TLS): tenta de novo em 1 hora, e espaça depois de 3 falhas.
      return { ms: (errosSeguidos >= 3 ? 12 : 1) * HORA, erro: true };
    default:
      // Rejeição (certificado, vínculo do contabilista, CNPJ): não adianta insistir.
      return { ms: 12 * HORA, erro: true };
  }
}

/** Frase para a tela, a partir do código da SEF. */
export function explicarCStat(cStat: string, xMotivo: string): string {
  const m: Record<string, string> = {
    '117': 'Nada novo na SEF.',
    '118': 'Notas recebidas.',
    '110': 'A SEF está reprocessando; tenta de novo em 1 hora.',
    '108': 'Serviço da SEF parado por pouco tempo; tenta de novo em 1 hora.',
    '109': 'Serviço da SEF parado sem previsão.',
    '657': 'A SEF bloqueou por excesso de tentativas; espera 12 horas.',
    '8002': 'O dono do certificado não está cadastrado na SEF como contabilista desta empresa.',
    '280': 'A SEF não aceitou o certificado.',
    '281': 'Certificado vencido para a SEF.',
    '284': 'Certificado revogado.',
    '285': 'Certificado não é ICP-Brasil.',
    '489': 'CNPJ/CPF da empresa inválido para a SEF.',
  };
  return m[cStat] ?? `${cStat} — ${xMotivo || 'sem descrição'}`;
}
