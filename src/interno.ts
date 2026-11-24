/**
 * Consulta interna para a plataforma do cartório (24/11/2026, pedido do Mateus: "é claro
 * que tem que puxar, fizemos aquele trabalho todo de testar o certificado é pra isso").
 *
 * A plataforma do cartório (Worker `planee-cartorio`, mesma conta) precisa das notas que
 * o cartório emite, que estão na base nacional da NFS-e (ADN) e só saem de lá com o
 * certificado da contadora, que tem a procuração do titular. O certificado e o token do
 * intermediário moram AQUI e não saem: o que a outra plataforma recebe é um ponto de
 * entrada com um método só.
 *
 * Como isto é fechado:
 *   - não é rota. É um ponto de entrada nomeado (WorkerEntrypoint): só é chamado por um
 *     Worker da mesma conta que declare o service binding. Da internet não se chega aqui;
 *   - o certificado NÃO vem no pedido. É um só, fixo na variável CARTORIO_CERT_ID, e tem
 *     de estar cadastrado, guardado no intermediário, não removido e dentro da validade.
 *     Os certificados das empresas clientes ficam fora do alcance;
 *   - só consulta (GET em /contribuintes/DFe, em lote), em nome de um CPF válido;
 *   - cada consulta fica na trilha, com o CPF mascarado, como "plataforma do cartório".
 *
 * Nada do cartório é gravado neste banco: o XML passa e vai embora.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Auditoria } from './db/auditoria';
import { chamarAdn, cpfValido, mascararCpf } from './captura/adn';

export type AmbienteInterno = {
  DB: D1Database;
  AUDIT_SEED: string;
  SEF_PONTE_URL?: string;
  SEF_PONTE_TOKEN?: string;
  CARTORIO_CERT_ID?: string;
};

/** Um documento do ADN, como ele manda: o XML vem em base64, compactado (gzip). */
export type DocumentoAdn = { nsu: number; chave: string; tipo: string; xml: string; geradoEm: string | null };

export type LoteParaCartorio = {
  /** 200 = veio a resposta do ADN; 404 = não há documento depois deste NSU; outro = erro. */
  status: number;
  /** "DOCUMENTOS_LOCALIZADOS", "REJEICAO"..., quando o ADN diz. */
  situacao: string | null;
  documentos: DocumentoAdn[];
  /** Explicação curta quando não veio lote (sem dado de nota). */
  mensagem?: string;
};

const recusa = (status: number, mensagem: string): LoteParaCartorio => ({ status, situacao: null, documentos: [], mensagem });

/**
 * Um lote (até 50 documentos) com NSU maior que o informado, em nome do CPF informado.
 * Função solta, para ser testada sem a classe.
 */
export async function loteParaCartorio(env: AmbienteInterno, pedido: { cpf: string; nsu: number }): Promise<LoteParaCartorio> {
  const cpf = String(pedido?.cpf ?? '').replace(/\D/g, '');
  const nsu = Number(pedido?.nsu);
  if (!cpfValido(cpf)) return recusa(400, 'CPF inválido');
  if (!Number.isSafeInteger(nsu) || nsu < 0) return recusa(400, 'NSU inválido');

  const certId = (env.CARTORIO_CERT_ID ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(certId)) return recusa(503, 'a consulta para o cartório não está ligada (falta CARTORIO_CERT_ID)');
  const url = typeof env.SEF_PONTE_URL === 'string' ? env.SEF_PONTE_URL.replace(/\/+$/, '') : '';
  const token = typeof env.SEF_PONTE_TOKEN === 'string' ? env.SEF_PONTE_TOKEN : '';
  if (!url || !token) return recusa(503, 'o intermediário não está configurado');

  const cert = await env.DB
    .prepare('SELECT tenant_id, guardado_em, removido_em, valido_ate FROM certificados WHERE id = ?')
    .bind(certId).first<{ tenant_id: string; guardado_em: string; removido_em: string | null; valido_ate: string }>();
  if (!cert || cert.removido_em) return recusa(503, 'o certificado da consulta não está cadastrado');
  if (cert.guardado_em !== 'ponte') return recusa(503, 'o certificado da consulta não está no intermediário');
  if (new Date(cert.valido_ate) < new Date()) return recusa(503, 'o certificado da consulta venceu');

  let r: { caminho: string; status: number; texto: string };
  try {
    r = await chamarAdn({ url, token }, { certId, nsu: String(nsu), cpf, lote: true });
  } catch (e) {
    r = { caminho: '', status: 502, texto: e instanceof Error ? e.message : String(e) };
  }

  let json: any = null;
  try { json = JSON.parse(r.texto); } catch { /* não é JSON */ }
  const lista: unknown[] = r.status === 200 && json && Array.isArray(json.LoteDFe) ? json.LoteDFe : [];
  const documentos: DocumentoAdn[] = [];
  for (const d of lista as Record<string, unknown>[]) {
    const n = Number(d?.NSU);
    if (!Number.isSafeInteger(n) || typeof d.ArquivoXml !== 'string') continue;
    documentos.push({
      nsu: n, chave: String(d.ChaveAcesso ?? ''), tipo: String(d.TipoDocumento ?? ''), xml: d.ArquivoXml,
      geradoEm: typeof d.DataHoraGeracao === 'string' ? d.DataHoraGeracao : null,
    });
  }

  await new Auditoria(env.DB, env.AUDIT_SEED).registrar({
    tenantId: cert.tenant_id, usuarioId: null, usuarioEmail: 'plataforma do cartório',
    acao: 'exportar', entidade: 'certificado', entidadeId: certId,
    valorDepois: `consulta ADN pela plataforma do cartório · NSU ${nsu} · CPF ${mascararCpf(cpf)} · lote · HTTP ${r.status}`
      + `${documentos.length ? ` · ${documentos.length} documentos` : ''}`,
    origem: 'sistema', ip: null, requestId: null,
  });

  const situacao = json && typeof json.StatusProcessamento === 'string' ? json.StatusProcessamento : null;
  if (r.status === 200) return { status: 200, situacao, documentos };
  if (r.status === 404) return { status: 404, situacao, documentos: [] };
  // Erro do ADN ou do intermediário: só o código e um começo de texto sem dado de nota.
  return recusa(r.status, `o ADN respondeu ${r.status}`);
}

/** O ponto de entrada. A plataforma do cartório chama `env.<binding>.lote({ cpf, nsu })`. */
export class ConsultaAdnCartorio extends WorkerEntrypoint<AmbienteInterno> {
  lote(pedido: { cpf: string; nsu: number }): Promise<LoteParaCartorio> {
    return loteParaCartorio(this.env, pedido);
  }
}
