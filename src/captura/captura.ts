import { Repo, capturasVencidas, reservarCaptura, registrarBuscaCaptura } from '../db/repo';
import { importarArquivos } from '../nfe/importador';
import type { Sessao } from '../auth/permissoes';
import {
  URL_SEF_SC, OPERACAO_PADRAO, lerWsdl, montarPedido, montarEnvelope, lerRetorno, descompactar, abrirLote,
  documentoLimpo, esperaDepois, explicarCStat, EVENTOS_QUE_IMPORTAM, ErroSef, type Operacao, type Busca,
} from './sefsc';

/**
 * Busca automática de notas na SEF/SC (30/09/2026).
 *
 * Roda no cron (a cada 15 minutos). Em cada execução, consulta as empresas que já
 * podem ser consultadas, uma chamada por empresa, e para quando já trouxe um lote
 * cheio: 50 notas importadas cabem folgadas nos limites de uma execução do Worker
 * (~8 idas ao banco por nota, medido). O resto fica para a próxima execução.
 *
 * O certificado sai do cofre mTLS da Cloudflare: cada certificado vira um binding
 * `MTLS_<id no cofre, com _ no lugar de ->` no wrangler.jsonc. Certificado novo =
 * uma linha nova lá e uma publicação.
 */

export type AmbienteCaptura = {
  DB: D1Database;
  XML_ORIGINAL: R2Bucket;
  XML_TRABALHO: R2Bucket;
  AUDIT_SEED: string;
  [binding: string]: unknown;
};

export function nomeDoBinding(cloudflareId: string): string {
  return `MTLS_${cloudflareId.replace(/-/g, '_')}`;
}

/** O fetch que sai com o certificado, ou null se o certificado ainda não foi ligado no wrangler.jsonc. */
export function buscaComCertificado(env: AmbienteCaptura, cloudflareId: string): Busca | null {
  const b = env[nomeDoBinding(cloudflareId)] as { fetch?: Busca } | undefined;
  if (!b || typeof b.fetch !== 'function') return null;
  return (input, init) => b.fetch!(input, init);
}

/** O WSDL é lido uma vez por instância do Worker. */
let operacaoLida: Operacao | null = null;

export function esquecerOperacao(): void {
  operacaoLida = null;
}

/**
 * Lê o WSDL do serviço com o certificado. Serve de teste de conexão: se a SEF não
 * aceitar o certificado ou o TLS não fechar, dá erro aqui — sem gastar consulta.
 */
export async function descobrirOperacao(busca: Busca): Promise<{ operacao: Operacao; doWsdl: boolean }> {
  if (operacaoLida) return { operacao: operacaoLida, doWsdl: true };
  let r: Response;
  try {
    r = await busca(`${URL_SEF_SC}?WSDL`, { method: 'GET' });
  } catch (e) {
    throw new ErroSef(`não consegui conectar na SEF: ${e instanceof Error ? e.message : String(e)}`);
  }
  const texto = await r.text();
  if (!r.ok) throw new ErroSef(`a SEF respondeu ${r.status} ao pedir a descrição do serviço: ${texto.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  const op = lerWsdl(texto);
  if (op) operacaoLida = op;
  return { operacao: op ?? OPERACAO_PADRAO, doWsdl: !!op };
}

export async function consultarSef(busca: Busca, operacao: Operacao, pedido: string) {
  let r: Response;
  try {
    r = await busca(URL_SEF_SC, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${operacao.soapAction}"` },
      body: montarEnvelope(operacao, pedido),
    });
  } catch (e) {
    throw new ErroSef(`não consegui conectar na SEF: ${e instanceof Error ? e.message : String(e)}`);
  }
  return lerRetorno(await r.text());
}

export type ResumoExecucao = { consultadas: number; documentos: number; detalhes: string[] };

