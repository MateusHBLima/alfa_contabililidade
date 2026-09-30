import type { Repo } from '../db/repo';
import { importarArquivos, type ResultadoLote } from '../nfe/importador';
import {
  URL_SEF_SC, OPERACAO_PADRAO, lerWsdl, montarPedido, montarEnvelope, lerRetorno, descompactar, abrirLote,
  documentoLimpo, esperaDepois, explicarCStat, indiceDoDocumento, ErroSef, type Operacao, type Busca,
} from './sefsc';

/**
 * Busca de notas na SEF/SC, manual e por período (30/09/2026).
 *
 * A contadora escolhe o período e aperta "Buscar na SEF". O sistema:
 *   1. se a SEF já liberou esta empresa, baixa o que houver de novo (desde o último
 *      NSU) e guarda na CAIXA: XML no R2 de trabalho, índice em `captura_caixa`.
 *      Nada entra na lista de notas nessa hora.
 *   2. mostra as notas da caixa emitidas no período, dizendo quais já estão no sistema;
 *   3. importa só as que ela confirmar, 20 por vez, pelo importador de sempre.
 *
 * A SEF não filtra por data e, depois de entregar tudo, exige 12 horas até a próxima
 * consulta da mesma empresa. Por isso a caixa: um segundo período dentro das 12 horas
 * é atendido com o que já foi baixado, sem chamar a SEF.
 *
 * O certificado sai do cofre mTLS da Cloudflare: cada certificado vira um binding
 * `MTLS_<id no cofre, com _ no lugar de ->` no wrangler.jsonc.
 */

export type AmbienteCaptura = {
  DB: D1Database;
  XML_ORIGINAL: R2Bucket;
  XML_TRABALHO: R2Bucket;
  [binding: string]: unknown;
};

/** Até 6 lotes de 50 por clique: cabe folgado nos limites de uma requisição do Worker. */
export const LOTES_POR_CONSULTA = 6;

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

export type ResultadoDownload = {
  /** false: a SEF ainda não liberou esta empresa, usamos só o que já estava na caixa. */
  consultou: boolean;
  documentos: number;
  frase: string;
  erro: string | null;
  /** Parou no limite de lotes por clique: tem mais esperando na SEF. */
  temMais: boolean;
  liberadaEm: string | null;
};

/**
 * Baixa da SEF o que houver de novo para a empresa e guarda na caixa.
 * Não importa nada. Quem chama já conferiu a permissão de importar.
 */
