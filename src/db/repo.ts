import { Auditoria, type EventoAuditoria, type Origem } from './auditoria';
import type { Sessao } from '../auth/permissoes';
import { podeVerEmpresa } from '../auth/permissoes';
import type { Campo } from '../rules/campos';
import type { Nivel, Regra } from '../rules/engine';
import { aplicarAcerto, aplicarErro, aprender, recalcularConfianca } from '../rules/engine';

/**
 * Repositorio.
 *
 * Toda escrita de dominio passa por aqui, e e AQUI que a trilha de auditoria e gravada.
 * Se cada rota tivesse que "lembrar" de registrar, um dia alguma nao lembraria - e
 * trilha com buraco nao vale nada num processo.
 *
 * Toda leitura passa pelo escopo do tenant e pelo recorte de empresas do usuario.
 * Nao existe SQL de dominio fora deste arquivo.
 */

export class ForaDoEscopo extends Error {
  constructor(msg = 'Registro fora do escopo deste usuário') {
    super(msg);
    this.name = 'ForaDoEscopo';
  }
}

function id(): string {
  return crypto.randomUUID();
}

function agora(): string {
  return new Date().toISOString();
}

export type ContextoRequisicao = {
  sessao: Sessao;
  ip: string | null;
  requestId: string;
};

/** O que a tela precisa saber sobre a regra que preencheu um item. */
export type FichaRegra = {
  id: string;
  nivel: number;
  usos: number;
  acertos: number;
  erros: number;
  fixada: boolean;
  suspeita: boolean;
};

export class Repo {
  private aud: Auditoria;

  constructor(
    private db: D1Database,
    private ctx: ContextoRequisicao,
    auditSeed: string,
  ) {
    this.aud = new Auditoria(db, auditSeed);
  }

  private get tenant() {
    return this.ctx.sessao.tenantId;
  }

  private evento(p: Omit<EventoAuditoria, 'tenantId' | 'usuarioId' | 'usuarioEmail' | 'ip' | 'requestId'>): EventoAuditoria {
    return {
      ...p,
      tenantId: this.tenant,
      usuarioId: this.ctx.sessao.usuarioId,
      usuarioEmail: this.ctx.sessao.email,
      ip: this.ctx.ip,
      requestId: this.ctx.requestId,
    };
  }

  private exigirEmpresa(empresaId: string): void {
    if (!podeVerEmpresa(this.ctx.sessao, empresaId)) throw new ForaDoEscopo();
  }

  // ---------------------------------------------------------------- empresas

  async listarEmpresas(): Promise<any[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM empresas WHERE tenant_id = ? AND ativo = 1 ORDER BY razao_social')
      .bind(this.tenant)
      .all<any>();
    const permitidas = this.ctx.sessao.empresas;
    if (permitidas === null) {
      return this.ctx.sessao.permissoes.has('empresas.todas') ? results : [];
    }
    return results.filter((e) => permitidas.has(e.id));
  }

  async obterEmpresa(empresaId: string): Promise<any | null> {
    this.exigirEmpresa(empresaId);
    return this.db
      .prepare('SELECT * FROM empresas WHERE tenant_id = ? AND id = ?')
      .bind(this.tenant, empresaId)
      .first<any>();
  }

  /** A empresa deste escritorio com esse CNPJ, se a pessoa pode ve-la (para dizer onde a nota vai). */
  async empresaPorCnpj(cnpj: string): Promise<any | null> {
    const e = await this.db
      .prepare(`SELECT id, cnpj, razao_social FROM empresas WHERE tenant_id = ? AND UPPER(REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', '')) = ?`)
      .bind(this.tenant, cnpj)
      .first<any>();
    if (!e) return null;
    try { this.exigirEmpresa(e.id); } catch { return null; }
    return e;
  }

