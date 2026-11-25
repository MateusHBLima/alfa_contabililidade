import { cnpjFormatado } from './leiaute200';

/**
 * Cliente do Questor SYN (API de integração do Questor), 25/11.
 *
 * Fluxo, pela documentação e pelo swagger público (https://syn.questor.com.br/swagger/v2/swagger.json):
 *  1. POST /api/v2/erp/gerartoken {cnpj, email, codigoAcesso} — credenciais do ERP (a Planee).
 *  2. POST /api/v2/dadosescritorio/solicitaracesso {cnpjCliente, cnpjEscritorio, grupoLayout}
 *     — por empresa cliente; a Alfa aprova no Questor (Gerenciador de Empresas › Controle
 *     Acesso API SYN). Situação em GET /api/v2/dadosescritorio/erp/solicitaracesso/busca.
 *  3. POST /api/v2/dados/inserir {cnpjCliente, versao, grupoLayout, dataDocumentos, dado,
 *     cnpjContabilidade} — o arquivo do leiaute 200 vai em `dado`, como string.
 *  4. A Alfa importa em Arquivos › Questor › Syn › Importar Dados Fiscais.
 *
 * SEGREDOS. O código de acesso e o e-mail do cadastro são segredos do Worker
 * (QUESTOR_SYN_CODIGO, QUESTOR_SYN_EMAIL), cadastrados pelo Mateus no painel. Nada daqui
 * grava ou devolve o código nem o token.
 *
 * Limite da API: 2 consultas por segundo (HTTP 429). Cada ação aqui faz no máximo três.
 */

export type ConfigSyn = {
  url: string;
  cnpjErp: string;
  email: string;
  codigo: string;
  cnpjEscritorio: string;
  /** Intervalo mínimo entre duas chamadas (a API aceita 2 por segundo). */
  intervaloMs: number;
};

export type EnvSyn = {
  QUESTOR_SYN_URL?: string;
  QUESTOR_SYN_CNPJ?: string;
  QUESTOR_SYN_EMAIL?: string;
  QUESTOR_SYN_CODIGO?: string;
  QUESTOR_CNPJ_ESCRITORIO?: string;
  /** Só para os testes (0); em produção fica o padrão de 600 ms. */
  QUESTOR_SYN_INTERVALO_MS?: string;
};

export const GRUPO_ENTRADAS = 200;

/**
 * Grupos de dados do SYN (enum GrupoLayout do swagger; nomes do "Cabeçalho Versão 2.00").
 * O 210 está no swagger e não tem nome na documentação.
 */
export const GRUPOS_SYN: Record<number, string> = {
  1: 'plano de contas ERP',
  100: 'lançamentos contábeis',
  200: 'entradas',
  201: 'saídas',
  202: 'pagamentos',
  203: 'recebimentos',
  210: 'grupo 210',
  300: 'lançamentos de inventário',
  301: 'bloco K',
};

/** `'todos'`, uma lista de grupos ou nada (= só entradas). Grupo desconhecido invalida o pedido. */
export function gruposPedidos(v: unknown): number[] | null {
  const validos = Object.keys(GRUPOS_SYN).map(Number);
  if (v === undefined || v === null) return [GRUPO_ENTRADAS];
  if (v === 'todos') return validos;
  if (!Array.isArray(v) || !v.length) return null;
  const lista = [...new Set(v.map(Number))];
  return lista.every((g) => validos.includes(g)) ? lista : null;
}

/** O que está configurado e o que falta, sem devolver valor de segredo. */
export function configSyn(env: EnvSyn): { ok: true; cfg: ConfigSyn } | { ok: false; falta: string[] } {
  const falta: string[] = [];
  const url = String(env.QUESTOR_SYN_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(url)) falta.push('QUESTOR_SYN_URL');
  const cnpjErp = String(env.QUESTOR_SYN_CNPJ ?? '').replace(/\D/g, '');
  if (cnpjErp.length !== 14) falta.push('QUESTOR_SYN_CNPJ');
  const email = String(env.QUESTOR_SYN_EMAIL ?? '').trim();
  if (!email.includes('@')) falta.push('QUESTOR_SYN_EMAIL (segredo)');
  const codigo = String(env.QUESTOR_SYN_CODIGO ?? '');
  if (!codigo) falta.push('QUESTOR_SYN_CODIGO (segredo)');
  const cnpjEscritorio = String(env.QUESTOR_CNPJ_ESCRITORIO ?? '').replace(/\D/g, '');
  if (cnpjEscritorio.length !== 14) falta.push('QUESTOR_CNPJ_ESCRITORIO (CNPJ da Alfa na licença do Questor)');
  if (falta.length) return { ok: false, falta };
  const intervalo = Number(env.QUESTOR_SYN_INTERVALO_MS);
  const intervaloMs = Number.isFinite(intervalo) && intervalo >= 0 && String(env.QUESTOR_SYN_INTERVALO_MS ?? '') !== '' ? intervalo : 600;
  return { ok: true, cfg: { url, cnpjErp, email, codigo, cnpjEscritorio, intervaloMs } };
}

export class ErroSyn extends Error {
  constructor(mensagem: string, readonly status: number, readonly resposta: unknown) {
    super(mensagem);
    this.name = 'ErroSyn';
  }
}

