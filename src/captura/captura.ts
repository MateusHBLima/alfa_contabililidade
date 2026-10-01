import { Repo, buscasAutomaticasVencidas, usuarioDaBuscaAutomatica } from '../db/repo';
import { resolverPermissoes, podeVerEmpresa, type Sessao } from '../auth/permissoes';
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

/**
 * Um lote (até 50 documentos) por requisição. Se a SEF disser que tem mais, a tela
 * chama de novo na hora e mostra quantos já vieram: cada requisição fica curta e a
 * pessoa vê a contagem andando em vez de uma espera muda.
 */
export const LOTES_POR_CONSULTA = 1;

export function nomeDoBinding(cloudflareId: string): string {
  return `MTLS_${cloudflareId.replace(/-/g, '_')}`;
}

/** O certificado como a busca precisa dele: onde está guardado e com que id. */
export type CertParaBusca = { id: string; cloudflare_id: string; guardado_em?: string | null };

/**
 * O intermediário (01/10): serviço em Node na VPS da Planee que fala com a SEF.
 * Existe porque a SEF pede o certificado por renegociação TLS, e o fetch da
 * Cloudflare não renegocia. Configuração: SEF_PONTE_URL (variável) e
 * SEF_PONTE_TOKEN (segredo). Código em relay/relay.mjs.
 */
export function ponteConfigurada(env: AmbienteCaptura): { url: string; token: string } | null {
  const url = typeof env.SEF_PONTE_URL === 'string' ? env.SEF_PONTE_URL.replace(/\/+$/, '') : '';
  const token = typeof env.SEF_PONTE_TOKEN === 'string' ? env.SEF_PONTE_TOKEN : '';
  return url && token ? { url, token } : null;
}