  async criarEmpresa(dados: {
    cnpj: string;
    razaoSocial: string;
    nomeFantasia?: string | null;
    uf?: string | null;
    perfil: string;
    regime?: string | null;
    cnaePrincipal?: string | null;
    cnaesSecundarios?: string[];
    cfopPadraoDentroUF?: string | null;
    cfopPadraoForaUF?: string | null;
    cstEntradaPadrao?: string | null;
    creditoIcmsPadrao?: string | null;
    creditoPisPadrao?: string | null;
    creditoCofinsPadrao?: string | null;
    observacoes?: string | null;
  }): Promise<string> {
    const novoId = id();
    const cnpj = dados.cnpj.replace(/\D/g, '');

    await this.db
      .prepare(
        `INSERT INTO empresas
          (id, tenant_id, cnpj, razao_social, nome_fantasia, uf, perfil, regime,
           cnae_principal, cnaes_secundarios, cfop_padrao_dentro_uf, cfop_padrao_fora_uf,
           cst_entrada_padrao, credito_icms_padrao, credito_pis_padrao, credito_cofins_padrao,
           observacoes, ativo, criado_em)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      )
      .bind(
        novoId, this.tenant, cnpj, dados.razaoSocial, dados.nomeFantasia ?? null,
        dados.uf ?? null, dados.perfil, dados.regime ?? null,
        dados.cnaePrincipal ?? null, JSON.stringify(dados.cnaesSecundarios ?? []),
        dados.cfopPadraoDentroUF ?? null, dados.cfopPadraoForaUF ?? null,
        dados.cstEntradaPadrao ?? null, dados.creditoIcmsPadrao ?? null,
        dados.creditoPisPadrao ?? null, dados.creditoCofinsPadrao ?? null,
        dados.observacoes ?? null, agora(),
      )
      .run();

    await this.aud.registrar(
      this.evento({
        acao: 'criar', entidade: 'empresa', entidadeId: novoId,
        valorDepois: `${cnpj} · ${dados.razaoSocial} · perfil ${dados.perfil}`,
        origem: 'manual',
      }),
    );

    return novoId;
  }

  async atualizarEmpresa(empresaId: string, mudancas: Record<string, string | null>): Promise<void> {
    this.exigirEmpresa(empresaId);
    const atual = await this.obterEmpresa(empresaId);
    if (!atual) throw new ForaDoEscopo('Empresa não encontrada');

    const permitidas = [
      'razao_social', 'nome_fantasia', 'uf', 'perfil', 'regime', 'cnae_principal',
      'cnaes_secundarios', 'cfop_padrao_dentro_uf', 'cfop_padrao_fora_uf',
      'cst_entrada_padrao', 'credito_icms_padrao', 'credito_pis_padrao',
      'credito_cofins_padrao', 'observacoes',
    ];

    const eventos: EventoAuditoria[] = [];
    const sets: string[] = [];
    const valores: unknown[] = [];

    for (const [campo, valor] of Object.entries(mudancas)) {
      if (!permitidas.includes(campo)) continue;
      if (String(atual[campo] ?? '') === String(valor ?? '')) continue;
      sets.push(`${campo} = ?`);
      valores.push(valor);
      eventos.push(
        this.evento({
          acao: 'alterar', entidade: 'empresa', entidadeId: empresaId,
          campo, valorAntes: atual[campo] ?? null, valorDepois: valor, origem: 'manual',
        }),
      );
    }

    if (sets.length === 0) return;

    sets.push('atualizado_em = ?');
    valores.push(agora(), this.tenant, empresaId);

    await this.db
      .prepare(`UPDATE empresas SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
      .bind(...valores)
      .run();

    await this.aud.registrarLote(eventos);
  }

  // ---------------------------------------------------------------- fornecedores

  async registrarFornecedor(empresaId: string, cnpj: string, nome: string | null, uf: string | null): Promise<void> {
    const existente = await this.db
      .prepare('SELECT id, notas_recebidas FROM fornecedores WHERE tenant_id = ? AND empresa_id = ? AND cnpj = ?')
      .bind(this.tenant, empresaId, cnpj)
      .first<{ id: string; notas_recebidas: number }>();

    if (existente) {
      await this.db
        .prepare('UPDATE fornecedores SET notas_recebidas = notas_recebidas + 1, ultima_nota_em = ? WHERE id = ?')
        .bind(agora(), existente.id)
        .run();
      return;
    }

    await this.db
      .prepare(
        `INSERT INTO fornecedores (id, tenant_id, empresa_id, cnpj, nome, uf, notas_recebidas, ultima_nota_em, criado_em)
         VALUES (?,?,?,?,?,?,1,?,?)`,
      )
      .bind(id(), this.tenant, empresaId, cnpj, nome, uf, agora(), agora())
      .run();
  }

  async listarFornecedores(empresaId: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM fornecedores WHERE tenant_id = ? AND empresa_id = ?
         ORDER BY notas_recebidas DESC, nome`,
      )
      .bind(this.tenant, empresaId)
      .all<any>();
    return results;
  }

  // ---------------------------------------------------------------- regras

  /** Carrega todas as regras que podem casar com os itens de uma nota, de uma vez só. */
  async carregarRegrasCandidatas(empresaId: string, chaves: { nivel: Nivel; chave: string }[]): Promise<Regra[]> {
    if (chaves.length === 0) return [];
    const unicas = [...new Set(chaves.map((c) => `${c.nivel} ${c.chave}`))];

    // O D1 recusa mais de 100 parametros por consulta ("too many SQL variables").
    // Cada chave gasta 2, mais 2 fixos: 40 chaves por vez deixa folga. Uma nota de
    // 20 itens gera bem mais que 40 chaves - foi assim que a primeira nota real
    // derrubou a importacao, com a suite verde porque a nota de teste tinha 3.
    const POR_CONSULTA = 40;
    const linhas: any[] = [];

    for (let i = 0; i < unicas.length; i += POR_CONSULTA) {
      const fatia = unicas.slice(i, i + POR_CONSULTA);
      // Pares (nivel, chave) como lista de VALUES: o SQLite usa o indice unico de
      // regras e busca so esses pares. Com "(nivel = ? AND chave = ?) OR ..." ele lia
      // todas as regras da empresa a cada consulta (medido em 23/09).
      const placeholders = fatia.map(() => '(?, ?)').join(', ');
      const binds: unknown[] = [this.tenant, empresaId];
      for (const u of fatia) {
        const corte = u.indexOf(' ');
        binds.push(Number(u.slice(0, corte)), u.slice(corte + 1));
      }

      const { results } = await this.db
        .prepare(
          `SELECT * FROM regras
           WHERE tenant_id = ? AND empresa_id = ? AND ativa = 1 AND (nivel, chave) IN (VALUES ${placeholders})`,
        )
        .bind(...binds)
        .all<any>();

      linhas.push(...results);
    }

    // Fatias diferentes podem trazer a mesma regra; uma so vez basta.
    const vistas = new Set<string>();
    return linhas
      .filter((l) => (vistas.has(l.id) ? false : (vistas.add(l.id), true)))
      .map(linhaParaRegra);
  }

  /**
   * O que o "Conferido" ensina (pedido de 22/09, teste geral). Conferir e concordar
   * com o CFOP que esta na linha - e concordar tambem e decisao. Antes o sistema so
   * aprendia do que era digitado: um palpite do perfil que ela conferia voltava como
   * palpite na nota seguinte, pedindo a mesma conferencia de novo.
   *
   * Em lote, como o fixarPadraoDeItens: "Conferir os que estao na tela" numa nota de
   * 990 itens nao pode virar quatro consultas por item.
   *
   * - `confirmar`: a regra que sugeriu ganha um acerto - so se ela ainda diz o mesmo
   *   valor que esta na linha (se mudou depois, conferir a linha nao fala dela).
   * - `criar`: regra nova nas chaves que aprendem sozinhas; se ja existe com outro
   *   valor, vale a decisao mais recente, menos em regra fixada (so fixacao muda).
   */
  async aprenderEmLote(empresaId: string, acoes: { acao: import('../rules/engine').Aprendizado; valor: string }[]): Promise<void> {
    this.exigirEmpresa(empresaId);
    if (acoes.length === 0) return;
    const quando = agora();
    const quem = this.ctx.sessao.usuarioId;
    const comandos: D1PreparedStatement[] = [];

    // --- confirmar / corrigir: acerto ou erro na regra que sugeriu o valor que estava na linha
    const confirmar = acoes.filter((a) => a.acao.tipo === 'confirmar' || a.acao.tipo === 'corrigir') as { acao: { tipo: 'confirmar' | 'corrigir'; regraId: string }; valor: string }[];
    const ids = [...new Set(confirmar.map((a) => a.acao.regraId))];
    const regras = new Map<string, any>();
    for (let i = 0; i < ids.length; i += 90) {
      const fatia = ids.slice(i, i + 90);
      const { results } = await this.db
        .prepare(`SELECT * FROM regras WHERE tenant_id = ? AND empresa_id = ? AND id IN (${fatia.map(() => '?').join(',')})`)
        .bind(this.tenant, empresaId, ...fatia)
        .all<any>();
      for (const r of results) regras.set(r.id, r);
    }
    const novas = new Map<string, Regra>();
    for (const a of confirmar) {
      const linha = regras.get(a.acao.regraId);
      if (!linha || linha.valor !== a.valor) continue;
      const atual = novas.get(linha.id) ?? linhaParaRegra(linha);
      novas.set(linha.id, a.acao.tipo === 'confirmar' ? aplicarAcerto(atual) : aplicarErro(atual));
    }
    for (const n of novas.values()) {
      comandos.push(
        this.db
          .prepare(
            `UPDATE regras SET usos=?, acertos=?, erros=?, erros_seguidos=?, confianca=?, suspeita=?, atualizada_em=?
             WHERE tenant_id = ? AND id = ?`,
          )
          .bind(n.usos, n.acertos, n.erros, n.errosSeguidos, n.confianca, n.suspeita ? 1 : 0, quando, this.tenant, n.id),
      );
    }

    // --- criar: uma vez por chave; a ultima decisao da lista vale
    const porChave = new Map<string, { nivel: Nivel; chave: string; campo: Campo; valor: string; fixada: boolean }>();
    for (const a of acoes) {
      if (a.acao.tipo !== 'criar') continue;
      const k = `${a.acao.nivel}\x00${a.acao.campo}\x00${a.acao.chave}`;
      const fixada = a.acao.fixada === true || porChave.get(k)?.fixada === true;
      porChave.set(k, { nivel: a.acao.nivel, chave: a.acao.chave, campo: a.acao.campo, valor: a.acao.valor, fixada });
    }
    const unicas = [...porChave.values()];
    const existentes = new Map<string, { id: string; valor: string; fixada: number }>();
    for (let i = 0; i < unicas.length; i += 30) {
      const fatia = unicas.slice(i, i + 30);
      const binds: unknown[] = [this.tenant, empresaId];
      for (const u of fatia) binds.push(u.nivel, u.chave, u.campo);
      const { results } = await this.db
        .prepare(
          `SELECT id, nivel, chave, campo, valor, fixada FROM regras
            WHERE tenant_id = ? AND empresa_id = ? AND (${fatia.map(() => '(nivel = ? AND chave = ? AND campo = ?)').join(' OR ')})`,
        )
        .bind(...binds)
        .all<any>();
      for (const r of results) existentes.set(`${r.nivel}\x00${r.campo}\x00${r.chave}`, r);
    }
    for (const u of unicas) {
      const e = existentes.get(`${u.nivel}\x00${u.campo}\x00${u.chave}`);
      if (!e) {
        comandos.push(
          this.db
            .prepare(
              `INSERT INTO regras (id, tenant_id, empresa_id, nivel, chave, campo, valor, confianca, ativa, fixada, fixada_por, fixada_em, criada_em, criada_por)
               VALUES (?,?,?,?,?,?,?,0.5,1,?,?,?,?,?)`,
            )
            .bind(id(), this.tenant, empresaId, u.nivel, u.chave, u.campo, u.valor,
                  u.fixada ? 1 : 0, u.fixada ? quem : null, u.fixada ? quando : null, quando, quem),
        );
      } else if (u.fixada) {
        // Fixacao explicita sobrescreve, inclusive outra fixada (e o que o caminho de um item faz).
        comandos.push(
          this.db
            .prepare(
              `UPDATE regras SET valor=?, fixada=1, fixada_por=?, fixada_em=?, atualizada_em=?, suspeita=0, erros_seguidos=0
               WHERE tenant_id = ? AND id = ?`,
            )
            .bind(u.valor, quem, quando, quando, this.tenant, e.id),
        );
      } else if (e.valor !== u.valor && e.fixada !== 1) {
        comandos.push(
          this.db
            .prepare(`UPDATE regras SET valor=?, atualizada_em=?, suspeita=0, erros_seguidos=0 WHERE tenant_id = ? AND id = ?`)
            .bind(u.valor, quando, this.tenant, e.id),
        );
      }
    }

    for (let i = 0; i < comandos.length; i += 100) await this.db.batch(comandos.slice(i, i + 100));
  }

  /**
   * Aplica UM CFOP a varios itens de uma nota numa ida so (+ trilha em lote). Mesma
   * semantica do alterarItem item a item: muda valor e origem de quem mudou, e marca
   * todos como conferidos (quem aplicou olhou). Devolve quantos mudaram de valor.
   */
  async aplicarCfopEmLote(notaId: string, linhas: any[], cfop: string, origem: Origem): Promise<{ alterados: number; conferidos: number }> {
    const nota = await this.db
      .prepare('SELECT empresa_id FROM notas WHERE tenant_id = ? AND id = ?')
      .bind(this.tenant, notaId)
      .first<any>();
    if (!nota) throw new ForaDoEscopo('Nota não encontrada');
    this.exigirEmpresa(nota.empresa_id);
    if (linhas.length === 0) return { alterados: 0, conferidos: 0 };

    const quando = agora();
    const quem = this.ctx.sessao.usuarioId;
    const mudam = linhas.filter((l) => String(l.cfop_novo ?? '') !== cfop);
    const comandos: D1PreparedStatement[] = [];
    const POR_VEZ = 60;
    for (let i = 0; i < mudam.length; i += POR_VEZ) {
      const fatia = mudam.slice(i, i + POR_VEZ).map((l) => l.id);
      comandos.push(
        this.db
          .prepare(
            `UPDATE itens SET cfop_novo = ?, cfop_origem = ?, revisado = 1, revisado_por = ?, revisado_em = ?
              WHERE tenant_id = ? AND nota_id = ? AND id IN (${fatia.map(() => '?').join(',')})`,
          )
          .bind(cfop, origem, quem, quando, this.tenant, notaId, ...fatia),
      );
    }
    const iguais = linhas.filter((l) => String(l.cfop_novo ?? '') === cfop);
    for (let i = 0; i < iguais.length; i += POR_VEZ) {
      const fatia = iguais.slice(i, i + POR_VEZ).map((l) => l.id);
      comandos.push(
        this.db
          .prepare(
            `UPDATE itens SET revisado = 1, revisado_por = ?, revisado_em = ?
              WHERE tenant_id = ? AND nota_id = ? AND id IN (${fatia.map(() => '?').join(',')})`,
          )
          .bind(quem, quando, this.tenant, notaId, ...fatia),
      );
    }
    for (let i = 0; i < comandos.length; i += 100) await this.db.batch(comandos.slice(i, i + 100));

    await this.aud.registrarLote([
      ...mudam.map((l) =>
        this.evento({
          acao: 'alterar', entidade: 'item_nota', entidadeId: l.id,
          campo: 'cfop', valorAntes: l.cfop_novo ?? null, valorDepois: cfop, origem,
        }),
      ),
      // Os que ja estavam com este CFOP: uma linha so, na nota (como o Conferir).
      ...(iguais.length
        ? [this.evento({
            acao: 'alterar', entidade: 'nota', entidadeId: notaId, campo: 'conferido',
            valorAntes: null, valorDepois: `${iguais.length} item(ns) já em ${cfop}`, origem: 'manual',
          })]
        : []),
    ]);
    return { alterados: mudam.length, conferidos: linhas.length };
  }

  /**
   * Regras de CFOP FIXADAS deste fornecedor (niveis 1 e 2 comecam por "<cnpj>|").
   * Uma consulta por nota: e o que deixa a linha mostrar "PADRAO FIXADO" logo depois
   * do "e sempre assim", em vez de so na proxima nota.
   */
  async regrasFixadasDoFornecedor(empresaId: string, emitCnpj: string): Promise<{ nivel: number; chave: string; valor: string }[]> {
    this.exigirEmpresa(empresaId);
    const cnpj = String(emitCnpj ?? '').replace(/\D/g, '');
    if (!cnpj) return [];
    const { results } = await this.db
      .prepare(
        `SELECT nivel, chave, valor FROM regras
          WHERE tenant_id = ? AND empresa_id = ? AND campo = 'cfop' AND ativa = 1 AND fixada = 1
            AND nivel IN (1, 2) AND substr(chave, 1, ?) = ?`,
      )
      .bind(this.tenant, empresaId, cnpj.length + 1, cnpj + '|')
      .all<any>();
    return results;
  }

  async aplicarAprendizado(
    empresaId: string,
    acoes: import('../rules/engine').Aprendizado[],
  ): Promise<void> {
    for (const acao of acoes) {
      if (acao.tipo === 'confirmar' || acao.tipo === 'corrigir') {
        const linha = await this.db
          .prepare('SELECT * FROM regras WHERE tenant_id = ? AND id = ?')
          .bind(this.tenant, acao.regraId)
          .first<any>();
        if (!linha) continue;

        const regra = linhaParaRegra(linha);
        const nova = acao.tipo === 'confirmar' ? aplicarAcerto(regra) : aplicarErro(regra);

        await this.db
          .prepare(
            `UPDATE regras SET usos=?, acertos=?, erros=?, erros_seguidos=?, confianca=?, suspeita=?, atualizada_em=?
             WHERE tenant_id = ? AND id = ?`,
          )
          .bind(
            nova.usos, nova.acertos, nova.erros, nova.errosSeguidos, nova.confianca,
            nova.suspeita ? 1 : 0, agora(), this.tenant, acao.regraId,
          )
          .run();
        continue;
      }

      // criar / atualizar
      const existente = await this.db
        .prepare(
          `SELECT id, valor, fixada FROM regras
           WHERE tenant_id = ? AND empresa_id = ? AND nivel = ? AND chave = ? AND campo = ?`,
        )
        .bind(this.tenant, empresaId, acao.nivel, acao.chave, acao.campo)
        .first<{ id: string; valor: string; fixada: number }>();

      if (!existente) {
        await this.db
          .prepare(
            `INSERT INTO regras
               (id, tenant_id, empresa_id, nivel, chave, campo, valor, confianca, ativa,
                fixada, fixada_por, fixada_em, criada_em, criada_por)
             VALUES (?,?,?,?,?,?,?,0.5,1,?,?,?,?,?)`,
          )
          .bind(
            id(), this.tenant, empresaId, acao.nivel, acao.chave, acao.campo, acao.valor,
            acao.fixada ? 1 : 0,
            acao.fixada ? this.ctx.sessao.usuarioId : null,
            acao.fixada ? agora() : null,
            agora(), this.ctx.sessao.usuarioId,
          )
          .run();
        continue;
      }

      if (existente.valor === acao.valor && !acao.fixada) continue;

      // Regra fixada só é sobrescrita por outra fixação explícita.
      if (existente.fixada === 1 && !acao.fixada) continue;

      await this.db
        .prepare(
          `UPDATE regras SET valor=?, atualizada_em=?, suspeita=0, erros_seguidos=0,
             fixada=?, fixada_por=COALESCE(?, fixada_por), fixada_em=COALESCE(?, fixada_em)
           WHERE tenant_id = ? AND id = ?`,
        )
        .bind(
          acao.valor, agora(), acao.fixada ? 1 : existente.fixada,
          acao.fixada ? this.ctx.sessao.usuarioId : null,
          acao.fixada ? agora() : null,
          this.tenant, existente.id,
        )
        .run();
    }
  }

  async listarRegras(empresaId: string, filtro?: { suspeitas?: boolean }): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const where = filtro?.suspeitas ? 'AND suspeita = 1' : '';
    const { results } = await this.db
      .prepare(
        `SELECT * FROM regras WHERE tenant_id = ? AND empresa_id = ? ${where}
         ORDER BY fixada DESC, nivel ASC, usos DESC LIMIT 500`,
      )
      .bind(this.tenant, empresaId)
      .all<any>();
    return results;
  }

  // ---------------------------------------------------------------- itens

  /**
   * Altera campos do template num item. Grava a trilha com a `origem` correta -
   * que e o que distingue "o humano digitou" de "a regra preencheu e o humano confirmou".
   */
  async alterarItem(
    itemId: string,
    mudancas: { campo: Campo; valor: string; origem: Origem }[],
  ): Promise<void> {
    const atual = await this.db
      .prepare(
        `SELECT i.*, n.empresa_id FROM itens i
         JOIN notas n ON n.id = i.nota_id
         WHERE i.tenant_id = ? AND i.id = ?`,
      )
      .bind(this.tenant, itemId)
      .first<any>();
    if (!atual) throw new ForaDoEscopo('Item não encontrado');
    this.exigirEmpresa(atual.empresa_id);

    const colunaDe: Record<string, { valor: string; origem: string }> = {
      cfop: { valor: 'cfop_novo', origem: 'cfop_origem' },
      descricao: { valor: 'x_prod_novo', origem: 'x_prod_origem' },
      cst_entrada: { valor: 'cst_entrada', origem: 'cst_entrada_origem' },
      conta_contabil: { valor: 'conta_contabil', origem: 'conta_contabil_origem' },
      credito_icms: { valor: 'credito_icms', origem: 'credito_icms_origem' },
      credito_pis: { valor: 'credito_pis', origem: 'credito_pis_origem' },
      credito_cofins: { valor: 'credito_cofins', origem: 'credito_cofins_origem' },
    };

    const sets: string[] = [];
    const valores: unknown[] = [];
    const eventos: EventoAuditoria[] = [];

    for (const m of mudancas) {
      const col = colunaDe[m.campo];
      if (!col) continue;
      const antes = atual[col.valor] ?? null;
      if (String(antes ?? '') === m.valor) continue;

      sets.push(`${col.valor} = ?`, `${col.origem} = ?`);
      valores.push(m.valor, m.origem);
      eventos.push(
        this.evento({
          acao: 'alterar', entidade: 'item_nota', entidadeId: itemId,
          campo: m.campo, valorAntes: antes, valorDepois: m.valor, origem: m.origem,
        }),
      );
    }

    // Concordar com a sugestao TAMBEM e trabalho - e e o caso mais comum, porque o
    // motor existe justamente para acertar sozinho. Antes, quando o valor digitado
    // era igual ao que ja estava, o metodo saia aqui sem gravar nada: a contadora
    // conferia a nota inteira, voltava, e tudo aparecia como "a revisar". O trabalho
    // dela era descartado em silencio. Sem mudanca de valor nao ha evento de
    // alteracao, mas ha conferencia - e ela fica registrada.
    if (sets.length === 0) {
      eventos.push(
        this.evento({
          acao: 'alterar', entidade: 'item_nota', entidadeId: itemId,
          campo: 'conferido', valorAntes: null, valorDepois: 'sugestao confirmada',
          origem: 'manual',
        }),
      );
    }

    sets.push('revisado = 1', 'revisado_por = ?', 'revisado_em = ?');
    valores.push(this.ctx.sessao.usuarioId, agora(), this.tenant, itemId);

    await this.db
      .prepare(`UPDATE itens SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
      .bind(...valores)
      .run();

    await this.aud.registrarLote(eventos);
  }

  /**
   * Marca itens como conferidos sem mexer em valor nenhum. E o "eu olhei e concordo",
   * que precisa existir como acao propria: o caminho mais frequente da contadora e
   * dizer que o palpite do sistema esta certo.
   *
   * Devolve quantos itens foram marcados.
   */
  /**
   * Fixa o padrao de VARIOS itens de uma vez, cada um com o SEU proprio CFOP.
   *
   * E a diferenca para "Fixar para o fornecedor": aquele aplica UM CFOP a tudo
   * que estiver na tela; este promove o que ja esta la. Nenhum valor muda -
   * muda so o status de cada regra, que passa a valer a partir da proxima nota.
   *
   * Feito no servidor, em lote, porque a versao ingenua seria um laco de HTTP
   * no navegador: uma requisicao por item. Numa nota grande isso e minutos, e
   * qualquer falha no meio deixa metade feito sem ninguem saber. O leiaute da
   * NF-e admite ate 990 itens por nota.
   *
   * Devolve quantos foram fixados e quantos foram pulados por estarem sem CFOP.
   */
  async fixarPadraoDeItens(
    notaId: string,
    itemIds: string[],
  ): Promise<{ fixados: number; semCfop: number }> {
    if (itemIds.length === 0) return { fixados: 0, semCfop: 0 };

    const nota = await this.db
      .prepare('SELECT id, empresa_id, emit_cnpj FROM notas WHERE tenant_id = ? AND id = ?')
      .bind(this.tenant, notaId)
      .first<any>();
    if (!nota) throw new ForaDoEscopo('Nota não encontrada');
    this.exigirEmpresa(nota.empresa_id);
    const empresaId: string = nota.empresa_id;

    // Mesmo limite de sempre: o D1 corta em 100 parametros por consulta.
    const POR_VEZ = 60;
    const linhas: any[] = [];
    for (let i = 0; i < itemIds.length; i += POR_VEZ) {
      const fatia = itemIds.slice(i, i + POR_VEZ);
      const marcas = fatia.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(
          `SELECT * FROM itens
            WHERE tenant_id = ? AND nota_id = ? AND id IN (${marcas})`,
        )
        .bind(this.tenant, notaId, ...fatia)
        .all<any>();
      linhas.push(...results);
    }

    // Montar TODAS as regras primeiro, sem tocar no banco. A versao anterior
    // chamava aplicarAprendizado item a item: 4 consultas por item, 3.978 numa
    // nota de 990. Local roda em 103ms e esconde o problema; no D1 cada consulta
    // e uma ida e volta. E a terceira vez que este projeto tropeca em "o numero
    // de consultas importa mais que o milissegundo" - as outras duas foram o
    // limite de 100 parametros.
    let semCfop = 0;
    const acoes: { nivel: Nivel; chave: string; valor: string }[] = [];

    for (const l of linhas) {
      const cfop = String(l.cfop_novo ?? '').trim();
      // Fixar vazio nao fixa nada, e gravaria uma regra que manda preencher com
      // nada - pior que nao ter regra.
      if (!cfop) { semCfop += 1; continue; }

      const item = {
        nItem: l.n_item, cProd: l.c_prod, cEAN: l.c_ean, xProd: l.x_prod_original,
        NCM: l.ncm, CEST: l.cest, CFOP: l.cfop_original, uCom: l.unidade,
        qCom: l.quantidade, vUnCom: l.valor_unitario, vProd: l.valor_total,
        cstIcms: null, temIbsCbs: false,
      };

      for (const a of aprender({
        item, emitCnpj: nota.emit_cnpj, campo: 'cfop', valorFinal: cfop,
        sugestao: null, fixar: true, apenasNiveis: [1, 2],
      })) {
        if (a.tipo === 'criar') acoes.push({ nivel: a.nivel, chave: a.chave, valor: a.valor });
      }
    }

    if (acoes.length === 0) return { fixados: 0, semCfop };

    // Dois itens da MESMA nota podem gerar a mesma regra - e geram, sempre que
    // o mesmo produto aparece duas vezes (lotes diferentes, precos diferentes)
    // ou quando dois itens dividem o codigo de barras. Sem juntar aqui, o lote
    // manda dois INSERT com a mesma chave e o banco derruba a operacao inteira,
    // levando junto os 900 itens que estavam certos. O ultimo vale, que e como
    // se comporta o caminho de um item so: cada gravacao sobrescreve a anterior.
    const porChave = new Map<string, { nivel: Nivel; chave: string; valor: string }>();
    for (const a of acoes) porChave.set(`${a.nivel}\x00${a.chave}`, a);
    const unicas = [...porChave.values()];

    // Quais dessas regras ja existem? Uma consulta a cada 40 pares, nao uma por
    // regra. Cada par gasta 2 parametros; mais 3 fixos deixa folga no teto de 100.
    const POR_BUSCA = 40;
    const existentes = new Map<string, string>();
    for (let i = 0; i < unicas.length; i += POR_BUSCA) {
      const fatia = unicas.slice(i, i + POR_BUSCA);
      const onde = fatia.map(() => '(nivel = ? AND chave = ?)').join(' OR ');
      const binds: unknown[] = [this.tenant, empresaId, 'cfop'];
      for (const a of fatia) binds.push(a.nivel, a.chave);
      const { results } = await this.db
        .prepare(
          `SELECT id, nivel, chave FROM regras
            WHERE tenant_id = ? AND empresa_id = ? AND campo = ? AND (${onde})`,
        )
        .bind(...binds)
        .all<any>();
      for (const r of results) existentes.set(`${r.nivel}\x00${r.chave}`, r.id);
    }

    // Escrever em lotes. `batch` e uma ida e volta so, nao uma por comando.
    const quem = this.ctx.sessao.usuarioId;
    const quando = agora();
    const comandos = unicas.map((a) => {
      const id0 = existentes.get(`${a.nivel}\x00${a.chave}`);
      return id0
        ? this.db
            .prepare(
              `UPDATE regras SET valor = ?, fixada = 1, fixada_por = ?, fixada_em = ?,
                 atualizada_em = ?, suspeita = 0, erros_seguidos = 0
               WHERE tenant_id = ? AND id = ?`,
            )
            .bind(a.valor, quem, quando, quando, this.tenant, id0)
        : this.db
            .prepare(
              `INSERT INTO regras
                 (id, tenant_id, empresa_id, nivel, chave, campo, valor, confianca, ativa,
                  fixada, fixada_por, fixada_em, criada_em, criada_por)
               VALUES (?,?,?,?,?,?,?,0.5,1,1,?,?,?,?)`,
            )
            .bind(id(), this.tenant, empresaId, a.nivel, a.chave, 'cfop', a.valor,
                  quem, quando, quando, quem);
    });

    const POR_LOTE = 100;
    for (let i = 0; i < comandos.length; i += POR_LOTE) {
      await this.db.batch(comandos.slice(i, i + POR_LOTE));
    }

    const fixados = linhas.length - semCfop;

    await this.aud.registrar(
      this.evento({
        acao: 'alterar', entidade: 'nota', entidadeId: notaId,
        campo: 'padrao_fixado', valorAntes: null,
        valorDepois: `${fixados} item(ns) fixados em lote`,
        origem: 'manual',
      }),
    );

    return { fixados, semCfop };
  }

  /**
   * A trilha de um item: o que mudou, quem mudou, quando, e o que havia antes.
   *
   * A trilha e gravada desde o primeiro dia e ate hoje nao havia como ler. Duas
   * coisas dependiam disso: o pedido da contadora no primeiro uso real - "me
   * arrependi, quero ver como que tava" - e o compromisso de contrato de manter
   * "registro de quem lancou e alterou o que". Estava prometido e invisivel.
   *
   * O escopo e conferido pela nota do item, nao pelo item: a trilha revela CNPJ
   * e valores de cliente de terceiro, entao quem nao pode ver a nota nao pode
   * ver o historico dela.
   */
  async trilhaDoItem(itemId: string): Promise<any[]> {
    const linha = await this.db
      .prepare(
        `SELECT i.id, n.empresa_id FROM itens i
          JOIN notas n ON n.id = i.nota_id
         WHERE i.tenant_id = ? AND i.id = ?`,
      )
      .bind(this.tenant, itemId)
      .first<any>();
    if (!linha) throw new ForaDoEscopo('Item não encontrado');
    this.exigirEmpresa(linha.empresa_id);

    const { results } = await this.db
      .prepare(
        `SELECT quando, usuario_email, acao, campo, valor_antes, valor_depois, origem
           FROM auditoria
          WHERE tenant_id = ? AND entidade = 'item_nota' AND entidade_id = ?
          ORDER BY id DESC LIMIT 100`,
      )
      .bind(this.tenant, itemId)
      .all<any>();
    return results;
  }

  async conferirItens(notaId: string, itemIds: string[]): Promise<number> {
    if (itemIds.length === 0) return 0;

    const nota = await this.db
      .prepare('SELECT empresa_id FROM notas WHERE tenant_id = ? AND id = ?')
      .bind(this.tenant, notaId)
      .first<any>();
    if (!nota) throw new ForaDoEscopo('Nota não encontrada');
    this.exigirEmpresa(nota.empresa_id);

    // O D1 aceita 100 parametros por consulta; cada id gasta um.
    const POR_VEZ = 60;
    const quando = agora();
    let marcados = 0;

    for (let i = 0; i < itemIds.length; i += POR_VEZ) {
      const fatia = itemIds.slice(i, i + POR_VEZ);
      const marcas = fatia.map(() => '?').join(',');
      const r = await this.db
        .prepare(
          `UPDATE itens SET revisado = 1, revisado_por = ?, revisado_em = ?
            WHERE tenant_id = ? AND nota_id = ? AND revisado = 0 AND id IN (${marcas})`,
        )
        .bind(this.ctx.sessao.usuarioId, quando, this.tenant, notaId, ...fatia)
        .run();
      marcados += Number(r.meta?.changes ?? 0);
    }

    if (marcados > 0) {
      await this.aud.registrarLote([
        this.evento({
          acao: 'alterar', entidade: 'nota', entidadeId: notaId,
          campo: 'conferido', valorAntes: null, valorDepois: `${marcados} item(ns)`,
          origem: 'manual',
        }),
      ]);
    }
    return marcados;
  }

  /** Desfaz a conferencia de um item - o "me arrependi". */
  async desconferirItem(itemId: string): Promise<void> {
    const atual = await this.db
      .prepare(
        `SELECT i.id, n.empresa_id FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE i.tenant_id = ? AND i.id = ?`,
      )
      .bind(this.tenant, itemId)
      .first<any>();
    if (!atual) throw new ForaDoEscopo('Item não encontrado');
    this.exigirEmpresa(atual.empresa_id);

    await this.db
      .prepare(
        `UPDATE itens SET revisado = 0, revisado_por = NULL, revisado_em = NULL
          WHERE tenant_id = ? AND id = ?`,
      )
      .bind(this.tenant, itemId)
      .run();

    await this.aud.registrarLote([
      this.evento({
        acao: 'alterar', entidade: 'item_nota', entidadeId: itemId,
        campo: 'conferido', valorAntes: 'sim', valorDepois: 'não', origem: 'manual',
      }),
    ]);
  }

  // ---------------------------------------------------------------- histórico de produto

  /**
   * O que ja sabiamos sobre cada produto deste fornecedor, nesta empresa.
   * Alimenta os alertas de divergencia (src/rules/alertas.ts).
   *
   * Uma consulta so para a nota inteira - nao uma por item.
   */
  async carregarHistoricoProdutos(
    empresaId: string,
    emitCnpj: string,
    excluirNotaId: string | null,
  ): Promise<Map<string, import('../rules/alertas').HistoricoProduto>> {
    const { results } = await this.db
      .prepare(
        `WITH hist AS (
           SELECT i.c_prod, i.ncm, i.cst_origem, TRIM(COALESCE(i.cfop_original, '')) AS cfop_original,
                  i.unidade, i.c_ean, i.x_prod_original, n.dh_emi,
                  ROW_NUMBER() OVER (PARTITION BY i.c_prod, TRIM(COALESCE(i.cfop_original, '')) ORDER BY n.dh_emi DESC) AS rn,
                  COUNT(*)   OVER (PARTITION BY i.c_prod, TRIM(COALESCE(i.cfop_original, ''))) AS vezes,
                  AVG(i.valor_unitario) OVER (PARTITION BY i.c_prod, TRIM(COALESCE(i.cfop_original, ''))) AS preco_medio
           -- CROSS JOIN fixa a ordem: primeiro as notas DESTE fornecedor (indice
           -- idx_notas_empresa_emit), depois os itens delas. Sem isso o SQLite
           -- partia dos itens do escritorio inteiro - linha lida e linha paga no D1.
           FROM notas n
           CROSS JOIN itens i ON i.nota_id = n.id
           WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.emit_cnpj = ?
             AND i.c_prod IS NOT NULL AND (? IS NULL OR n.id != ?)
         )
         SELECT * FROM hist WHERE rn = 1`,
      )
      .bind(this.tenant, empresaId, emitCnpj, excluirNotaId, excluirNotaId)
      .all<any>();

    // Uma ficha por OPERACAO (CFOP de saida) do produto, e a mais recente de todas no
    // topo - como antes. Os alertas comparam com a MESMA operacao (22/09): a nota de
    // ajuste 5949, com valor simbolico, fazia a compra normal seguinte gritar
    // "Preco +5950% do historico" - e a compra nunca teve preco diferente.
    type H = import('../rules/alertas').HistoricoProduto;
    const mapa = new Map<string, H>();
    for (const r of results) {
      const cp = String(r.c_prod).trim().toUpperCase();
      const ficha: H = {
        vezesVisto: r.vezes ?? 0,
        ncm: r.ncm ?? null,
        cstOrigem: r.cst_origem ?? null,
        cfopOrigem: r.cfop_original || null,
        unidade: r.unidade ?? null,
        cEAN: r.c_ean ?? null,
        xProdFornecedor: r.x_prod_original ?? null,
        precoMedio: r.preco_medio ?? null,
        ultimaVezEm: r.dh_emi ?? null,
      };
      const atual = mapa.get(cp);
      const porOperacao = { ...(atual?.porOperacao ?? {}), [r.cfop_original]: ficha };
      const vezes = (atual?.vezesVisto ?? 0) + ficha.vezesVisto;
      const topo = !atual || String(ficha.ultimaVezEm ?? '') > String(atual.ultimaVezEm ?? '') ? ficha : atual;
      mapa.set(cp, { ...topo, vezesVisto: vezes, porOperacao });
    }
    return mapa;
  }

  /**
   * A ficha das regras que preencheram os itens de uma nota.
   *
   * Existe para a tela poder dizer DE ONDE veio cada valor: "padrao que voces
   * fixaram", "o sistema aprendeu com voces, ja usou 3x" ou "chute do perfil".
   * Sem isto tudo vira o mesmo "Pronto" verde, e a contadora nao tem como saber
   * se o sistema aprendeu alguma coisa com ela - que e a promessa do produto.
   *
   * Fatiada em 90 porque `IN (...)` gasta um parametro por id, e o D1 corta em
   * 100. Uma nota de 50 itens ja chega perto: sao ate dois campos com regra por
   * item. O mesmo erro ja tinha aparecido em carregarRegrasCandidatas.
   */
  async regrasDeOrigem(
    empresaId: string,
    regraIds: string[],
  ): Promise<Map<string, FichaRegra>> {
    const unicos = [...new Set(regraIds.filter(Boolean))];
    const mapa = new Map<string, FichaRegra>();
    if (unicos.length === 0) return mapa;

    const POR_CONSULTA = 90;
    for (let i = 0; i < unicos.length; i += POR_CONSULTA) {
      const fatia = unicos.slice(i, i + POR_CONSULTA);
      const { results } = await this.db
        .prepare(
          `SELECT id, nivel, usos, acertos, erros, fixada, suspeita
             FROM regras WHERE tenant_id = ? AND empresa_id = ?
              AND id IN (${fatia.map(() => '?').join(',')})`,
        )
        .bind(this.tenant, empresaId, ...fatia)
        .all<any>();
      for (const r of results) {
        mapa.set(r.id, {
          id: r.id,
          nivel: r.nivel,
          usos: r.usos ?? 0,
          acertos: r.acertos ?? 0,
          erros: r.erros ?? 0,
          fixada: r.fixada === 1,
          suspeita: r.suspeita === 1,
        });
      }
    }
    return mapa;
  }

  // ---------------------------------------------------------------- notas

  async notaExiste(chave: string): Promise<boolean> {
    const r = await this.db
      .prepare('SELECT 1 AS x FROM notas WHERE tenant_id = ? AND chave = ?')
      .bind(this.tenant, chave)
      .first();
    return r !== null;
  }

  /**
   * Como esta a nota desta chave: existe? quantos itens, quantos ja conferidos?
   *
   * Serve ao aviso de importacao repetida. A contadora importa quinzenal (dia 1-15,
   * depois 1-30) e precisa LER que o que ela ja tratou nao foi tocado - "duplicada"
   * sozinho nao diz isso.
   */
  async situacaoDaNota(
    chave: string,
  ): Promise<{ id: string; numero: string | null; emitNome: string | null; itens: number; revisados: number; empresaId: string; cancelada: boolean } | null> {
    const l = await this.db
      .prepare(
        `SELECT n.id AS id, n.numero AS numero, n.emit_nome AS emit_nome,
                n.empresa_id AS empresa_id, n.cancelada_em AS cancelada_em,
                (SELECT COUNT(*) FROM itens i WHERE i.nota_id = n.id) AS itens,
                (SELECT COUNT(*) FROM itens i WHERE i.nota_id = n.id AND i.revisado = 1) AS revisados
           FROM notas n WHERE n.tenant_id = ? AND n.chave = ?`,
      )
      .bind(this.tenant, chave)
      .first<any>();
    if (!l) return null;
    return {
      id: l.id, numero: l.numero ?? null, emitNome: l.emit_nome ?? null,
      itens: Number(l.itens), revisados: Number(l.revisados),
      empresaId: l.empresa_id, cancelada: !!l.cancelada_em,
    };
  }

  /**
   * Nota gravada sem item nenhum e importacao que morreu no meio, nao duplicata.
   * Sem isto ela fica presa na tela para sempre: nao tem item para tratar e
   * bloqueia o reenvio do mesmo arquivo com "duplicada". Devolve true se
   * removeu alguma.
   */
  async limparNotaSemItens(chave: string): Promise<boolean> {
    const linha = await this.db
      .prepare(
        `SELECT n.id AS id, (SELECT COUNT(*) FROM itens i WHERE i.nota_id = n.id) AS itens
           FROM notas n WHERE n.tenant_id = ? AND n.chave = ?`,
      )
      .bind(this.tenant, chave)
      .first<any>();

    if (!linha || Number(linha.itens) > 0) return false;

    await this.db
      .prepare('DELETE FROM notas WHERE tenant_id = ? AND id = ?')
      .bind(this.tenant, linha.id)
      .run();
    return true;
  }

  /**
   * Marca (ou desmarca) a nota como cancelada. A nota fica, com a chave; passa a valer
   * zero nas somas, relatorios e exportacao. Reversivel e registrado na trilha.
   * Devolve false se ja estava no estado pedido (evento reimportado nao repete a trilha).
   */
  async marcarCancelada(notaId: string, cancelar: boolean, motivo: string, origem: Origem): Promise<boolean> {
    const n = await this.db
      .prepare('SELECT id, empresa_id, cancelada_em, cancelada_motivo FROM notas WHERE tenant_id = ? AND id = ?')
      .bind(this.tenant, notaId)
      .first<any>();
    if (!n) throw new ForaDoEscopo('Nota não encontrada');
    this.exigirEmpresa(n.empresa_id);
    if (!!n.cancelada_em === cancelar) return false;
    const quando = agora();
    await this.db
      .prepare('UPDATE notas SET cancelada_em = ?, cancelada_por = ?, cancelada_motivo = ? WHERE tenant_id = ? AND id = ?')
      .bind(cancelar ? quando : null, cancelar ? this.ctx.sessao.usuarioId : null, cancelar ? motivo : null, this.tenant, notaId)
      .run();
    await this.aud.registrarLote([
      this.evento({
        acao: 'alterar', entidade: 'nota', entidadeId: notaId, campo: 'cancelada',
        valorAntes: n.cancelada_em ? `cancelada (${n.cancelada_motivo ?? ''})` : 'não',
        valorDepois: cancelar ? `cancelada (${motivo})` : `não (${motivo})`,
        origem,
      }),
    ]);
    return true;
  }

  /** Quantas notas canceladas ficaram fora do recorte (para o aviso do relatorio). */
  async contarCanceladas(empresaId: string, competencia?: string): Promise<number> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia);
    const l = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM notas n WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NOT NULL ${r.sql}`)
      .bind(this.tenant, empresaId, ...r.binds)
      .first<any>();
    return Number(l?.n ?? 0);
  }

  /**
   * Procura itens em TODAS as notas da empresa (pedido da Taís, 23/09: "tratei um produto
   * errado, só sei que é energético, não sei a nota"). Por texto (descrição do fornecedor
   * ou padronizada, código, EAN, NCM, número da nota) ou pelo produto do relatório por
   * produto (descrição tratada + unidade, a mesma chave de agrupamento). Mais recentes antes.
   */
  async buscarItens(
    empresaId: string,
    filtro: { texto?: string; produto?: string; unidade?: string; competencia?: string },
  ): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const onde: string[] = [];
    const binds: unknown[] = [this.tenant, empresaId];
    if (filtro.texto) {
      const f = filtroDeBusca(filtro.texto);
      onde.push(f.sql);
      binds.push(...f.binds);
    }
    if (filtro.produto !== undefined) {
      onde.push("UPPER(TRIM(COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original))) = UPPER(TRIM(?))");
      binds.push(filtro.produto);
      onde.push("UPPER(TRIM(COALESCE(i.unidade, ''))) = UPPER(TRIM(?))");
      binds.push(filtro.unidade ?? '');
    }
    const r = this.recorteCompetencia(filtro.competencia);
    const { results } = await this.db
      .prepare(
        `SELECT i.id AS item_id, i.n_item, i.x_prod_original, i.x_prod_novo, i.c_prod, i.c_ean, i.ncm,
                i.unidade, i.quantidade, i.valor_total, i.cfop_original, i.cfop_novo, i.revisado, i.revisado_em,
                u.nome AS revisado_por_nome,
                n.id AS nota_id, n.numero, n.dh_emi, n.emit_nome, n.emit_cnpj, n.competencia, n.cancelada_em
           FROM itens i JOIN notas n ON n.id = i.nota_id
           LEFT JOIN usuarios u ON u.id = i.revisado_por
          WHERE n.tenant_id = ? AND n.empresa_id = ? ${onde.length ? 'AND ' + onde.join(' AND ') : ''} ${r.sql}
          ORDER BY n.dh_emi DESC, n.numero, i.n_item
          LIMIT 200`,
      )
      .bind(...binds, ...r.binds)
      .all<any>();
    return results;
  }

  /**
   * A mesma busca nas OUTRAS empresas que a pessoa pode ver, so contando. Quando a
   * busca volta vazia, a tela diz "achei na empresa X" em vez de um silencio (24/09:
   * "botei rescaroli e nao puxou").
   */
  async buscarEmOutrasEmpresas(empresaAtual: string, texto: string): Promise<{ empresaId: string; razaoSocial: string; itens: number }[]> {
    const f = filtroDeBusca(texto);
    const { results } = await this.db
      .prepare(
        `SELECT n.empresa_id AS empresa_id, e.razao_social AS razao_social, COUNT(*) AS itens
           FROM itens i JOIN notas n ON n.id = i.nota_id JOIN empresas e ON e.id = n.empresa_id
          WHERE n.tenant_id = ? AND n.empresa_id <> ? AND ${f.sql}
          GROUP BY n.empresa_id, e.razao_social
          ORDER BY itens DESC`,
      )
      .bind(this.tenant, empresaAtual, ...f.binds)
      .all<any>();
    return results
      .filter((r: any) => podeVerEmpresa(this.ctx.sessao, r.empresa_id))
      .map((r: any) => ({ empresaId: r.empresa_id, razaoSocial: r.razao_social, itens: Number(r.itens) }));
  }

  /**
   * O que foi alterado por ultimo nos itens desta empresa, pela trilha (so mudanca de
   * valor - conferir nao entra). Para "nao sei qual foi a ultima que eu fiz" (23/09).
   */
  async ultimasAlteracoes(empresaId: string, limite = 50): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT a.quando, a.usuario_email, a.campo, a.valor_antes, a.valor_depois, a.origem,
                i.id AS item_id, i.n_item, i.x_prod_original, i.x_prod_novo, i.c_prod, i.cfop_novo,
                n.id AS nota_id, n.numero, n.dh_emi, n.emit_nome
           FROM auditoria a
           JOIN itens i ON i.id = a.entidade_id
           JOIN notas n ON n.id = i.nota_id
          WHERE a.tenant_id = ? AND a.entidade = 'item_nota' AND n.empresa_id = ?
            AND a.campo IS NOT NULL AND a.campo <> 'conferido'
          ORDER BY a.id DESC
          LIMIT ?`,
      )
      .bind(this.tenant, empresaId, Math.min(Math.max(limite, 1), 200))
      .all<any>();
    return results;
  }

  /**
   * Notas da empresa, opcionalmente recortadas por competencia.
   *
   * `competencia` aceita "2026-09" (um mes) ou "2026" (o ano inteiro). O ano
   * existe porque a contadora pensa primeiro em ano e depois em mes - e porque
   * uma empresa com 200 notas nao se acha numa lista unica.
   */
  async listarNotas(empresaId: string, competencia?: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const soAno = competencia !== undefined && /^\d{4}$/.test(competencia);
    const filtro = competencia ? (soAno ? 'AND competencia LIKE ?' : 'AND competencia = ?') : '';
    const alvo = soAno ? `${competencia}-%` : competencia;
    const binds = competencia ? [this.tenant, empresaId, alvo] : [this.tenant, empresaId];
    const { results } = await this.db
      .prepare(
        `SELECT n.*,
                (SELECT COUNT(*) FROM itens i WHERE i.nota_id = n.id) AS total_itens,
                (SELECT COUNT(*) FROM itens i WHERE i.nota_id = n.id AND i.revisado = 1) AS itens_revisados,
                (SELECT COUNT(*) FROM itens i WHERE i.nota_id = n.id
                    AND (i.cfop_novo IS NULL OR TRIM(i.cfop_novo) = '')) AS itens_sem_cfop
         FROM notas n WHERE n.tenant_id = ? AND n.empresa_id = ? ${filtro}
         ORDER BY n.dh_emi DESC LIMIT 500`,
      )
      .bind(...binds)
      .all<any>();
    return results;
  }

  // ---------------------------------------------------------------- valores fiscais

  /** Notas da competencia com item ainda sem valores fiscais (importado antes da 0013). */
  async notasSemValoresFiscais(empresaId: string, competencia?: string): Promise<{ id: string; r2_original: string | null }[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia);
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT n.id AS id, n.r2_original AS r2_original
           FROM notas n JOIN itens i ON i.nota_id = n.id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND i.valores_lidos = 0 ${r.sql}`,
      )
      .bind(this.tenant, empresaId, ...r.binds)
      .all<any>();
    return results;
  }

  /**
   * Grava os valores fiscais lidos do XML original, um batch por nota.
   * E copia do documento, como a importacao - nao e decisao de ninguem, por isso
   * nao entra na trilha (a importacao tambem nao grava item a item).
   */
  async gravarValoresFiscais(notaId: string, porItem: { nItem: number; valores: number[] }[]): Promise<void> {
    if (porItem.length === 0) return;
    const stmts = porItem.map((p) =>
      this.db
        .prepare(
          `UPDATE itens SET v_desc = ?, v_frete = ?, v_seg = ?, v_outro = ?, v_bc_icms = ?, v_icms = ?,
                  v_bc_st = ?, v_st = ?, v_fcp_st = ?, v_ipi = ?, valor_contabil = ?, valores_lidos = 1
            WHERE tenant_id = ? AND nota_id = ? AND n_item = ?`,
        )
        .bind(...p.valores, this.tenant, notaId, p.nItem),
    );
    await this.db.batch(stmts);
  }

  // ---------------------------------------------------------------- relatorios
  //
  // So leitura e so agregacao: o formato e o CSV moram em src/relatorios.
  // Uma consulta por relatorio, qualquer que seja o tamanho da competencia.

  private recorteCompetencia(competencia?: string): { sql: string; binds: string[] } {
    if (!competencia) return { sql: '', binds: [] };
    return /^\d{4}$/.test(competencia)
      ? { sql: 'AND n.competencia LIKE ?', binds: [`${competencia}-%`] }
      : { sql: 'AND n.competencia = ?', binds: [competencia] };
  }

  async relatorioCfop(empresaId: string, competencia?: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia);
    const { results } = await this.db
      .prepare(
        `SELECT i.cfop_novo AS cfop_novo, i.cfop_original AS cfop_original,
                COUNT(*) AS itens, SUM(i.revisado) AS conferidos, SUM(i.valor_total) AS valor,
                SUM(COALESCE(i.valor_contabil, i.valor_total)) AS valor_contabil,
                SUM(COALESCE(i.v_bc_icms, 0)) AS v_bc, SUM(COALESCE(i.v_icms, 0)) AS v_icms,
                SUM(COALESCE(i.v_st, 0) + COALESCE(i.v_fcp_st, 0)) AS v_st, SUM(COALESCE(i.v_ipi, 0)) AS v_ipi,
                GROUP_CONCAT(DISTINCT n.id) AS notas
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL ${r.sql}
          GROUP BY i.cfop_novo, i.cfop_original`,
      )
      .bind(this.tenant, empresaId, ...r.binds)
      .all<any>();
    return results;
  }

  /**
   * Analitico: um item por linha, com a nota e os valores fiscais. `cfop` filtra
   * pelo CFOP de ENTRADA (o que ela tratou); vazio = todos. '(sem CFOP)' = sem CFOP.
   */
  async relatorioAnalitico(empresaId: string, competencia?: string, cfop?: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia);
    const filtro = cfop === undefined ? '' : cfop === '(sem CFOP)'
      ? "AND TRIM(COALESCE(i.cfop_novo, '')) = ''"
      : 'AND TRIM(i.cfop_novo) = ?';
    const binds = cfop === undefined || cfop === '(sem CFOP)' ? [] : [cfop];
    const { results } = await this.db
      .prepare(
        `SELECT n.id AS nota_id, n.numero, n.serie, n.dh_emi, n.chave, n.emit_cnpj, n.emit_nome, n.emit_uf,
                n.valor_total AS valor_nota, n.competencia,
                i.id AS item_id, i.n_item, i.c_prod, i.x_prod_original, i.x_prod_novo, i.ncm, i.unidade,
                i.quantidade, i.valor_unitario, i.valor_total, i.cfop_original, i.cfop_novo, i.revisado,
                COALESCE(i.v_desc, 0) AS v_desc, COALESCE(i.v_frete, 0) AS v_frete, COALESCE(i.v_seg, 0) AS v_seg,
                COALESCE(i.v_outro, 0) AS v_outro, COALESCE(i.v_bc_icms, 0) AS v_bc, COALESCE(i.v_icms, 0) AS v_icms,
                COALESCE(i.v_st, 0) + COALESCE(i.v_fcp_st, 0) AS v_st, COALESCE(i.v_ipi, 0) AS v_ipi,
                COALESCE(i.valor_contabil, i.valor_total) AS valor_contabil
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL ${r.sql} ${filtro}
          ORDER BY n.dh_emi, n.numero, i.n_item
          LIMIT 20000`,
      )
      .bind(this.tenant, empresaId, ...r.binds, ...binds)
      .all<any>();
    return results;
  }

  async relatorioProdutos(empresaId: string, competencia?: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia);
    const { results } = await this.db
      .prepare(
        `SELECT MIN(COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original)) AS descricao,
                UPPER(TRIM(COALESCE(i.unidade, ''))) AS unidade,
                SUM(i.quantidade) AS quantidade, SUM(i.valor_total) AS valor,
                COUNT(*) AS itens, SUM(i.revisado) AS conferidos,
                COUNT(DISTINCT n.id) AS notas, COUNT(DISTINCT n.emit_cnpj) AS fornecedores,
                GROUP_CONCAT(DISTINCT i.c_prod) AS codigos,
                GROUP_CONCAT(DISTINCT i.cfop_novo) AS cfops,
                MIN(i.x_prod_original) AS descricao_original,
                COUNT(DISTINCT i.x_prod_original) AS descricoes_originais
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL ${r.sql}
          GROUP BY UPPER(TRIM(COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original))),
                   UPPER(TRIM(COALESCE(i.unidade, '')))`,
      )
      .bind(this.tenant, empresaId, ...r.binds)
      .all<any>();
    return results;
  }

  /**
   * Importacoes da empresa: os lotes de um mesmo envio (envio_id) viram UMA
   * importacao, com os resultados por arquivo somados. Lote sem envio_id (antes
   * da migracao 0011) e uma importacao sozinho.
   */
  async listarImportacoes(empresaId: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT l.id, l.envio_id, l.criado_em, l.criado_por, l.total_arquivos, l.importadas,
                l.duplicadas, l.recusadas, l.detalhe,
                (SELECT u.nome FROM usuarios u WHERE u.id = l.criado_por) AS quem,
                (SELECT COUNT(*) FROM notas n WHERE n.lote_id = l.id) AS notas
           FROM lotes_importacao l
          WHERE l.tenant_id = ? AND l.empresa_id = ?
          ORDER BY l.criado_em DESC LIMIT 400`,
      )
      .bind(this.tenant, empresaId)
      .all<any>();

    const porEnvio = new Map<string, any>();
    for (const l of results) {
      const chave = l.envio_id ?? l.id;
      const e = porEnvio.get(chave) ?? {
        id: chave, criadoEm: l.criado_em, quem: l.quem ?? null, lotes: [] as string[],
        arquivos: 0, importadas: 0, duplicadas: 0, recusadas: 0, eventos: 0, notas: 0,
        resultados: [] as any[],
      };
      if (l.criado_em < e.criadoEm) e.criadoEm = l.criado_em;
      e.lotes.push(l.id);
      e.arquivos += Number(l.total_arquivos);
      e.importadas += Number(l.importadas);
      e.duplicadas += Number(l.duplicadas);
      e.recusadas += Number(l.recusadas);
      e.notas += Number(l.notas);
      let detalhe: any[] = [];
      try { detalhe = JSON.parse(l.detalhe ?? '[]'); } catch { detalhe = []; }
      e.eventos += detalhe.filter((d) => d?.status === 'evento').length;
      e.resultados.push(...detalhe);
      porEnvio.set(chave, e);
    }
    return [...porEnvio.values()].sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
  }

  /**
   * As competencias que a empresa tem, com quantas notas em cada.
   *
   * Existe porque a lista de meses NAO pode sair das notas ja filtradas: o
   * seletor se destruia sozinho. Ao escolher setembro, a busca voltava so com
   * setembro, o seletor era remontado a partir dessa resposta, e agosto sumia
   * da lista. Para trocar de mes era preciso voltar em "todas" primeiro - e
   * quem nao descobrisse isso concluia que as notas de agosto tinham sumido.
   * Opcao de filtro tem que vir do universo inteiro, nunca do resultado.
   */
  async competenciasDaEmpresa(empresaId: string): Promise<{ competencia: string; notas: number }[]> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT competencia, COUNT(*) AS notas FROM notas
         WHERE tenant_id = ? AND empresa_id = ? AND competencia IS NOT NULL
         GROUP BY competencia ORDER BY competencia DESC`,
      )
      .bind(this.tenant, empresaId)
      .all<{ competencia: string; notas: number }>();
    return results;
  }

  async obterNotaComItens(notaId: string): Promise<{ nota: any; itens: any[] } | null> {
    const nota = await this.db
      .prepare('SELECT * FROM notas WHERE tenant_id = ? AND id = ?')
      .bind(this.tenant, notaId)
      .first<any>();
    if (!nota) return null;
    this.exigirEmpresa(nota.empresa_id);
    // O nome de quem conferiu vem junto: "conferido" sem dono nao serve de nada
    // num escritorio com varias pessoas na mesma nota.
    const { results } = await this.db
      .prepare(
        `SELECT i.*, u.nome AS revisado_por_nome
           FROM itens i LEFT JOIN usuarios u ON u.id = i.revisado_por
          WHERE i.tenant_id = ? AND i.nota_id = ? ORDER BY i.n_item`,
      )
      .bind(this.tenant, notaId)
      .all<any>();
    return { nota, itens: results };
  }

  auditoria(): Auditoria {
    return this.aud;
  }

  novoId = id;
  agora = agora;

  get bd(): D1Database {
    return this.db;
  }

  get contexto(): ContextoRequisicao {
    return this.ctx;
  }
}

/**
 * O WHERE da busca de itens (24/09). Cada palavra digitada tem que aparecer em algum
 * lugar - "energ lata" acha "ENERGETICO LATA 473ML" -, e cada palavra e procurada em:
 * descricao do fornecedor e padronizada (sem acento), codigo do produto, EAN, NCM,
 * numero da nota, NOME e CNPJ do fornecedor, e - se parecer valor ("1.234,56",
 * "289", "38.40") - no total da nota, no valor do item e no valor contabil.
 * "%" e "_" digitados sao letra, nao curinga.
 */
function filtroDeBusca(texto: string): { sql: string; binds: unknown[] } {
  const esc = (v: string) => v.replace(/[\\%_]/g, (c) => '\\' + c);
  const semAcento = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const semAcentoSql = (col: string) =>
    ACENTOS.reduce((expr, [de, para]) => `REPLACE(${expr}, '${de}', '${para}')`, `COALESCE(${col}, '')`);
  const colunas = [
    `UPPER(${semAcentoSql('i.x_prod_original')})`, `UPPER(${semAcentoSql('i.x_prod_novo')})`,
    "UPPER(COALESCE(i.c_prod, ''))", "COALESCE(i.c_ean, '')", "COALESCE(i.ncm, '')", "COALESCE(n.numero, '')",
    `UPPER(${semAcentoSql('n.emit_nome')})`,
  ];
  const palavras = texto.trim().split(/\s+/).filter((p) => p && !/^R\$$/i.test(p)).slice(0, 6);
  const e: string[] = [];
  const binds: unknown[] = [];
  for (const p of palavras) {
    const ou: string[] = [];
    const padrao = `%${esc(semAcento(p))}%`;
    for (const c of colunas) { ou.push(`${c} LIKE ? ESCAPE '\\'`); binds.push(padrao); }
    // CNPJ do fornecedor com ou sem pontuacao (um pedaco de 6+ digitos; valor com virgula nao).
    const digitos = p.replace(/\D/g, '');
    if (digitos.length >= 6 && !p.includes(',')) { ou.push("COALESCE(n.emit_cnpj, '') LIKE ?"); binds.push(`%${digitos}%`); }
    const valor = comoValor(p);
    if (valor !== null) {
      ou.push('ROUND(n.valor_total, 2) = ?', 'ROUND(i.valor_total, 2) = ?', 'ROUND(COALESCE(i.valor_contabil, -1), 2) = ?');
      binds.push(valor, valor, valor);
    }
    e.push(`(${ou.join(' OR ')})`);
  }
  return { sql: e.length ? `(${e.join(' AND ')})` : '1', binds };
}

/** "1.234,56" / "1234,56" / "1234.56" / "289" -> numero; o resto -> null. */
export function comoValor(p: string): number | null {
  const t = p.trim().replace(/^R\$/i, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;
  let n: string;
  if (t.includes(',')) n = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) n = t.replace(/\./g, '');
  else n = t;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

/** Letras acentuadas -> sem acento, para a busca de produto (o SQLite nao sabe fazer). */
const ACENTOS: [string, string][] = [
  ...'ÁÀÂÃÄáàâãä'.split('').map((c) => [c, 'A'] as [string, string]),
  ...'ÉÈÊËéèêë'.split('').map((c) => [c, 'E'] as [string, string]),
  ...'ÍÌÎÏíìîï'.split('').map((c) => [c, 'I'] as [string, string]),
  ...'ÓÒÔÕÖóòôõö'.split('').map((c) => [c, 'O'] as [string, string]),
  ...'ÚÙÛÜúùûü'.split('').map((c) => [c, 'U'] as [string, string]),
  ['Ç', 'C'], ['ç', 'C'], ['Ñ', 'N'], ['ñ', 'N'],
];

function linhaParaRegra(l: any): Regra {
  return {
    id: l.id,
    nivel: l.nivel as Nivel,
    chave: l.chave,
    campo: l.campo as Campo,
    valor: l.valor,
    usos: l.usos ?? 0,
    acertos: l.acertos ?? 0,
    erros: l.erros ?? 0,
    errosSeguidos: l.erros_seguidos ?? 0,
    confianca: l.confianca ?? recalcularConfianca({ acertos: l.acertos ?? 0, erros: l.erros ?? 0 }),
    ativa: (l.ativa ?? 1) === 1,
    suspeita: (l.suspeita ?? 0) === 1,
    fixada: (l.fixada ?? 0) === 1,
  };
}