async function ler(r: Response): Promise<unknown> {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

/** Mensagem curta da resposta de erro do SYN, sem ecoar o corpo inteiro. */
function motivo(corpo: unknown): string {
  if (typeof corpo === 'string') return corpo.slice(0, 300);
  if (corpo && typeof corpo === 'object') {
    const o = corpo as Record<string, any>;
    const m = o.mensagem ?? o.message ?? o.title ?? o.erro ?? o.errors;
    return (typeof m === 'string' ? m : JSON.stringify(m ?? o)).slice(0, 300);
  }
  return '';
}

/** O token vem como texto ou dentro de um objeto; aceita as formas mais comuns. */
export function extrairToken(corpo: unknown): string | null {
  if (typeof corpo === 'string') return corpo.trim().replace(/^"|"$/g, '') || null;
  if (corpo && typeof corpo === 'object') {
    const o = corpo as Record<string, any>;
    for (const k of ['token', 'accessToken', 'access_token', 'codigoAcesso', 'data', 'dados']) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object') { const t = extrairToken(v); if (t) return t; }
    }
  }
  return null;
}

export class ClienteSyn {
  private token: string | null = null;
  private ultimaChamada = 0;
  // Embrulhado: no Worker, o fetch nativo chamado como método de outro objeto dá "Illegal invocation".
  constructor(
    private cfg: ConfigSyn,
    private fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}

  /** Espaça as chamadas para não passar de 2 por segundo (HTTP 429). */
  private async buscar(url: string, init: RequestInit): Promise<Response> {
    const intervalo = this.cfg.intervaloMs ?? 600;
    const espera = this.ultimaChamada + intervalo - Date.now();
    if (intervalo > 0 && espera > 0) await new Promise((r) => setTimeout(r, espera));
    this.ultimaChamada = Date.now();
    return this.fetcher(url, init);
  }

  private async gerarToken(): Promise<string> {
    const r = await this.buscar(`${this.cfg.url}/api/v2/erp/gerartoken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ cnpj: cnpjFormatado(this.cfg.cnpjErp), email: this.cfg.email, codigoAcesso: this.cfg.codigo }),
    });
    const corpo = await ler(r);
    if (!r.ok) throw new ErroSyn(`O Questor recusou gerar o token (HTTP ${r.status}): ${motivo(corpo)}`, r.status, null);
    const t = extrairToken(corpo);
    if (!t) throw new ErroSyn('O Questor respondeu sem token.', r.status, null);
    return t;
  }

  private async chamar(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<{ status: number; corpo: unknown }> {
    if (!this.token) this.token = await this.gerarToken();
    const r = await this.buscar(`${this.cfg.url}${caminho}`, {
      method: metodo,
      headers: {
        authorization: `Bearer ${this.token}`, accept: 'application/json',
        ...(corpo === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const lido = await ler(r);
    if (!r.ok) throw new ErroSyn(`O Questor respondeu HTTP ${r.status}: ${motivo(lido)}`, r.status, lido);
    return { status: r.status, corpo: lido };
  }

  solicitarAcesso(cnpjCliente: string, grupo: number = GRUPO_ENTRADAS) {
    return this.chamar('POST', '/api/v2/dadosescritorio/solicitaracesso', {
      cnpjCliente: cnpjFormatado(cnpjCliente), cnpjEscritorio: cnpjFormatado(this.cfg.cnpjEscritorio), grupoLayout: grupo,
    });
  }

  buscarAcesso(cnpjCliente: string, grupo: number = GRUPO_ENTRADAS) {
    const q = new URLSearchParams({
      CnpjCliente: cnpjFormatado(cnpjCliente), CnpjEscritorio: cnpjFormatado(this.cfg.cnpjEscritorio), GrupoLayout: String(grupo),
    });
    return this.chamar('GET', `/api/v2/dadosescritorio/erp/solicitaracesso/busca?${q}`);
  }

  inserirEntradas(cnpjCliente: string, dataDocumentos: string, dado: string) {
    return this.chamar('POST', '/api/v2/dados/inserir', {
      cnpjCliente: cnpjFormatado(cnpjCliente), versao: '2.00', grupoLayout: GRUPO_ENTRADAS,
      dataDocumentos, dado, cnpjContabilidade: [cnpjFormatado(this.cfg.cnpjEscritorio)],
    });
  }

  buscarLog(dadoId: string) {
    const q = new URLSearchParams({ DadoId: dadoId });
    return this.chamar('GET', `/api/v2/dados/buscar-log-e-status-dados?${q}`);
  }
}

/** O id do dado postado, para acompanhar depois; aceita número ou texto em algumas formas. */
export function extrairDadoId(corpo: unknown): string | null {
  if (typeof corpo === 'number' || (typeof corpo === 'string' && /^[\w-]{1,80}$/.test(corpo.trim()))) return String(corpo).trim();
  if (corpo && typeof corpo === 'object') {
    const o = corpo as Record<string, any>;
    for (const k of ['dadoId', 'id', 'idDado', 'codigo', 'data', 'dados']) {
      const v = o[k];
      if (typeof v === 'number' || (typeof v === 'string' && v.trim())) return String(v).trim();
      if (v && typeof v === 'object') { const t = extrairDadoId(v); if (t) return t; }
    }
  }
  return null;
}
