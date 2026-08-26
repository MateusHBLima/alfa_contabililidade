import { parseNFe } from './parser';
import { ErroParserNFe } from './tipos';

/**
 * Gera o XML corrigido.
 *
 * DECISAO DE PROJETO, e talvez a mais importante deste arquivo:
 * NAO reserializamos o documento a partir da arvore do parser. Fazemos edicao
 * cirurgica no texto original, trocando apenas <xProd> e <CFOP> dentro de cada <det>.
 *
 * Motivo: reserializar reescreve o documento inteiro - ordem de atributos, prefixos de
 * namespace, tags vazias, espacos em branco. Nada disso muda o sentido fiscal, mas muda
 * os bytes, e ai fica impossivel provar depois que so mexemos no que dissemos que mexemos.
 * Com edicao cirurgica, um `diff` entre original e corrigido mostra exatamente as linhas
 * alteradas e nada mais.
 *
 * O XML ORIGINAL nunca e alterado - a assinatura do fornecedor seria invalidada.
 * O corrigido e copia de trabalho, para escrituracao e importacao.
 */

export type CorrecaoItem = {
  nItem: number;
  cfop?: string | null;
  xProd?: string | null;
};

export type ResultadoCorrecao = {
  xml: string;
  itensAlterados: number;
  camposAlterados: number;
};

function escaparXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Troca o conteudo da primeira ocorrencia de <tag>...</tag> no trecho. */
function trocarTag(trecho: string, tag: string, valor: string): { texto: string; mudou: boolean } {
  const re = new RegExp(`(<${tag}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${tag}>)`);
  const m = trecho.match(re);
  if (!m) return { texto: trecho, mudou: false };
  const atual = m[2] ?? '';
  const novo = escaparXml(valor);
  if (atual === novo) return { texto: trecho, mudou: false };
  return { texto: trecho.replace(re, `$1${novo}$3`), mudou: true };
}

export function gerarXmlCorrigido(xmlOriginal: string, correcoes: CorrecaoItem[]): ResultadoCorrecao {
  const porItem = new Map<number, CorrecaoItem>();
  for (const c of correcoes) porItem.set(c.nItem, c);

  let itensAlterados = 0;
  let camposAlterados = 0;
  let indiceImplicito = 0;

  const xml = xmlOriginal.replace(/<det\b[^>]*>[\s\S]*?<\/det>/g, (bloco) => {
    indiceImplicito += 1;
    const attr = bloco.match(/<det\b[^>]*\bnItem\s*=\s*"(\d+)"/);
    const nItem = attr?.[1] ? Number(attr[1]) : indiceImplicito;

    const correcao = porItem.get(nItem);
    if (!correcao) return bloco;

    let novoBloco = bloco;
    let mudouAlgo = false;

    if (correcao.xProd != null && correcao.xProd !== '') {
      const r = trocarTag(novoBloco, 'xProd', correcao.xProd);
      novoBloco = r.texto;
      if (r.mudou) {
        camposAlterados += 1;
        mudouAlgo = true;
      }
    }

    if (correcao.cfop != null && correcao.cfop !== '') {
      if (!/^\d{4}$/.test(correcao.cfop)) {
        throw new ErroParserNFe(`CFOP invalido no item ${nItem}: "${correcao.cfop}" (esperado 4 digitos).`);
      }
      const r = trocarTag(novoBloco, 'CFOP', correcao.cfop);
      novoBloco = r.texto;
      if (r.mudou) {
        camposAlterados += 1;
        mudouAlgo = true;
      }
    }

    if (mudouAlgo) itensAlterados += 1;
    return novoBloco;
  });

  return { xml, itensAlterados, camposAlterados };
}

// ------------------------------------------------------------------ invariantes

export type Invariante = { nome: string; ok: boolean; detalhe?: string };

/**
 * Confere que a correcao nao estragou a nota.
 * Roda em TODA exportacao. Se qualquer invariante falhar, a exportacao e bloqueada.
 */
export function verificarInvariantes(xmlOriginal: string, xmlCorrigido: string): Invariante[] {
  const antes = parseNFe(xmlOriginal);
  const depois = parseNFe(xmlCorrigido);
  const out: Invariante[] = [];

  const cmp = (nome: string, a: unknown, b: unknown) =>
    out.push({
      nome,
      ok: a === b,
      detalhe: a === b ? undefined : `antes=${String(a)} depois=${String(b)}`,
    });

  cmp('chave de acesso inalterada', antes.chave, depois.chave);
  cmp('numero da nota inalterado', antes.numero, depois.numero);
  cmp('serie inalterada', antes.serie, depois.serie);
  cmp('emitente inalterado', antes.emit.cnpj, depois.emit.cnpj);
  cmp('destinatario inalterado', antes.dest.cnpj, depois.dest.cnpj);
  cmp('valor total (vNF) preservado', antes.vNF, depois.vNF);
  cmp('protocolo de autorizacao preservado', antes.protocolo, depois.protocolo);
  cmp('quantidade de itens preservada', antes.itens.length, depois.itens.length);

  const soma = (n: typeof antes) =>
    Number(n.itens.reduce((acc, i) => acc + (i.vProd ?? 0), 0).toFixed(2));
  cmp('soma dos itens preservada', soma(antes), soma(depois));

  const divergenciasCst = antes.itens
    .filter((it, i) => it.cstIcms !== depois.itens[i]?.cstIcms)
    .map((it) => it.nItem);
  out.push({
    nome: 'CST/CSOSN inalterados',
    ok: divergenciasCst.length === 0,
    detalhe: divergenciasCst.length ? `itens ${divergenciasCst.join(', ')}` : undefined,
  });

  const divergenciasIbs = antes.itens
    .filter((it, i) => it.temIbsCbs !== depois.itens[i]?.temIbsCbs)
    .map((it) => it.nItem);
  out.push({
    nome: 'bloco IBS/CBS inalterado',
    ok: divergenciasIbs.length === 0,
    detalhe: divergenciasIbs.length ? `itens ${divergenciasIbs.join(', ')}` : undefined,
  });

  const divergenciasQtd = antes.itens
    .filter((it, i) => it.qCom !== depois.itens[i]?.qCom || it.vUnCom !== depois.itens[i]?.vUnCom)
    .map((it) => it.nItem);
  out.push({
    nome: 'quantidades e valores unitarios preservados',
    ok: divergenciasQtd.length === 0,
    detalhe: divergenciasQtd.length ? `itens ${divergenciasQtd.join(', ')}` : undefined,
  });

  // A assinatura do original nao vale mais no corrigido (e nem deveria valer);
  // o que checamos e que o bloco continua presente, para que o arquivo permaneca
  // rastreavel ao documento de origem.
  out.push({
    nome: 'bloco Signature preservado no corrigido',
    ok: xmlOriginal.includes('<Signature') === xmlCorrigido.includes('<Signature'),
  });

  return out;
}