export async function baixarDaSef(
  env: AmbienteCaptura, repo: Repo, empresa: { id: string; cnpj: string },
  cert: { id: string; nome: string; cloudflare_id: string; valido_ate: string }, agora = new Date(),
): Promise<ResultadoDownload> {
  const quando = agora.toISOString();
  const estado = await repo.estadoSef(empresa.id);
  const semConsulta = (frase: string, erro: string | null = null): ResultadoDownload =>
    ({ consultou: false, documentos: 0, frase, erro, temMais: false, liberadaEm: estado?.proxima_consulta ?? null });

  // O que se resolve sem chamar a SEF vem antes, e não gasta a liberação.
  if (cert.valido_ate < quando) return semConsulta('', `O certificado ${cert.nome} venceu em ${cert.valido_ate.slice(0, 10).split('-').reverse().join('/')}. Envie o novo na tela Certificados.`);
  const busca = buscaComCertificado(env, cert.cloudflare_id);
  if (!busca) return semConsulta('', `O certificado ${cert.nome} está no cofre, mas ainda não foi ligado ao sistema. Fale com a Planee.`);
  const doc = documentoLimpo(empresa.cnpj);
  if (!doc) return semConsulta('', 'O CNPJ desta empresa está inválido no cadastro.');

  if (!(await repo.reservarConsultaSef(empresa.id, cert.id, quando))) {
    const depois = await repo.estadoSef(empresa.id);
    return { ...semConsulta('A SEF só libera uma nova consulta desta empresa depois do horário abaixo. Mostrando o que já foi baixado.'), liberadaEm: depois?.proxima_consulta ?? null };
  }

  let nsu: string = estado?.ult_nsu || '0';
  const nsuDe = nsu;
  let documentos = 0;
  let ultimo: { cStat: string; xMotivo: string; qtd: number } | null = null;
  let erro: string | null = null;
  try {
    const { operacao } = await descobrirOperacao(busca);
    for (let lote = 0; lote < LOTES_POR_CONSULTA; lote++) {
      const ret = await consultarSef(busca, operacao, montarPedido(doc, nsu));
      if (ret.cStat !== '118' && ret.cStat !== '117') {
        ultimo = { cStat: ret.cStat, xMotivo: ret.xMotivo, qtd: 0 };
        // NSU fora da janela de 3 meses: na próxima, volta ao começo do que a SEF tem.
        if (ret.cStat === '632' || ret.cStat === '589') nsu = '0';
        erro = explicarCStat(ret.cStat, ret.xMotivo);
        break;
      }
      const docs = ret.cStat === '118' && ret.loteDistComp ? abrirLote(await descompactar(ret.loteDistComp)) : [];
      const guardar = [];
      for (const d of docs) {
        const r2Chave = `sef/${repo.contexto.sessao.tenantId}/${empresa.id}/${d.nsu}.xml`;
        await env.XML_TRABALHO.put(r2Chave, d.xml);
        guardar.push({ nsu: d.nsu, tipo: d.tipo, tpEvento: d.tpEvento, r2Chave, ...indiceDoDocumento(d) });
      }
      await repo.guardarNaCaixa(empresa.id, guardar);
      documentos += docs.length;
      nsu = ret.ultNuNSURet || (docs.length ? docs[docs.length - 1]!.nsu : nsu);
      ultimo = { cStat: ret.cStat, xMotivo: ret.xMotivo, qtd: docs.length };
      if (ret.cStat !== '118' || docs.length < 50) break;
    }
  } catch (e) {
    esquecerOperacao();
    erro = e instanceof Error ? e.message : String(e);
  }

  const temMais = !erro && ultimo?.cStat === '118' && ultimo.qtd >= 50;
  // Sem resposta da SEF (rede, TLS): libera de novo em 10 minutos. Com resposta, a regra da SEF.
  const ms = !ultimo ? 10 * 60_000 : esperaDepois(ultimo.cStat, ultimo.qtd, 0).ms;
  const proxima = new Date(agora.getTime() + ms).toISOString();
  const frase = erro ?? (documentos ? `A SEF mandou ${documentos} documento(s) novo(s).` : 'Nada novo na SEF desde a última consulta.');
  await repo.registrarConsultaSef(empresa.id, {
    quando, proxima, cStat: ultimo?.cStat ?? null, motivo: frase, erro,
    ultNsu: nsu, nsuDe, documentos,
  });
  return {
    consultou: true, documentos, erro, temMais, liberadaEm: proxima,
    frase: temMais ? `${frase} Ainda tem mais na SEF: consulte de novo para baixar o resto.` : frase,
  };
}

async function lerDaCaixa(env: AmbienteCaptura, r2Chave: string): Promise<string | null> {
  const o = await env.XML_TRABALHO.get(r2Chave);
  return o ? await o.text() : null;
}

/**
 * Cancelamentos e cartas de correção da caixa cuja nota já está no sistema: aplica.
 * Roda depois de cada download e de cada importação, então a nota importada hoje
 * recebe o cancelamento que chegou junto.
 */
export async function aplicarEventosDaCaixa(env: AmbienteCaptura, repo: Repo, empresaId: string): Promise<number> {
  const pendentes = await repo.eventosPendentesDaCaixa(empresaId);
  if (!pendentes.length) return 0;
  const arquivos = [];
  for (const e of pendentes) {
    const xml = await lerDaCaixa(env, e.r2_chave);
    if (xml) arquivos.push({ nome: `SEF-NSU${e.nsu}-${e.chave}-evento${e.tp_evento}.xml`, conteudo: xml });
  }
  if (arquivos.length) await importarArquivos(repo, env.XML_ORIGINAL, empresaId, arquivos, 'sefaz');
  await repo.marcarEventosAplicados(empresaId, pendentes.map((e) => e.nsu));
  return pendentes.filter((e) => e.tp_evento !== '110110').length;
}

/** Importa as notas escolhidas da caixa (até 20 por chamada), como um envio de XML. */
export async function importarDaCaixa(
  env: AmbienteCaptura, repo: Repo, empresaId: string, chaves: string[], envioId: string | null,
): Promise<ResultadoLote & { canceladas: number }> {
  const linhas = await repo.notasDaCaixaPorChave(empresaId, chaves);
  const arquivos = [];
  for (const l of linhas) {
    const xml = await lerDaCaixa(env, l.r2_chave);
    arquivos.push({ nome: `SEF-NSU${l.nsu}-${l.chave}.xml`, conteudo: xml ?? '' });
  }
  const r = await importarArquivos(repo, env.XML_ORIGINAL, empresaId, arquivos, 'sefaz', envioId);
  const canceladas = await aplicarEventosDaCaixa(env, repo, empresaId);
  return { ...r, canceladas };
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