export async function executarCaptura(env: AmbienteCaptura, agora = new Date()): Promise<ResumoExecucao> {
  const agoraIso = agora.toISOString();
  const devidas = await capturasVencidas(env.DB, agoraIso, 10);
  const resumo: ResumoExecucao = { consultadas: 0, documentos: 0, detalhes: [] };
  for (const c of devidas) {
    if (resumo.consultadas >= 5 || resumo.documentos >= 50) break;
    if (!(await reservarCaptura(env.DB, c.empresa_id, agoraIso))) continue;
    resumo.consultadas++;
    const r = await buscarEmpresa(env, c, agora);
    resumo.documentos += r.documentos;
    resumo.detalhes.push(`${c.razao_social}: ${r.frase}`);
  }
  return resumo;
}

async function buscarEmpresa(env: AmbienteCaptura, c: any, agora: Date): Promise<{ documentos: number; frase: string }> {
  const quando = agora.toISOString();
  const base = {
    tenantId: c.tenant_id, empresaId: c.empresa_id, quando, ultNsu: null as string | null,
    nsuDe: c.ult_nsu as string, nsuAte: null as string | null,
    documentos: 0, importadas: 0, duplicadas: 0, eventos: 0, ignorados: 0, recusadas: 0, loteId: null as string | null,
  };
  const falhar = async (frase: string, cStat: string | null = null, motivo = '') => {
    const { ms } = esperaDepois(cStat, 0, (c.erros_seguidos ?? 0) + 1);
    await registrarBuscaCaptura(env.DB, {
      ...base, proxima: new Date(agora.getTime() + ms).toISOString(), cStat, motivo: motivo || frase, erro: frase,
    });
    return { documentos: 0, frase };
  };

  const cert = await env.DB
    .prepare('SELECT * FROM certificados WHERE tenant_id = ? AND id = ? AND removido_em IS NULL')
    .bind(c.tenant_id, c.certificado_id)
    .first<any>();
  if (!cert) return falhar('O certificado escolhido para esta empresa foi removido. Escolha outro na tela Captura SEF.', 'CERT');
  if (cert.valido_ate < quando) return falhar(`O certificado ${cert.nome} venceu em ${cert.valido_ate.slice(0, 10)}. Envie o novo.`, 'CERT');
  const busca = buscaComCertificado(env, cert.cloudflare_id);
  if (!busca) return falhar(`O certificado ${cert.nome} está no cofre mas ainda não foi ligado ao sistema. Fale com a Planee.`, 'CERT');

  const doc = documentoLimpo(c.cnpj);
  if (!doc) return falhar('CNPJ da empresa inválido no cadastro.', 'CNPJ');

  const u = await env.DB
    .prepare('SELECT id, tenant_id, email, nome, ativo FROM usuarios WHERE id = ?')
    .bind(c.ligada_por)
    .first<any>();
  if (!u || u.ativo !== 1) return falhar('Quem ligou a busca desta empresa não está mais ativo. Desligue e ligue de novo.', 'USUARIO');

  let operacao: Operacao;
  let ret;
  try {
    operacao = (await descobrirOperacao(busca)).operacao;
    ret = await consultarSef(busca, operacao, montarPedido(doc, c.ult_nsu || '0'));
  } catch (e) {
    esquecerOperacao();
    return falhar(e instanceof Error ? e.message : String(e));
  }

  const frase = explicarCStat(ret.cStat, ret.xMotivo);
  if (ret.cStat !== '118' && ret.cStat !== '117') {
    // NSU fora da janela de 3 meses: volta ao começo do que a SEF tem. As repetidas não entram de novo.
    if (ret.cStat === '632' || ret.cStat === '589') base.ultNsu = '0';
    return falhar(frase, ret.cStat, ret.xMotivo);
  }

  let docs: ReturnType<typeof abrirLote> = [];
  if (ret.cStat === '118' && ret.loteDistComp) {
    try {
      docs = abrirLote(await descompactar(ret.loteDistComp));
    } catch (e) {
      return falhar(`Não consegui abrir o lote que a SEF mandou: ${e instanceof Error ? e.message : String(e)}`, ret.cStat, ret.xMotivo);
    }
  }

  const sessao: Sessao = {
    usuarioId: u.id, tenantId: u.tenant_id, email: u.email, nome: u.nome,
    permissoes: new Set(['notas.importar', 'notas.visualizar']) as Sessao['permissoes'],
    empresas: new Set([c.empresa_id]), deveTrocarSenha: false,
  };
  const repo = new Repo(env.DB, { sessao, ip: null, requestId: `captura-sef-${crypto.randomUUID()}` }, env.AUDIT_SEED);

  const arquivos: { nome: string; conteudo: string }[] = [];
  for (const d of docs) {
    if (d.tipo === 'nota' || (d.tipo === 'evento' && d.tpEvento && EVENTOS_QUE_IMPORTAM.has(d.tpEvento))) {
      arquivos.push({ nome: `SEF-NSU${d.nsu}-${d.chave ?? 'sem-chave'}${d.tipo === 'evento' ? `-evento${d.tpEvento}` : ''}.xml`, conteudo: d.xml });
    } else {
      base.ignorados++;
    }
  }

  if (arquivos.length) {
    try {
      const r = await importarArquivos(repo, env.XML_ORIGINAL, c.empresa_id, arquivos, 'sefaz');
      Object.assign(base, {
        importadas: r.importadas, duplicadas: r.duplicadas, eventos: r.eventos, recusadas: r.recusadas, loteId: r.loteId,
      });
      // Nenhum arquivo some: o que a importação recusou fica guardado como veio.
      for (const a of r.arquivos.filter((x) => x.status === 'recusada')) {
        const orig = arquivos.find((x) => x.nome === a.arquivo);
        if (orig) await env.XML_TRABALHO.put(`captura/recusadas/${c.empresa_id}/${a.arquivo}`, orig.conteudo);
      }
    } catch (e) {
      // Não avança o NSU: na próxima busca o mesmo lote vem de novo.
      return falhar(`A SEF mandou ${docs.length} documento(s), mas a importação falhou: ${e instanceof Error ? e.message : String(e)}`, ret.cStat, ret.xMotivo);
    }
  }

  base.documentos = docs.length;
  base.ultNsu = ret.ultNuNSURet || (docs.length ? docs[docs.length - 1]!.nsu : null);
  base.nsuAte = base.ultNsu;
  const { ms } = esperaDepois(ret.cStat, docs.length, 0);
  await registrarBuscaCaptura(env.DB, {
    ...base, proxima: new Date(agora.getTime() + ms).toISOString(), cStat: ret.cStat, motivo: frase, erro: null,
  });
  return {
    documentos: docs.length,
    frase: ret.cStat === '118' ? `${base.importadas} nota(s) nova(s), ${base.duplicadas} já estavam, ${base.eventos} evento(s)` : frase,
  };
}

/** Botão "Testar conexão": só pede a descrição do serviço, não consulta nenhuma empresa. */
export async function testarConexao(env: AmbienteCaptura, cloudflareId: string): Promise<{ ok: boolean; detalhe: string }> {
  const busca = buscaComCertificado(env, cloudflareId);
  if (!busca) return { ok: false, detalhe: 'Este certificado está no cofre, mas ainda não foi ligado ao sistema (falta publicar a ligação). Fale com a Planee.' };
  esquecerOperacao();
  try {
    const { operacao, doWsdl } = await descobrirOperacao(busca);
    return {
      ok: true,
      detalhe: doWsdl
        ? `Conectou na SEF com o certificado. Serviço ${operacao.metodo} encontrado.`
        : 'Conectou na SEF com o certificado, mas a descrição do serviço veio diferente do esperado. A busca vai usar o formato padrão.',
    };
  } catch (e) {
    return { ok: false, detalhe: e instanceof Error ? e.message : String(e) };
  }
}