/** O fetch que sai com o certificado, ou null se o certificado não está pronto para a busca. */
export function buscaComCertificado(env: AmbienteCaptura, cert: CertParaBusca): Busca | null {
  if (cert.guardado_em === 'ponte') {
    const p = ponteConfigurada(env);
    if (!p) return null;
    return (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${p.token}`);
      // O intermediário só fala com a URL fixa da SEF; daqui vai só a consulta (?WSDL).
      return fetch(`${p.url}/sef/${encodeURIComponent(cert.id)}${new URL(input).search}`, {
        method: init?.method ?? 'GET', headers, body: init?.body,
      });
    };
  }
  const b = env[nomeDoBinding(cert.cloudflare_id)] as { fetch?: Busca } | undefined;
  if (!b || typeof b.fetch !== 'function') return null;
  return (input, init) => b.fetch!(input, init);
}

/** Manda certificado e chave (PEM) para o intermediário, que guarda cifrado. */
export async function enviarParaPonte(env: AmbienteCaptura, id: string, pem: { certificados: string; chave: string }): Promise<void> {
  const p = ponteConfigurada(env);
  if (!p) throw new ErroSef('o intermediário da busca na SEF ainda não foi configurado');
  let r: Response;
  try {
    r = await fetch(`${p.url}/certificados/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cert: pem.certificados, key: pem.chave }),
    });
  } catch (e) {
    throw new ErroSef(`não consegui falar com o intermediário: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!r.ok) throw new ErroSef(`o intermediário recusou o certificado (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

export async function removerDaPonte(env: AmbienteCaptura, id: string): Promise<void> {
  const p = ponteConfigurada(env);
  if (!p) return;
  const r = await fetch(`${p.url}/certificados/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${p.token}` },
  });
  if (!r.ok) throw new ErroSef(`o intermediário não apagou o certificado (${r.status})`);
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
  /** O certificado que a SEF aceitou nesta consulta (e que fica gravado para a empresa). */
  certificado?: string | null;
};

export type CertCandidato = CertParaBusca & { nome: string; valido_ate: string };

/**
 * Baixa da SEF o que houver de novo para a empresa e guarda na caixa.
 * Não importa nada. Quem chama já conferiu a permissão de importar.
 *
 * `certs` vem em ordem de preferência: o que já funcionou para esta empresa primeiro.
 * Se a SEF recusar um por vínculo (8002: o titular não é contabilista desta empresa),
 * tenta o próximo na mesma hora. Uma recusa por vínculo não é consulta repetida.
 */
export async function baixarDaSef(
  env: AmbienteCaptura, repo: Repo, empresa: { id: string; cnpj: string },
  certs: CertCandidato[], agora = new Date(),
): Promise<ResultadoDownload> {
  const quando = agora.toISOString();
  const estado = await repo.estadoSef(empresa.id);
  const semConsulta = (frase: string, erro: string | null = null): ResultadoDownload =>
    ({ consultou: false, documentos: 0, frase, erro, temMais: false, liberadaEm: estado?.proxima_consulta ?? null });

  // O que se resolve sem chamar a SEF vem antes, e não gasta a liberação.
  const prontos: { cert: CertCandidato; busca: Busca }[] = [];
  let motivo = '';
  for (const cert of certs) {
    const busca = buscaComCertificado(env, cert);
    if (cert.valido_ate < quando) motivo ||= `O certificado ${cert.nome} venceu em ${cert.valido_ate.slice(0, 10).split('-').reverse().join('/')}. Envie o novo na tela Certificados.`;
    else if (!busca) {
      motivo ||= cert.guardado_em === 'ponte'
        ? 'O intermediário da busca na SEF não está configurado no sistema. Fale com a Planee.'
        : `O certificado ${cert.nome} está no cofre da Cloudflare, que não serve para a SEF. Envie o .pfx de novo em Administração › Certificados.`;
    } else prontos.push({ cert, busca });
  }
  if (!prontos.length) return semConsulta('', motivo || 'Nenhum certificado no cofre. Envie o A1 em Administração › Certificados.');
  const doc = documentoLimpo(empresa.cnpj);
  if (!doc) return semConsulta('', 'O CNPJ desta empresa está inválido no cadastro.');

  if (!(await repo.reservarConsultaSef(empresa.id, prontos[0]!.cert.id, quando))) {
    const depois = await repo.estadoSef(empresa.id);
    return { ...semConsulta('A SEF só libera uma nova consulta desta empresa depois do horário abaixo. Mostrando o que já foi baixado.'), liberadaEm: depois?.proxima_consulta ?? null };
  }

  let nsu: string = estado?.ult_nsu || '0';
  const nsuDe = nsu;
  let documentos = 0;
  let ultimo: { cStat: string; xMotivo: string; qtd: number } | null = null;
  let erro: string | null = null;
  let aceito: CertCandidato | null = null;
  const recusados: string[] = [];
  try {
    for (let lote = 0; lote < LOTES_POR_CONSULTA; lote++) {
      let ret: Awaited<ReturnType<typeof consultarSef>> | null = null;
      // No primeiro lote, procura o certificado que a SEF aceita para esta empresa.
      const aceitoId: string | null = aceito ? (aceito as CertCandidato).id : null;
      const tentar: { cert: CertCandidato; busca: Busca }[] = aceitoId ? prontos.filter((x) => x.cert.id === aceitoId) : prontos;
      for (const p of tentar) {
        const { operacao } = await descobrirOperacao(p.busca);
        ret = await consultarSef(p.busca, operacao, montarPedido(doc, nsu));
        if (ret.cStat === '8002' && !aceito) { recusados.push(p.cert.nome); continue; }
        if (ret.cStat === '118' || ret.cStat === '117') aceito = p.cert;
        break;
      }
      if (!ret) break;
      if (ret.cStat !== '118' && ret.cStat !== '117') {
        ultimo = { cStat: ret.cStat, xMotivo: ret.xMotivo, qtd: 0 };
        // NSU fora da janela de 3 meses: na próxima, volta ao começo do que a SEF tem.
        if (ret.cStat === '632' || ret.cStat === '589') nsu = '0';
        erro = ret.cStat === '8002' && recusados.length > 1
          ? `Nenhum dos certificados guardados (${recusados.join(', ')}) está cadastrado na SEF como contabilista desta empresa.`
          : explicarCStat(ret.cStat, ret.xMotivo);
        break;
      }
      const docs = ret.cStat === '118' && ret.loteDistComp ? abrirLote(await descompactar(ret.loteDistComp)) : [];
      // O lote inteiro vai para o R2 num arquivo só (01/10): eram 50 gravações por lote, e
      // o Worker só abre 6 conexões ao mesmo tempo — eram uns 8 s por lote só nisso.
      const r2Chave = `sef/${repo.contexto.sessao.tenantId}/${empresa.id}/lote-${docs[0]?.nsu ?? nsu}-${docs.at(-1)?.nsu ?? nsu}.json`;
      if (docs.length) await env.XML_TRABALHO.put(r2Chave, JSON.stringify(Object.fromEntries(docs.map((d) => [d.nsu, d.xml]))));
      const guardar = docs.map((d) => ({ nsu: d.nsu, tipo: d.tipo, tpEvento: d.tpEvento, r2Chave, ...indiceDoDocumento(d) }));
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
    certificadoAceito: aceito?.id ?? null,
    nenhumVinculado: !aceito && ultimo?.cStat === '8002' && recusados.length === prontos.length,
  });
  return { consultou: true, documentos, erro, temMais, liberadaEm: proxima, frase, certificado: aceito?.nome ?? null };
}

/**
 * O XML de um documento da caixa. Desde 01/10 cada lote é um arquivo JSON {nsu: xml};
 * antes era um .xml por documento (os da primeira busca da ITALIANA ficaram assim).
 * `lidos` guarda os lotes já abertos nesta requisição: 20 notas do mesmo lote = 1 leitura.
 */
async function lerDaCaixa(env: AmbienteCaptura, r2Chave: string, nsu: string, lidos: Map<string, Record<string, string> | null>): Promise<string | null> {
  if (r2Chave.endsWith('.xml')) {
    const o = await env.XML_TRABALHO.get(r2Chave);
    return o ? await o.text() : null;
  }
  if (!lidos.has(r2Chave)) {
    const o = await env.XML_TRABALHO.get(r2Chave);
    lidos.set(r2Chave, o ? JSON.parse(await o.text()) : null);
  }
  return lidos.get(r2Chave)?.[nsu] ?? null;
}

/**
 * Cancelamentos e cartas de correção da caixa cuja nota já está no sistema: aplica.
 * Roda depois de cada download e de cada importação, então a nota importada hoje
 * recebe o cancelamento que chegou junto.
 */
export async function aplicarEventosDaCaixa(env: AmbienteCaptura, repo: Repo, empresaId: string): Promise<number> {
  const pendentes = await repo.eventosPendentesDaCaixa(empresaId);
  const lidos = new Map<string, Record<string, string> | null>();
  if (!pendentes.length) return 0;
  const arquivos = [];
  for (const e of pendentes) {
    const xml = await lerDaCaixa(env, e.r2_chave, e.nsu, lidos);
    if (xml) arquivos.push({ nome: `SEF-NSU${e.nsu}-${e.chave}-evento${e.tp_evento}.xml`, conteudo: xml });
  }
  if (arquivos.length) await importarArquivos(repo, env.XML_ORIGINAL, empresaId, arquivos, 'sefaz');
  await repo.marcarEventosAplicados(empresaId, pendentes.map((e) => e.nsu));
  return pendentes.filter((e) => e.tp_evento !== '110110').length;
}

/** Importa as notas escolhidas da caixa (até 20 por chamada), como um envio de XML. */
export async function importarDaCaixa(
  env: AmbienteCaptura, repo: Repo, empresaId: string, chaves: string[], envioId: string | null,
  origem: 'sefaz' | 'sefaz-auto' = 'sefaz',
): Promise<ResultadoLote & { canceladas: number }> {
  const linhas = await repo.notasDaCaixaPorChave(empresaId, chaves);
  const lidos = new Map<string, Record<string, string> | null>();
  const arquivos = [];
  for (const l of linhas) {
    const xml = await lerDaCaixa(env, l.r2_chave, l.nsu, lidos);
    arquivos.push({ nome: `SEF-NSU${l.nsu}-${l.chave}.xml`, conteudo: xml ?? '' });
  }
  const r = await importarArquivos(repo, env.XML_ORIGINAL, empresaId, arquivos, origem, envioId);
  const canceladas = await aplicarEventosDaCaixa(env, repo, empresaId);
  return { ...r, canceladas };
}

// ------------------------------------------------------------------ busca automática

/**
 * Busca automática (01/10/2026, ideia da Taís): para cada empresa com a busca ligada,
 * o cron consulta a SEF assim que ela libera e importa sozinho as notas emitidas a
 * partir da data de início. Roda a cada 15 minutos e faz pouco por vez:
 *
 *   - uma empresa por rodada;
 *   - se a SEF liberou: baixa até AUTO_LOTES lotes (50 documentos cada) para a caixa;
 *   - se não: importa até AUTO_NOTAS notas da caixa, como uma importação "automática da SEF".
 *
 * Pouco por vez porque o cron tem os mesmos limites de uma requisição, e a tela manual
 * importa 20 por requisição pelo mesmo motivo. Uma empresa com 200 notas novas fica
 * em dia em menos de duas horas.
 *
 * Fica na caixa, sem importar: nota emitida antes da data de início; nota emitida pela
 * própria empresa (saída); nota já cancelada; nota que o importador recusou. Essas a
 * contadora vê e importa à mão em "Buscar na SEF", como antes.
 *
 * Tudo é feito em nome de quem ligou a busca, com as permissões que ela tem hoje: se
 * a pessoa foi desativada ou perdeu a permissão de importar, a busca para e diz por quê.
 */
export const AUTO_LOTES = 10;
export const AUTO_NOTAS = 20;

type AmbienteAuto = AmbienteCaptura & { AUDIT_SEED: string };

export async function executarBuscaAutomatica(env: AmbienteAuto, agora = new Date()): Promise<{ empresa: string; resultado: string } | null> {
  const quando = agora.toISOString();
  const [alvo] = await buscasAutomaticasVencidas(env.DB, quando, 1);
  if (!alvo) return null;
  const registrar = async (texto: string, repo?: Repo) => {
    if (repo) await repo.registrarBuscaAutomatica(alvo.empresa_id, quando, texto);
    else {
      await env.DB.prepare('UPDATE captura_empresas SET auto_ultima = ?, auto_ultimo_resultado = ? WHERE empresa_id = ?')
        .bind(quando, texto.slice(0, 500), alvo.empresa_id).run();
    }
    return { empresa: alvo.razao_social as string, resultado: texto };
  };

  const quem = alvo.auto_ligada_por ? await usuarioDaBuscaAutomatica(env.DB, alvo.auto_ligada_por) : null;
  if (!quem || quem.usuario.tenant_id !== alvo.tenant_id) {
    return registrar('Parada: quem ligou a busca automática não está mais ativo no sistema. Ligue de novo.');
  }
  const permissoes = resolverPermissoes(quem.papeis, quem.excecoes);
  const daPessoa: Sessao = {
    usuarioId: quem.usuario.id, tenantId: quem.usuario.tenant_id, email: quem.usuario.email, nome: quem.usuario.nome,
    permissoes, empresas: quem.empresas.length ? new Set(quem.empresas) : null, deveTrocarSenha: false,
  };
  if (!permissoes.has('notas.importar') || !podeVerEmpresa(daPessoa, alvo.empresa_id)) {
    return registrar(`Parada: ${quem.usuario.nome} não tem mais permissão de importar notas desta empresa. Ligue de novo.`);
  }
  // A sessão do cron só enxerga esta empresa, mesmo que a pessoa veja mais.
  const sessao: Sessao = { ...daPessoa, empresas: new Set([alvo.empresa_id]) };
  const repo = new Repo(env.DB, { sessao, ip: null, requestId: `sef-auto-${crypto.randomUUID()}` }, env.AUDIT_SEED);
  const empresa = { id: alvo.empresa_id as string, cnpj: alvo.cnpj as string };

  if (alvo.sef_liberada) {
    const certs = await repo.listarCertificados();
    if (!certs.length) return registrar('Nenhum certificado no cofre.', repo);
    const preferido = (await repo.estadoSef(empresa.id))?.certificado_id;
    const candidatos = [...certs].sort((a, b) => Number(b.id === preferido) - Number(a.id === preferido));
    let documentos = 0;
    let ultimo: ResultadoDownload | null = null;
    for (let i = 0; i < AUTO_LOTES; i++) {
      ultimo = await baixarDaSef(env, repo, empresa, candidatos, agora);
      documentos += ultimo.documentos;
      if (!ultimo.consultou || !ultimo.temMais || ultimo.erro) break;
    }
    await aplicarEventosDaCaixa(env, repo, empresa.id);
    const texto = ultimo?.erro
      ? `Consulta à SEF: ${ultimo.erro}`
      : documentos ? `A SEF mandou ${documentos} documento(s); importando as notas a partir de ${dataBr(alvo.auto_desde)}.` : 'Nada novo na SEF.';
    return registrar(texto, repo);
  }

  // Importar o que está na caixa, a partir da data de início.
  const pendentes = await repo.pendentesDaBuscaAutomatica(empresa.id, alvo.auto_desde, AUTO_NOTAS);
  const so = (v: unknown) => String(v ?? '').replace(/\D/g, '');
  const pular: { chave: string; motivo: string }[] = [];
  const importar: string[] = [];
  for (const n of pendentes) {
    if (so(n.emit_cnpj) && so(n.emit_cnpj) === so(empresa.cnpj)) pular.push({ chave: n.chave, motivo: 'emitida pela própria empresa' });
    else if (n.cancelada) pular.push({ chave: n.chave, motivo: 'cancelada na SEF' });
    else importar.push(n.chave);
  }
  let r: (ResultadoLote & { canceladas: number }) | null = null;
  if (importar.length) {
    // Uma importação "automática da SEF" por dia, na lista de Importações da empresa.
    const envio = `auto-${quando.slice(0, 10)}-${empresa.id.slice(0, 8)}`;
    r = await importarDaCaixa(env, repo, empresa.id, importar, envio, 'sefaz-auto');
    for (const a of r.arquivos) {
      if (a.status === 'recusada' && a.chave) pular.push({ chave: a.chave, motivo: `recusada: ${a.motivo ?? 'sem motivo'}` });
    }
  }
  await repo.marcarPuladasNaBuscaAutomatica(empresa.id, pular);
  const partes = [];
  if (r) partes.push(`Importou ${r.importadas} nota(s)` + (r.canceladas ? `, ${r.canceladas} cancelamento(s) aplicado(s)` : ''));
  if (r?.recusadas) partes.push(`${r.recusadas} recusada(s) pelo importador (ficaram na caixa)`);
  const proprias = pular.filter((p) => !p.motivo.startsWith('recusada')).length;
  if (proprias) partes.push(`${proprias} ficaram na caixa (emitidas pela empresa ou canceladas)`);
  return registrar((partes.join('; ') || 'Nada para importar') + '.', repo);
}

const dataBr = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

/**
 * Uma tentativa de conexão descrita em uma linha: status, servidor e começo da
 * resposta, ou a mensagem do erro. Serve para o diagnóstico do "Testar conexão".
 */
async function sondar(rotulo: string, chamar: () => Promise<Response>): Promise<string> {
  const t0 = Date.now();
  try {
    const r = await chamar();
    const corpo = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    const servidor = r.headers.get('server') ?? '?';
    return `${rotulo}: ${r.status} (servidor ${servidor}, ${Date.now() - t0} ms) ${corpo}`;
  } catch (e) {
    return `${rotulo}: erro (${Date.now() - t0} ms) ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Botão "Testar conexão": só pede a descrição do serviço, não consulta nenhuma empresa.
 *
 * Se falhar, tenta mais três caminhos para dizer ONDE falha (01/10: a primeira
 * tentativa em produção voltou 520, que é a Cloudflare dizendo "a conexão com o
 * servidor caiu"): sem certificado na mesma página, sem certificado na raiz do site
 * e com certificado na raiz. Nenhum deles consulta empresa.
 */
export async function testarConexao(env: AmbienteCaptura, cert: CertParaBusca): Promise<{ ok: boolean; detalhe: string; diagnostico?: string[] }> {
  const busca = buscaComCertificado(env, cert);
  if (!busca) return { ok: false, detalhe: cert.guardado_em === 'ponte' ? 'O intermediário da busca na SEF não está configurado no sistema. Fale com a Planee.' : 'Este certificado está no cofre da Cloudflare, que não serve para a SEF. Envie o .pfx de novo na tela Certificados.' };
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
    const raiz = new URL(URL_SEF_SC).origin + '/';
    const diagnostico = [
      await sondar('sem certificado, descrição do serviço', () => fetch(`${URL_SEF_SC}?WSDL`)),
      await sondar('sem certificado, raiz do site', () => fetch(raiz)),
      await sondar('com certificado, raiz do site', () => busca(raiz, { method: 'GET' })),
    ];
    return { ok: false, detalhe: e instanceof Error ? e.message : String(e), diagnostico };
  }
}
