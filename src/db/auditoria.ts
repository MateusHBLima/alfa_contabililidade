/**
 * Trilha de auditoria.
 *
 * Append-only: nunca sofre UPDATE nem DELETE.
 *
 * Duas decisoes que fazem a diferenca entre uma trilha que serve e uma que nao serve:
 *
 * 1. A gravacao mora aqui e e chamada pelo REPOSITORIO, nao pelos handlers.
 *    Se cada rota tiver que "lembrar" de registrar, um dia alguma nao lembra -
 *    e trilha com buraco nao vale nada num processo.
 *
 * 2. O campo `origem` distingue tres situacoes que dao o mesmo resultado na tela
 *    e sao completamente diferentes na hora de responder por elas:
 *       manual   - o operador digitou
 *       regra:X  - a regra sugeriu e o operador confirmou
 *       lote     - aplicado em massa
 *    E o que sustenta as cláusulas 3.1 "d" e 9.4 do contrato.
 */

export type Origem = string; // 'manual' | 'regra:<id>' | 'lote' | 'importacao' | 'sistema'

export type EventoAuditoria = {
  tenantId: string;
  usuarioId: string | null;
  usuarioEmail: string | null;
  acao: 'criar' | 'alterar' | 'excluir' | 'exportar' | 'login' | 'login_falha' | 'logout';
  entidade: string;
  entidadeId: string | null;
  campo?: string | null;
  valorAntes?: string | null;
  valorDepois?: string | null;
  origem?: Origem | null;
  ip?: string | null;
  requestId?: string | null;
};

async function sha256Hex(texto: string): Promise<string> {
  const bytes = new TextEncoder().encode(texto);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Encadeamento por hash: cada registro carrega o hash do anterior.
 * Custa poucas linhas e torna adulteracao detectavel - apagar ou editar uma linha
 * quebra a cadeia a partir dali, e a verificacao periodica denuncia.
 */
export function payloadCanonico(e: EventoAuditoria, quando: string): string {
  return [
    e.tenantId,
    quando,
    e.usuarioId ?? '',
    e.usuarioEmail ?? '',
    e.acao,
    e.entidade,
    e.entidadeId ?? '',
    e.campo ?? '',
    e.valorAntes ?? '',
    e.valorDepois ?? '',
    e.origem ?? '',
  ].join('');
}

export async function calcularHash(
  e: EventoAuditoria,
  quando: string,
  hashAnterior: string | null,
): Promise<string> {
  return sha256Hex((hashAnterior ?? '') + '' + payloadCanonico(e, quando));
}

export class Auditoria {
  constructor(
    private db: D1Database,
    private seedInicial: string,
  ) {}

  private async ultimoHash(tenantId: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT hash FROM auditoria WHERE tenant_id = ? ORDER BY id DESC LIMIT 1')
      .bind(tenantId)
      .first<{ hash: string }>();
    return row?.hash ?? this.seedInicial;
  }

  /** Grava um evento. Chamado pelo repositorio, nao pelos handlers. */
  async registrar(e: EventoAuditoria): Promise<void> {
    const quando = new Date().toISOString();
    const anterior = await this.ultimoHash(e.tenantId);
    const hash = await calcularHash(e, quando, anterior);

    await this.db
      .prepare(
        `INSERT INTO auditoria
           (tenant_id, quando, usuario_id, usuario_email, acao, entidade, entidade_id,
            campo, valor_antes, valor_depois, origem, ip, request_id, hash_anterior, hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        e.tenantId,
        quando,
        e.usuarioId,
        e.usuarioEmail,
        e.acao,
        e.entidade,
        e.entidadeId,
        e.campo ?? null,
        e.valorAntes ?? null,
        e.valorDepois ?? null,
        e.origem ?? null,
        e.ip ?? null,
        e.requestId ?? null,
        anterior,
        hash,
      )
      .run();
  }

  /** Grava varios eventos de uma vez, mantendo a cadeia consistente. */
  async registrarLote(eventos: EventoAuditoria[]): Promise<void> {
    if (eventos.length === 0) return;
    const tenantId = eventos[0]!.tenantId;
    let anterior = await this.ultimoHash(tenantId);
    const stmts: D1PreparedStatement[] = [];

    for (const e of eventos) {
      const quando = new Date().toISOString();
      const hash = await calcularHash(e, quando, anterior);
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO auditoria
               (tenant_id, quando, usuario_id, usuario_email, acao, entidade, entidade_id,
                campo, valor_antes, valor_depois, origem, ip, request_id, hash_anterior, hash)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            e.tenantId, quando, e.usuarioId, e.usuarioEmail, e.acao, e.entidade, e.entidadeId,
            e.campo ?? null, e.valorAntes ?? null, e.valorDepois ?? null, e.origem ?? null,
            e.ip ?? null, e.requestId ?? null, anterior, hash,
          ),
      );
      anterior = hash;
    }

    await this.db.batch(stmts);
  }

  /**
   * Verifica a integridade da cadeia. Roda periodicamente (cron) e sob demanda.
   * Retorna o id do primeiro registro adulterado, ou null se a cadeia esta inteira.
   */
  async verificarCadeia(tenantId: string): Promise<{ ok: boolean; quebrouNoId: number | null; conferidos: number }> {
    const { results } = await this.db
      .prepare('SELECT * FROM auditoria WHERE tenant_id = ? ORDER BY id ASC')
      .bind(tenantId)
      .all<any>();

    let anterior: string | null = this.seedInicial;
    let conferidos = 0;

    for (const r of results) {
      const evento: EventoAuditoria = {
        tenantId: r.tenant_id,
        usuarioId: r.usuario_id,
        usuarioEmail: r.usuario_email,
        acao: r.acao,
        entidade: r.entidade,
        entidadeId: r.entidade_id,
        campo: r.campo,
        valorAntes: r.valor_antes,
        valorDepois: r.valor_depois,
        origem: r.origem,
      };
      const esperado = await calcularHash(evento, r.quando, anterior);
      if (esperado !== r.hash || r.hash_anterior !== anterior) {
        return { ok: false, quebrouNoId: r.id, conferidos };
      }
      anterior = r.hash;
      conferidos += 1;
    }

    return { ok: true, quebrouNoId: null, conferidos };
  }
}
