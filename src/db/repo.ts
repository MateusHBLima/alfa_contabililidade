import { Auditoria, type EventoAuditoria, type Origem } from './auditoria';
import { chaveProduto } from '../relatorios/relatorios';
import type { Sessao } from '../auth/permissoes';
import { podeVerEmpresa } from '../auth/permissoes';
import type { Campo } from '../rules/campos';
import type { Nivel, Regra } from '../rules/engine';
import { aplicarAcerto, aplicarErro, aprender, recalcularConfianca, partesDaChave, chaveDoNivel, chavesDoItem, regrasDoItem, sugerir } from '../rules/engine';

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


/** Periodo de emissao, AAAA-MM-DD, inclusive nas duas pontas. */
export type Periodo = { de?: string; ate?: string };

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
  /** Feito pela busca automática (cron), em nome de quem a ligou. Nos registros aparece como "Busca automática". */
  automatica?: boolean;
};

/** Como a busca automática aparece na trilha, no histórico e nas importações. */
export const NOME_BUSCA_AUTOMATICA = 'Busca automática';

/** O que a tela precisa saber sobre a regra que preencheu um item. */
export type FichaRegra = {
  id: string;
  nivel: number;
  /** o valor que a regra diz HOJE (pode ter mudado depois que a linha foi conferida) */
  valor: string;
  usos: number;
  acertos: number;
  erros: number;
  fixada: boolean;
  suspeita: boolean;
};

/**
 * Gravar regra que ja existe atualiza em vez de estourar (13/10, Filomena).
 *
 * Antes cada caminho fazia "procura; se nao achar, insere". Duas gravacoes do
 * mesmo produto chegando juntas - empresa nova, nenhuma regra ainda - liam "nao
 * existe" as duas, a segunda batia na unicidade, voltava "este registro ja
 * existe" e o item dela nao era salvo: o CFOP voltava para o que estava.
 *
 * Mesma regra de sempre: vale a decisao mais recente, menos em regra fixada,
 * que so outra fixacao explicita muda. Valor igual sem fixar nao mexe em nada.
 */
const SE_A_REGRA_JA_EXISTE = `
  ON CONFLICT (tenant_id, empresa_id, nivel, chave, campo) DO UPDATE SET
    valor = excluded.valor, atualizada_em = excluded.criada_em, suspeita = 0, erros_seguidos = 0,
    fixada = MAX(regras.fixada, excluded.fixada),
    fixada_por = COALESCE(excluded.fixada_por, regras.fixada_por),
    fixada_em = COALESCE(excluded.fixada_em, regras.fixada_em)
  WHERE excluded.fixada = 1 OR (regras.fixada = 0 AND regras.valor <> excluded.valor)`;

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
      usuarioEmail: this.quemNaTrilha,
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
    // Mesma regra de podeVerEmpresa: "ver todos os clientes" vale com ou sem vínculo.
    return results.filter((e) => podeVerEmpresa(this.ctx.sessao, e.id));
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
               VALUES (?,?,?,?,?,?,?,0.5,1,?,?,?,?,?) ${SE_A_REGRA_JA_EXISTE}`,
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

      // criar / atualizar numa instrucao so (ver SE_A_REGRA_JA_EXISTE).
      const quando = agora();
      const quem = this.ctx.sessao.usuarioId;
      await this.db
        .prepare(
          `INSERT INTO regras
             (id, tenant_id, empresa_id, nivel, chave, campo, valor, confianca, ativa,
              fixada, fixada_por, fixada_em, criada_em, criada_por)
           VALUES (?,?,?,?,?,?,?,0.5,1,?,?,?,?,?) ${SE_A_REGRA_JA_EXISTE}`,
        )
        .bind(
          id(), this.tenant, empresaId, acao.nivel, acao.chave, acao.campo, acao.valor,
          acao.fixada ? 1 : 0, acao.fixada ? quem : null, acao.fixada ? quando : null,
          quando, quem,
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
   * Grava (ou promove a fixa) as regras de CFOP de uma lista de ações, em lote. Saiu de
   * dentro do fixarPadraoDeItens (16/10) para o assistente usar o mesmo caminho: o
   * "automático" que a contadora confirma é a mesma regra fixa do botão "fixar".
   */
  private async gravarRegrasFixas(empresaId: string, acoes: { nivel: Nivel; chave: string; valor: string }[]): Promise<void> {
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
               VALUES (?,?,?,?,?,?,?,0.5,1,1,?,?,?,?) ${SE_A_REGRA_JA_EXISTE}`,
            )
            .bind(id(), this.tenant, empresaId, a.nivel, a.chave, 'cfop', a.valor,
                  quem, quando, quando, quem);
    });

    const POR_LOTE = 100;
    for (let i = 0; i < comandos.length; i += POR_LOTE) {
      await this.db.batch(comandos.slice(i, i + POR_LOTE));
    }
  }

  // ---------------------------------------------------------------- assistente (16/10)
  //
  // A Taís pediu "a inteligência artificial para eu conversar": dizer quais produtos
  // ficam como "precisa atenção" e quais "não têm que mudar porque já são automáticos".
  // Daqui saem só a busca (leitura) e as duas marcas, que só gravam depois que ELA
  // confirma no botão. A IA nunca chama estes métodos sozinha.

  /** Produtos desta empresa que batem com o texto, por fornecedor, código e CFOP que veio. */
  async produtosParaAssistente(empresaId: string, texto: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const colunas = `n.emit_cnpj AS cnpj, MAX(n.emit_nome) AS fornecedor, TRIM(i.c_prod) AS c_prod,
                TRIM(COALESCE(i.cfop_original, '')) AS cfop_veio,
                MAX(COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original)) AS descricao,
                MAX(i.x_prod_original) AS descricao_original, MAX(i.c_ean) AS c_ean,
                GROUP_CONCAT(COALESCE(NULLIF(TRIM(i.cfop_novo), ''), '(sem CFOP)'), '|') AS entradas,
                COUNT(*) AS itens, MAX(n.dh_emi) AS ultima`;
    const onde = `n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL AND n.estorno = 0
            AND TRIM(COALESCE(i.c_prod, '')) <> ''`;
    const grupo = `GROUP BY n.emit_cnpj, TRIM(i.c_prod), TRIM(COALESCE(i.cfop_original, ''))`;
    const f = filtroDeBusca(texto);
    let { results } = await this.db
      .prepare(
        `SELECT ${colunas}
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE ${onde} AND ${f.sql}
          ${grupo}
          ORDER BY ultima DESC
          LIMIT 25`,
      )
      .bind(this.tenant, empresaId, ...f.binds)
      .all<any>();
    // 16/10 (bateria): nas notas o nome vem abreviado ("REFRIG", "DET", "PAP TOALHA") e ela
    // escreve por extenso. Sem nada exato, uma segunda volta aproximada sobre os produtos da
    // empresa: cada palavra vale 2 se aparece inteira e 1 se uma palavra do produto é o
    // começo dela ("REFRIG" é o começo de "refrigerante"). Os 25 melhores.
    let aproximado = false;
    if (results.length === 0) {
      const palavras = palavrasAproximadas(texto);
      if (palavras.length) {
        const { results: todos } = await this.db
          .prepare(`SELECT ${colunas} FROM itens i JOIN notas n ON n.id = i.nota_id WHERE ${onde} ${grupo}`)
          .bind(this.tenant, empresaId)
          .all<any>();
        results = todos
          .map((r: any) => ({ r, pontos: pontosAproximados(palavras, r) }))
          .filter((x) => x.pontos > 0)
          .sort((a, b) => b.pontos - a.pontos || String(b.r.ultima).localeCompare(String(a.r.ultima)))
          .slice(0, 25)
          .map((x) => x.r);
        aproximado = results.length > 0;
      }
    }
    if (results.length === 0) return [];
    const atencao = await this.atencoesDaEmpresa(empresaId);
    const fixas = new Map<string, string>();
    for (const cnpj of new Set(results.map((r: any) => String(r.cnpj)))) {
      for (const x of await this.regrasFixadasDoFornecedor(empresaId, cnpj)) fixas.set(`${x.nivel} ${x.chave}`, x.valor);
    }
    return results.map((r: any) => {
      const conta = new Map<string, number>();
      for (const c of String(r.entradas ?? '').split('|').filter(Boolean)) conta.set(c, (conta.get(c) ?? 0) + 1);
      const entradas = [...conta.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const item = { cProd: r.c_prod, cEAN: r.c_ean, CFOP: r.cfop_veio } as any;
      const chave = chaveDoNivel(item, String(r.cnpj), 1, 'cfop');
      const fixado = chave ? fixas.get(`1 ${chave}`) ?? null : null;
      const marca = atencao.get(`${r.cnpj}|${r.c_prod}`);
      return {
        fornecedor: r.fornecedor, cnpj: r.cnpj, codigo: r.c_prod, produto: r.descricao,
        na_nota: r.descricao_original !== r.descricao ? r.descricao_original : undefined,
        cfop_que_veio: r.cfop_veio || '(vazio)',
        entradas: entradas.map(([c, n]) => `${c} (${n}x)`).join(', '),
        cfop_mais_usado: entradas.find(([c]) => /^\d{4}$/.test(c))?.[0] ?? null,
        itens: Number(r.itens), ultima_nota: String(r.ultima ?? '').slice(0, 10),
        ja_automatico: fixado !== null, cfop_fixado: fixado ?? undefined,
        em_atencao: !!marca, observacao_atencao: marca?.observacao ?? undefined,
        ...(aproximado ? { aproximado: true } : {}),
      };
    });
  }

  /**
   * Confere uma marca proposta contra o banco: o produto existe nesta empresa, com este
   * fornecedor, código e CFOP que veio. Para "automático", o CFOP de entrada é o que ela
   * disse ou, sem isso, o mais usado. Devolve a proposta completa ou o motivo da recusa.
   */
  async validarMarcaProduto(empresaId: string, p: {
    tipo: string; cnpj: string; codigo: string; cfopVeio?: string; cfop?: string; observacao?: string;
  }): Promise<{ ok: true; proposta: any } | { ok: false; erro: string }> {
    this.exigirEmpresa(empresaId);
    if (!['automatico', 'atencao', 'tirar_atencao'].includes(p.tipo)) return { ok: false, erro: 'tipo desconhecido' };
    const cnpj = String(p.cnpj ?? '').replace(/\D/g, '');
    const codigo = String(p.codigo ?? '').trim();
    if (!cnpj || !codigo) return { ok: false, erro: 'falta fornecedor ou código' };
    const saida = p.cfopVeio === undefined || p.cfopVeio === '(vazio)' ? null : String(p.cfopVeio).trim();
    const linha = await this.db
      .prepare(
        `SELECT MAX(n.emit_nome) AS fornecedor, COUNT(*) AS itens,
                MAX(COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original)) AS descricao,
                GROUP_CONCAT(COALESCE(NULLIF(TRIM(i.cfop_novo), ''), ''), '|') AS entradas
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.emit_cnpj = ? AND TRIM(i.c_prod) = ?
            AND (? IS NULL OR TRIM(COALESCE(i.cfop_original, '')) = ?)
            AND n.cancelada_em IS NULL AND n.estorno = 0`,
      )
      .bind(this.tenant, empresaId, cnpj, codigo, saida, saida ?? '')
      .first<any>();
    if (!linha || Number(linha.itens) === 0) return { ok: false, erro: `produto ${codigo} do fornecedor ${cnpj} não encontrado nesta empresa` };
    let cfop: string | undefined;
    if (p.tipo === 'automatico') {
      if (saida === null) return { ok: false, erro: 'automático precisa do CFOP que veio na nota' };
      const conta = new Map<string, number>();
      for (const c of String(linha.entradas ?? '').split('|').filter((x) => /^\d{4}$/.test(x))) conta.set(c, (conta.get(c) ?? 0) + 1);
      cfop = String(p.cfop ?? '').trim() || [...conta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!cfop || !/^[123]\d{3}$/.test(cfop)) return { ok: false, erro: 'automático precisa de um CFOP de entrada (1xxx, 2xxx ou 3xxx)' };
    }
    return {
      ok: true,
      proposta: {
        tipo: p.tipo, cnpj, fornecedor: linha.fornecedor ?? '', codigo, produto: linha.descricao ?? '',
        cfopVeio: saida, cfop, observacao: String(p.observacao ?? '').trim().slice(0, 300) || undefined,
        itens: Number(linha.itens),
      },
    };
  }

  /** "Automático, não precisa olhar": a regra fixa do produto, como o botão "fixar" (níveis 1 e 2). */
  async fixarProduto(empresaId: string, cnpj: string, codigo: string, cfopVeio: string, cfop: string): Promise<boolean> {
    this.exigirEmpresa(empresaId);
    const l = await this.db
      .prepare(
        `SELECT i.*, n.emit_nome FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.emit_cnpj = ? AND TRIM(i.c_prod) = ?
            AND TRIM(COALESCE(i.cfop_original, '')) = ?
          ORDER BY n.dh_emi DESC LIMIT 1`,
      )
      .bind(this.tenant, empresaId, cnpj, codigo, cfopVeio)
      .first<any>();
    if (!l) return false;
    const item = {
      nItem: l.n_item, cProd: l.c_prod, cEAN: l.c_ean, xProd: l.x_prod_original,
      NCM: l.ncm, CEST: l.cest, CFOP: l.cfop_original, uCom: l.unidade,
      qCom: l.quantidade, vUnCom: l.valor_unitario, vProd: l.valor_total,
      cstIcms: null, temIbsCbs: false,
    };
    const acoes: { nivel: Nivel; chave: string; valor: string }[] = [];
    for (const a of aprender({
      item: item as any, emitCnpj: cnpj, campo: 'cfop', valorFinal: cfop,
      sugestao: null, fixar: true, apenasNiveis: [1, 2],
    })) {
      if (a.tipo === 'criar') acoes.push({ nivel: a.nivel, chave: a.chave, valor: a.valor });
    }
    if (acoes.length === 0) return false;
    // Já está fixado assim (ela confirmou de novo): não regrava nem repete a trilha.
    const fixas = new Map((await this.regrasFixadasDoFornecedor(empresaId, cnpj)).map((r) => [`${r.nivel}\x00${r.chave}`, r.valor]));
    if (acoes.every((a) => fixas.get(`${a.nivel}\x00${a.chave}`) === a.valor)) return false;
    await this.gravarRegrasFixas(empresaId, acoes);
    await this.aud.registrarLote([
      this.evento({
        acao: 'alterar', entidade: 'empresa', entidadeId: empresaId, campo: 'produto_automatico',
        valorAntes: null,
        valorDepois: `${l.emit_nome ?? cnpj} cód. ${codigo} (veio ${cfopVeio}) sempre ${cfop} — pelo assistente`,
        origem: 'manual',
      }),
    ]);
    return true;
  }

  /** Liga ou desliga o "precisa atenção" de um produto de um fornecedor. Devolve se mudou. */
  async marcarAtencao(
    empresaId: string, cnpj: string, codigo: string, descricao: string, observacao: string | undefined, ligar: boolean,
  ): Promise<boolean> {
    this.exigirEmpresa(empresaId);
    const quando = agora();
    const r = ligar
      ? await this.db
        .prepare(
          `INSERT INTO produto_atencao
             (id, tenant_id, empresa_id, emit_cnpj, c_prod, descricao, observacao, criado_por, criado_em)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT (tenant_id, empresa_id, emit_cnpj, c_prod) DO UPDATE SET
             descricao = excluded.descricao, observacao = excluded.observacao,
             criado_por = excluded.criado_por, criado_em = excluded.criado_em, removido_em = NULL
           WHERE produto_atencao.removido_em IS NOT NULL OR COALESCE(produto_atencao.observacao, '') <> COALESCE(excluded.observacao, '')`,
        )
        .bind(id(), this.tenant, empresaId, cnpj, codigo, descricao, observacao ?? null, this.ctx.sessao.usuarioId, quando)
        .run()
      : await this.db
        .prepare(
          `UPDATE produto_atencao SET removido_em = ?
            WHERE tenant_id = ? AND empresa_id = ? AND emit_cnpj = ? AND c_prod = ? AND removido_em IS NULL`,
        )
        .bind(quando, this.tenant, empresaId, cnpj, codigo)
        .run();
    const mudou = Number(r.meta?.changes ?? 0) > 0;
    if (mudou) {
      const desc = `${descricao} (cód. ${codigo}, fornecedor ${cnpj})${observacao ? ` — ${observacao}` : ''}`;
      await this.aud.registrarLote([
        this.evento({
          acao: 'alterar', entidade: 'empresa', entidadeId: empresaId, campo: 'produto_atencao',
          valorAntes: ligar ? null : desc, valorDepois: ligar ? `${desc} — pelo assistente` : null, origem: 'manual',
        }),
      ]);
    }
    return mudou;
  }

  /** Produtos com "precisa atenção" ligado: `cnpj|código` -> observação. */
  async atencoesDaEmpresa(empresaId: string, cnpj?: string): Promise<Map<string, { observacao: string | null; descricao: string | null }>> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT emit_cnpj, c_prod, descricao, observacao FROM produto_atencao
          WHERE tenant_id = ? AND empresa_id = ? AND removido_em IS NULL ${cnpj ? 'AND emit_cnpj = ?' : ''}`,
      )
      .bind(this.tenant, empresaId, ...(cnpj ? [cnpj] : []))
      .all<any>();
    return new Map(results.map((r: any) => [`${r.emit_cnpj}|${r.c_prod}`, { observacao: r.observacao, descricao: r.descricao }]));
  }

  // ---------------------------------------------------------------- conversas do assistente (19/10)

  /**
   * Grava uma troca do painel: o que ela escreveu e a resposta da IA (com as buscas que a IA
   * fez, as propostas, o gasto, o tempo e o erro, se houve). A conversa só continua para a
   * mesma pessoa na mesma empresa; um id que não é dela abre uma conversa nova.
   *
   * O ajuste anotado pela IA aponta para a resposta ANTERIOR da IA: é ela que a contadora
   * corrigiu. Se não houver anterior, aponta para esta.
   */
  async gravarTrocaAssistente(empresaId: string, conversaId: string | undefined, t: {
    ela: string; texto: string; passos?: unknown[]; propostas?: unknown[]; uso?: unknown; modelo?: string;
    ms: number; erro?: string; ajustes?: { oQueMudar: string; sobre?: string }[];
  }): Promise<{ conversaId: string; mensagemId: string }> {
    this.exigirEmpresa(empresaId);
    const s = this.ctx.sessao;
    const quando = agora();
    const existe = conversaId
      ? await this.db
        .prepare('SELECT id FROM assistente_conversa WHERE id = ? AND tenant_id = ? AND empresa_id = ? AND usuario_id = ?')
        .bind(conversaId, this.tenant, empresaId, s.usuarioId)
        .first<any>()
      : null;
    const cid: string = existe?.id ?? id();
    const ultima = existe
      ? await this.db
        .prepare(
          `SELECT MAX(ordem) AS ordem,
                  (SELECT id FROM assistente_mensagem WHERE conversa_id = ? AND papel = 'assistente' ORDER BY ordem DESC LIMIT 1) AS resposta
             FROM assistente_mensagem WHERE conversa_id = ?`,
        )
        .bind(cid, cid)
        .first<any>()
      : null;
    const ordem = Number(ultima?.ordem ?? 0);
    const idEla = id();
    const idIa = id();
    const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
    const lote: D1PreparedStatement[] = [
      existe
        ? this.db.prepare('UPDATE assistente_conversa SET atualizada_em = ? WHERE id = ?').bind(quando, cid)
        : this.db
          .prepare(
            `INSERT INTO assistente_conversa (id, tenant_id, empresa_id, usuario_id, usuario_nome, iniciada_em, atualizada_em)
             VALUES (?,?,?,?,?,?,?)`,
          )
          .bind(cid, this.tenant, empresaId, s.usuarioId, s.nome ?? null, quando, quando),
      this.db
        .prepare(`INSERT INTO assistente_mensagem (id, conversa_id, ordem, papel, texto, criada_em) VALUES (?,?,?,'ela',?,?)`)
        .bind(idEla, cid, ordem + 1, t.ela, quando),
      this.db
        .prepare(
          `INSERT INTO assistente_mensagem (id, conversa_id, ordem, papel, texto, passos, propostas, uso, modelo, ms, erro, criada_em)
           VALUES (?,?,?,'assistente',?,?,?,?,?,?,?,?)`,
        )
        .bind(idIa, cid, ordem + 2, t.texto, json(t.passos?.length ? t.passos : null), json(t.propostas?.length ? t.propostas : null),
          json(t.uso), t.modelo ?? null, Math.round(t.ms), t.erro ?? null, quando),
    ];
    for (const a of t.ajustes ?? []) {
      lote.push(this.db
        .prepare(
          `INSERT INTO assistente_evento (id, conversa_id, mensagem_id, tipo, origem, texto, sobre, usuario_id, usuario_nome, criado_em)
           VALUES (?,?,?,'ajuste','ia',?,?,?,?,?)`,
        )
        .bind(id(), cid, ultima?.resposta ?? idIa, a.oQueMudar, a.sobre ?? null, s.usuarioId, s.nome ?? null, quando));
    }
    await this.db.batch(lote);
    return { conversaId: cid, mensagemId: idIa };
  }

  /**
   * O que aconteceu depois com uma resposta da IA: ela confirmou ou deixou de lado uma
   * proposta, ou escreveu no "Ajustar" o que estava errado. Sempre preso à resposta.
   */
  async eventoAssistente(mensagemId: string, e: { tipo: 'confirmou' | 'descartou' | 'ajuste'; proposta?: unknown; texto?: string }): Promise<boolean> {
    const m = await this.db
      .prepare(
        `SELECT m.id, m.conversa_id, c.empresa_id FROM assistente_mensagem m
           JOIN assistente_conversa c ON c.id = m.conversa_id
          WHERE m.id = ? AND c.tenant_id = ? AND m.papel = 'assistente'`,
      )
      .bind(mensagemId, this.tenant)
      .first<any>();
    if (!m) return false;
    this.exigirEmpresa(m.empresa_id);
    const s = this.ctx.sessao;
    await this.db
      .prepare(
        `INSERT INTO assistente_evento (id, conversa_id, mensagem_id, tipo, origem, proposta, texto, usuario_id, usuario_nome, criado_em)
         VALUES (?,?,?,?,'tela',?,?,?,?,?)`,
      )
      .bind(id(), m.conversa_id, m.id, e.tipo, e.proposta == null ? null : JSON.stringify(e.proposta), e.texto ?? null,
        s.usuarioId, s.nome ?? null, agora())
      .run();
    return true;
  }

  /** Conversas mexidas no intervalo (ISO, [de, ate)), as mais recentes primeiro, com os números de cada uma. */
  async conversasDoAssistente(de: string, ate: string, soComAjuste = false): Promise<any[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.empresa_id, e.razao_social, c.usuario_nome, c.iniciada_em, c.atualizada_em,
                (SELECT COUNT(*) FROM assistente_mensagem m WHERE m.conversa_id = c.id AND m.papel = 'ela') AS perguntas,
                (SELECT COUNT(*) FROM assistente_mensagem m WHERE m.conversa_id = c.id AND m.erro IS NOT NULL) AS erros,
                (SELECT COALESCE(SUM(json_array_length(m.propostas)), 0) FROM assistente_mensagem m WHERE m.conversa_id = c.id) AS propostas,
                (SELECT COUNT(*) FROM assistente_evento v WHERE v.conversa_id = c.id AND v.tipo = 'confirmou') AS confirmadas,
                (SELECT COUNT(*) FROM assistente_evento v WHERE v.conversa_id = c.id AND v.tipo = 'descartou') AS descartadas,
                (SELECT COUNT(*) FROM assistente_evento v WHERE v.conversa_id = c.id AND v.tipo = 'ajuste') AS ajustes,
                (SELECT texto FROM assistente_mensagem m WHERE m.conversa_id = c.id AND m.papel = 'ela' ORDER BY m.ordem LIMIT 1) AS primeira
           FROM assistente_conversa c
           LEFT JOIN empresas e ON e.id = c.empresa_id
          WHERE c.tenant_id = ? AND c.atualizada_em >= ? AND c.atualizada_em < ?
          ORDER BY c.atualizada_em DESC
          LIMIT 300`,
      )
      .bind(this.tenant, de, ate)
      .all<any>();
    return results.filter((r: any) => podeVerEmpresa(this.ctx.sessao, r.empresa_id) && (!soComAjuste || Number(r.ajustes) > 0));
  }

  /** Uma conversa inteira, em ordem, com o que aconteceu em cada resposta. */
  async conversaDoAssistente(conversaId: string): Promise<any | null> {
    const c = await this.db
      .prepare(
        `SELECT c.id, c.empresa_id, e.razao_social, c.usuario_nome, c.iniciada_em, c.atualizada_em
           FROM assistente_conversa c LEFT JOIN empresas e ON e.id = c.empresa_id
          WHERE c.id = ? AND c.tenant_id = ?`,
      )
      .bind(conversaId, this.tenant)
      .first<any>();
    if (!c) return null;
    this.exigirEmpresa(c.empresa_id);
    const ler = (v: unknown) => { if (v == null) return null; try { return JSON.parse(String(v)); } catch { return null; } };
    const [{ results: msgs }, { results: evs }] = await Promise.all([
      this.db.prepare('SELECT * FROM assistente_mensagem WHERE conversa_id = ? ORDER BY ordem').bind(conversaId).all<any>(),
      this.db.prepare('SELECT * FROM assistente_evento WHERE conversa_id = ? ORDER BY criado_em, id').bind(conversaId).all<any>(),
    ]);
    const eventos = evs.map((v: any) => ({
      id: v.id, mensagemId: v.mensagem_id, tipo: v.tipo, origem: v.origem, proposta: ler(v.proposta),
      texto: v.texto, sobre: v.sobre, usuario: v.usuario_nome, quando: v.criado_em,
    }));
    return {
      ...c,
      mensagens: msgs.map((m: any) => ({
        id: m.id, ordem: m.ordem, papel: m.papel, texto: m.texto, quando: m.criada_em, ms: m.ms, modelo: m.modelo, erro: m.erro,
        passos: ler(m.passos) ?? [], propostas: ler(m.propostas) ?? [], uso: ler(m.uso),
        eventos: eventos.filter((v) => v.mensagemId === m.id),
      })),
    };
  }

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

    await this.gravarRegrasFixas(empresaId, acoes);

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

  /**
   * "De onde veio isto" (13/10, pedido da Taís): a regra que deu o CFOP da linha e as
   * decisões dela que batem com a chave dessa regra - o mesmo produto do mesmo
   * fornecedor, ou o mesmo código de barras, ou o mesmo NCM, conforme o nível. Mais
   * recentes primeiro: a regra fica com a última decisão. Só leitura.
   */
  async deOndeVeio(itemId: string): Promise<{ regra: any | null; decisoes: any[] }> {
    const it = await this.db
      .prepare(
        `SELECT i.*, n.empresa_id, n.emit_cnpj FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE i.tenant_id = ? AND i.id = ?`,
      )
      .bind(this.tenant, itemId)
      .first<any>();
    if (!it) throw new ForaDoEscopo('Item não encontrado');
    this.exigirEmpresa(it.empresa_id);

    const campos = `r.id, r.nivel, r.chave, r.valor, r.usos, r.acertos, r.erros, r.fixada, r.fixada_em,
                    r.criada_em, r.atualizada_em, uc.nome AS criada_por_nome, uf.nome AS fixada_por_nome
               FROM regras r LEFT JOIN usuarios uc ON uc.id = r.criada_por LEFT JOIN usuarios uf ON uf.id = r.fixada_por`;
    let regra: any = null;
    const origem = String(it.cfop_origem ?? '');
    if (origem.startsWith('regra:')) {
      regra = await this.db
        .prepare(`SELECT ${campos} WHERE r.tenant_id = ? AND r.empresa_id = ? AND r.id = ? AND r.campo = 'cfop'`)
        .bind(this.tenant, it.empresa_id, origem.slice('regra:'.length))
        .first<any>();
    }
    if (!regra && String(it.cfop_novo ?? '').trim()) {
      // A linha mostra "PADRÃO FIXADO" quando o valor dela é o padrão fixado do produto.
      const item = { cProd: it.c_prod, cEAN: it.c_ean, NCM: it.ncm, CFOP: it.cfop_original } as any;
      const k1 = chaveDoNivel(item, it.emit_cnpj, 1, 'cfop');
      const k2 = chaveDoNivel(item, it.emit_cnpj, 2, 'cfop');
      regra = await this.db
        .prepare(
          `SELECT ${campos} WHERE r.tenant_id = ? AND r.empresa_id = ? AND r.campo = 'cfop' AND r.ativa = 1 AND r.fixada = 1
             AND r.valor = ? AND ((r.nivel = 1 AND r.chave = ?) OR (r.nivel = 2 AND r.chave = ?)) ORDER BY r.nivel LIMIT 1`,
        )
        .bind(this.tenant, it.empresa_id, String(it.cfop_novo).trim(), k1 ?? '', k2 ?? '')
        .first<any>();
    }
    if (!regra) return { regra: null, decisoes: [] };

    const partes = partesDaChave(regra.nivel, regra.chave);
    if (!partes) return { regra, decisoes: [] };
    const onde: string[] = [];
    const binds: unknown[] = [];
    if (partes.cnpj !== undefined) { onde.push('n.emit_cnpj = ?'); binds.push(partes.cnpj); }
    if (partes.cprod !== undefined) { onde.push("UPPER(TRIM(COALESCE(i.c_prod, ''))) = ?"); binds.push(partes.cprod); }
    if (partes.ean !== undefined) { onde.push('i.c_ean = ?'); binds.push(partes.ean); }
    if (partes.ncm !== undefined) { onde.push('i.ncm = ?'); binds.push(partes.ncm); }
    if (partes.saida !== undefined) { onde.push("TRIM(COALESCE(i.cfop_original, '')) = ?"); binds.push(partes.saida); }

    const { results } = await this.db
      .prepare(
        `SELECT i.id AS item_id, i.n_item, i.x_prod_original, i.x_prod_novo, i.c_prod, i.ncm,
                i.cfop_original, i.cfop_novo, i.cfop_origem, i.revisado, i.revisado_em,
                u.nome AS revisado_por_nome,
                n.id AS nota_id, n.numero, n.dh_emi, n.emit_nome, n.competencia
           FROM itens i JOIN notas n ON n.id = i.nota_id
           LEFT JOIN usuarios u ON u.id = i.revisado_por
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND i.id <> ?
            AND (i.revisado = 1 OR COALESCE(i.cfop_origem, '') LIKE 'manual%')
            AND TRIM(COALESCE(i.cfop_novo, '')) <> ''
            ${onde.length ? 'AND ' + onde.join(' AND ') : ''}
          ORDER BY COALESCE(i.revisado_em, n.criado_em) DESC, n.numero, i.n_item
          LIMIT 100`,
      )
      .bind(this.tenant, it.empresa_id, itemId, ...binds)
      .all<any>();
    return { regra, decisoes: results };
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
          `SELECT id, nivel, valor, usos, acertos, erros, fixada, suspeita
             FROM regras WHERE tenant_id = ? AND empresa_id = ?
              AND id IN (${fatia.map(() => '?').join(',')})`,
        )
        .bind(this.tenant, empresaId, ...fatia)
        .all<any>();
      for (const r of results) {
        mapa.set(r.id, {
          id: r.id,
          nivel: r.nivel,
          valor: String(r.valor ?? ''),
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
  async contarCanceladas(empresaId: string, competencia?: string, periodo?: Periodo): Promise<number> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia, periodo);
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
    filtro: { texto?: string; produto?: string; unidade?: string; competencia?: string; periodo?: Periodo; cnpj?: string; saida?: string },
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
    // Do relatório por fornecedor (16/10): só os itens daquele fornecedor e daquele CFOP que veio.
    if (filtro.cnpj) {
      onde.push('n.emit_cnpj = ?');
      binds.push(filtro.cnpj);
    }
    if (filtro.saida !== undefined) {
      onde.push("TRIM(COALESCE(i.cfop_original, '')) = ?");
      binds.push(filtro.saida);
    }
    const r = this.recorteCompetencia(filtro.competencia, filtro.periodo);
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
  /** Regras de ICMS por CFOP do escritório (planilha da Taís, 25/09). */
  /** As regras de um grupo de regime (13/10): a empresa usa o grupo do regime dela (grupoIcms). */
  async regrasIcms(grupo: 'presumido' | 'simples' | 'simples_fora'): Promise<Map<string, 'manter' | 'outras'>> {
    const { results } = await this.db
      .prepare('SELECT cfop, regra FROM regras_icms WHERE tenant_id = ? AND grupo = ?')
      .bind(this.tenant, grupo)
      .all<any>();
    return new Map(results.map((r: any) => [r.cfop as string, r.regra as 'manter' | 'outras']));
  }

  async listarRegrasIcms(): Promise<any[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.cfop, r.grupo, r.regra, r.atualizado_em, u.nome AS atualizado_por
           FROM regras_icms r LEFT JOIN usuarios u ON u.id = r.atualizado_por
          WHERE r.tenant_id = ? ORDER BY r.cfop, r.grupo`,
      )
      .bind(this.tenant)
      .all<any>();
    return results;
  }

  /** Cria ou troca a regra de um CFOP num grupo de regime. Devolve se mudou. */
  async definirRegraIcms(grupo: 'presumido' | 'simples' | 'simples_fora', cfop: string, regra: 'manter' | 'outras'): Promise<boolean> {
    const atual = await this.db
      .prepare('SELECT regra FROM regras_icms WHERE tenant_id = ? AND grupo = ? AND cfop = ?')
      .bind(this.tenant, grupo, cfop)
      .first<{ regra: string }>();
    if (atual?.regra === regra) return false;
    await this.db
      .prepare(
        `INSERT INTO regras_icms (tenant_id, grupo, cfop, regra, atualizado_em, atualizado_por) VALUES (?,?,?,?,?,?)
         ON CONFLICT (tenant_id, grupo, cfop) DO UPDATE SET regra = excluded.regra,
           atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por`,
      )
      .bind(this.tenant, grupo, cfop, regra, agora(), this.ctx.sessao.usuarioId)
      .run();
    await this.aud.registrarLote([
      this.evento({
        acao: atual ? 'alterar' : 'criar', entidade: 'regra_icms', entidadeId: cfop, campo: `regra:${grupo}`,
        valorAntes: atual?.regra ?? null, valorDepois: regra, origem: 'manual',
      }),
    ]);
    return true;
  }

  /** Produtos marcados "não fechou" no relatório do mês (28/09). */
  async produtosQueNaoFecharam(empresaId: string, competencia: string): Promise<Map<string, { por: string | null; em: string }>> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT m.chave, m.marcado_em, u.nome AS por
           FROM produtos_nao_fecharam m LEFT JOIN usuarios u ON u.id = m.marcado_por
          WHERE m.tenant_id = ? AND m.empresa_id = ? AND m.competencia = ?`,
      )
      .bind(this.tenant, empresaId, competencia)
      .all<any>();
    return new Map(results.map((r: any) => [r.chave as string, { por: r.por ?? null, em: r.marcado_em as string }]));
  }

  /** Marca ou desmarca um produto do relatório como "não fechou". Devolve se mudou. */
  async marcarProdutoNaoFechou(
    empresaId: string, competencia: string, descricao: string, unidade: string, naoFechou: boolean,
  ): Promise<boolean> {
    this.exigirEmpresa(empresaId);
    const chave = chaveProduto(descricao, unidade);
    const r = naoFechou
      ? await this.db
        .prepare(
          `INSERT OR IGNORE INTO produtos_nao_fecharam
             (tenant_id, empresa_id, competencia, chave, descricao, unidade, marcado_por, marcado_em)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(this.tenant, empresaId, competencia, chave, descricao.trim(), unidade.trim(), this.ctx.sessao.usuarioId, agora())
        .run()
      : await this.db
        .prepare('DELETE FROM produtos_nao_fecharam WHERE tenant_id = ? AND empresa_id = ? AND competencia = ? AND chave = ?')
        .bind(this.tenant, empresaId, competencia, chave)
        .run();
    const mudou = Number(r.meta?.changes ?? 0) > 0;
    if (mudou) {
      await this.aud.registrarLote([
        this.evento({
          acao: 'alterar', entidade: 'empresa', entidadeId: empresaId, campo: 'produto_nao_fechou',
          valorAntes: naoFechou ? null : `${competencia} ${descricao} (${unidade})`,
          valorDepois: naoFechou ? `${competencia} ${descricao} (${unidade})` : null, origem: 'manual',
        }),
      ]);
    }
    return mudou;
  }

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
                    AND (i.cfop_novo IS NULL OR TRIM(i.cfop_novo) = '')) AS itens_sem_cfop,
                -- "Vieram prontas" (15/10, reunião): item não conferido cujo CFOP veio de regra
                -- do PRÓPRIO produto (níveis 1, 2, 3), do padrão do fornecedor (5) ou fixada,
                -- ativa, sem suspeita e ainda com o mesmo valor. Regra de outro produto pelo
                -- NCM (4, 6) não conta: é o caso da Sprite.
                (SELECT COUNT(*) FROM itens i JOIN regras r ON r.id = substr(i.cfop_origem, 7)
                  WHERE i.nota_id = n.id AND i.revisado = 0 AND i.cfop_origem LIKE 'regra:%'
                    AND r.ativa = 1 AND r.suspeita = 0 AND (r.fixada = 1 OR r.nivel IN (1, 2, 3, 5))
                    AND r.valor = TRIM(i.cfop_novo)
                    -- Produto que ela pediu para sempre olhar (16/10) nunca vem pronto.
                    AND NOT EXISTS (SELECT 1 FROM produto_atencao a
                                     WHERE a.tenant_id = n.tenant_id AND a.empresa_id = n.empresa_id
                                       AND a.emit_cnpj = n.emit_cnpj AND a.c_prod = TRIM(i.c_prod)
                                       AND a.removido_em IS NULL)) AS itens_prontos
         FROM notas n WHERE n.tenant_id = ? AND n.empresa_id = ? ${filtro}
         ORDER BY n.dh_emi DESC LIMIT 500`,
      )
      .bind(...binds)
      .all<any>();
    return results;
  }

  /**
   * O que falta tratar em cada empresa (13/10, pedido da Taís): "uma lista das empresas
   * que tem notas a tratar (...) antes de eu selecionar a empresa". Mesma regra da lista
   * de notas: a tratar é nota com item não conferido; cancelada e estorno não contam.
   * Só as empresas que a pessoa pode ver, e só as que têm pendência.
   */
  async pendenciasPorEmpresa(): Promise<{ empresaId: string; razaoSocial: string; notas: number; itens: number; maisAntiga: string | null }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.empresa_id, e.razao_social, COUNT(*) AS notas, SUM(p.total - p.rev) AS itens, MIN(p.dh_emi) AS mais_antiga
           FROM (SELECT n.id, n.empresa_id, n.dh_emi, COUNT(i.id) AS total,
                        COALESCE(SUM(CASE WHEN i.revisado = 1 THEN 1 ELSE 0 END), 0) AS rev
                   FROM notas n LEFT JOIN itens i ON i.nota_id = n.id
                  WHERE n.tenant_id = ? AND n.cancelada_em IS NULL AND COALESCE(n.estorno, 0) <> 1
                  GROUP BY n.id) p
           JOIN empresas e ON e.id = p.empresa_id AND e.ativo = 1
          WHERE NOT (p.total > 0 AND p.rev >= p.total)
          GROUP BY p.empresa_id, e.razao_social
          ORDER BY e.razao_social`,
      )
      .bind(this.tenant)
      .all<any>();
    return results
      .filter((r: any) => podeVerEmpresa(this.ctx.sessao, r.empresa_id))
      .map((r: any) => ({
        empresaId: r.empresa_id, razaoSocial: r.razao_social,
        notas: Number(r.notas), itens: Number(r.itens ?? 0), maisAntiga: r.mais_antiga ?? null,
      }));
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

  /**
   * Competencia (AAAA ou AAAA-MM) e, opcionalmente, periodo de EMISSAO (29/09, pedido
   * da Taís: "do dia 1 ao dia 20"). A data e a do XML, como veio (sem converter fuso).
   */
  private recorteCompetencia(competencia?: string, periodo?: Periodo): { sql: string; binds: string[] } {
    const sql: string[] = [];
    const binds: string[] = [];
    if (competencia) {
      if (/^\d{4}$/.test(competencia)) { sql.push('AND n.competencia LIKE ?'); binds.push(`${competencia}-%`); }
      else { sql.push('AND n.competencia = ?'); binds.push(competencia); }
    }
    if (periodo?.de) { sql.push('AND substr(n.dh_emi, 1, 10) >= ?'); binds.push(periodo.de); }
    if (periodo?.ate) { sql.push('AND substr(n.dh_emi, 1, 10) <= ?'); binds.push(periodo.ate); }
    return { sql: sql.join(' '), binds };
  }

  // ---------------------------------------------------------------- certificados

  /** Certificados A1 da captura no SAT (29/09). Só metadados; a chave está na Cloudflare. */
  async listarCertificados(): Promise<any[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.nome, c.titular, c.documento, c.tipo, c.emissor, c.serial, c.valido_de, c.valido_ate,
                c.cloudflare_id, c.guardado_em, c.enviado_em, u.nome AS enviado_por_nome
           FROM certificados c LEFT JOIN usuarios u ON u.id = c.enviado_por
          WHERE c.tenant_id = ? AND c.removido_em IS NULL
          ORDER BY c.valido_ate DESC`,
      )
      .bind(this.tenant)
      .all<any>();
    return results;
  }

  async certificadoPorSerial(serial: string): Promise<{ id: string; guardado_em: string } | null> {
    return await this.db
      .prepare('SELECT id, guardado_em FROM certificados WHERE tenant_id = ? AND serial = ? AND removido_em IS NULL')
      .bind(this.tenant, serial)
      .first<{ id: string; guardado_em: string }>();
  }

  async gravarCertificado(c: {
    nome: string; titular: string; documento: string | null; tipo: string; emissor: string; serial: string;
    validoDe: string; validoAte: string; cloudflareId: string;
    /** 'ponte' (intermediário na VPS, 01/10) ou 'cloudflare' (cofre mTLS, 29/09). */
    guardadoEm?: 'ponte' | 'cloudflare'; id?: string;
  }): Promise<string> {
    const id = c.id ?? this.novoId();
    await this.db
      .prepare(
        `INSERT INTO certificados (id, tenant_id, nome, titular, documento, tipo, emissor, serial, valido_de,
            valido_ate, cloudflare_id, enviado_em, enviado_por, guardado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(id, this.tenant, c.nome, c.titular, c.documento, c.tipo, c.emissor, c.serial, c.validoDe,
        c.validoAte, c.cloudflareId, agora(), this.ctx.sessao.usuarioId, c.guardadoEm ?? 'cloudflare')
      .run();
    await this.aud.registrarLote([
      this.evento({
        acao: 'criar', entidade: 'certificado', entidadeId: id, campo: 'certificado',
        valorAntes: null, valorDepois: `${c.tipo} ${c.titular} ${c.documento ?? ''} até ${c.validoAte.slice(0, 10)}`,
        origem: 'manual',
      }),
    ]);
    return id;
  }

  async obterCertificado(id: string): Promise<any | null> {
    return await this.db
      .prepare('SELECT * FROM certificados WHERE tenant_id = ? AND id = ? AND removido_em IS NULL')
      .bind(this.tenant, id)
      .first<any>();
  }

  async removerCertificado(id: string): Promise<void> {
    const c = await this.obterCertificado(id);
    if (!c) throw new ForaDoEscopo('Certificado não encontrado');
    await this.db
      .prepare('UPDATE certificados SET removido_em = ?, removido_por = ? WHERE tenant_id = ? AND id = ?')
      .bind(agora(), this.ctx.sessao.usuarioId, this.tenant, id)
      .run();
    await this.aud.registrarLote([
      this.evento({
        acao: 'alterar', entidade: 'certificado', entidadeId: id, campo: 'removido',
        valorAntes: `${c.tipo} ${c.titular}`, valorDepois: 'removido', origem: 'manual',
      }),
    ]);
  }

  // ---------------------------------------------------------------- busca na SEF

  /** Até onde já baixou e quando a SEF libera a próxima consulta desta empresa (30/09). */
  async estadoSef(empresaId: string): Promise<any | null> {
    this.exigirEmpresa(empresaId);
    return await this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM captura_caixa x WHERE x.empresa_id = c.empresa_id AND x.tipo = 'nota') AS na_caixa
           FROM captura_empresas c WHERE c.tenant_id = ? AND c.empresa_id = ?`,
      )
      .bind(this.tenant, empresaId)
      .first<any>();
  }

  /**
   * Reserva a consulta: só passa se a SEF já liberou esta empresa, e empurra a
   * liberação 10 minutos para frente. Dois cliques ao mesmo tempo, ou duas pessoas,
   * nunca consultam a SEF duas vezes (a SEF bloqueia consulta repetida).
   */
  async reservarConsultaSef(empresaId: string, certificadoId: string, agoraIso: string): Promise<boolean> {
    this.exigirEmpresa(empresaId);
    const segura = new Date(Date.parse(agoraIso) + 10 * 60_000).toISOString();
    await this.db
      .prepare(
        `INSERT INTO captura_empresas (empresa_id, tenant_id, certificado_id, atualizado_em) VALUES (?,?,?,?)
         ON CONFLICT(empresa_id) DO NOTHING`,
      )
      .bind(empresaId, this.tenant, certificadoId, agoraIso)
      .run();
    const r = await this.db
      .prepare(
        `UPDATE captura_empresas SET proxima_consulta = ?, certificado_id = ?
          WHERE tenant_id = ? AND empresa_id = ? AND (proxima_consulta IS NULL OR proxima_consulta <= ?)`,
      )
      .bind(segura, certificadoId, this.tenant, empresaId, agoraIso)
      .run();
    return (r.meta?.changes ?? 0) === 1;
  }

  /** Guarda o índice do que a SEF mandou. Repetido (mesmo NSU) é ignorado. */
  async guardarNaCaixa(empresaId: string, docs: {
    nsu: string; chave: string | null; tipo: string; tpEvento: string | null; dhEmi: string | null;
    emitCnpj: string | null; emitNome: string | null; numero: string | null; valor: number | null; r2Chave: string;
  }[]): Promise<void> {
    this.exigirEmpresa(empresaId);
    if (!docs.length) return;
    const t = agora();
    await this.db.batch(docs.map((d) => this.db
      .prepare(
        `INSERT OR IGNORE INTO captura_caixa (tenant_id, empresa_id, nsu, chave, tipo, tp_evento, dh_emi, emit_cnpj,
            emit_nome, numero, valor, r2_chave, recebido_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(this.tenant, empresaId, d.nsu, d.chave, d.tipo, d.tpEvento, d.dhEmi, d.emitCnpj, d.emitNome, d.numero,
        d.valor, d.r2Chave, t)));
  }

  /** Grava o resultado da consulta: ponteiro, liberação e histórico. */
  async registrarConsultaSef(empresaId: string, c: {
    quando: string; proxima: string; cStat: string | null; motivo: string; erro: string | null;
    ultNsu: string | null; nsuDe: string | null; documentos: number;
    /** O certificado que a SEF aceitou para esta empresa (fica gravado como o dela). */
    certificadoAceito?: string | null;
    /** A SEF recusou todos por vínculo: a empresa deixa de ter certificado confirmado. */
    nenhumVinculado?: boolean;
    /** A consulta terminou sem ter mais nada na SEF: até 2 dias antes daqui, tudo já veio. */
    completa?: boolean;
  }): Promise<void> {
    this.exigirEmpresa(empresaId);
    await this.db.batch([
      this.db.prepare(
        `UPDATE captura_empresas SET proxima_consulta = ?, ultima_consulta = ?, ultimo_cstat = ?, ultimo_motivo = ?,
            ultimo_erro = ?, ult_nsu = COALESCE(?, ult_nsu), atualizado_em = ?,
            certificado_id = COALESCE(?, certificado_id),
            certificado_confirmado_em = CASE WHEN ? IS NOT NULL THEN ? WHEN ? = 1 THEN NULL ELSE certificado_confirmado_em END,
            sef_completo_em = CASE WHEN ? = 1 THEN ? ELSE sef_completo_em END
          WHERE tenant_id = ? AND empresa_id = ?`,
      ).bind(c.proxima, c.quando, c.cStat, c.motivo, c.erro, c.ultNsu, c.quando,
        c.certificadoAceito ?? null, c.certificadoAceito ?? null, c.quando, c.nenhumVinculado ? 1 : 0,
        c.completa ? 1 : 0, c.quando,
        this.tenant, empresaId),
      this.db.prepare(
        `INSERT INTO captura_buscas (id, tenant_id, empresa_id, usuario_id, quando, cstat, motivo, nsu_de, nsu_ate, documentos, erro, automatica)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(this.novoId(), this.tenant, empresaId, this.ctx.sessao.usuarioId, c.quando, c.cStat, c.motivo,
        c.nsuDe, c.ultNsu, c.documentos, c.erro, this.ctx.automatica ? 1 : 0),
    ]);
  }

  /**
   * Por mês: notas no sistema e notas na caixa ainda sem importar, e quando foi a
   * primeira consulta à SEF (13/10). Base da linha "completo / sem movimento" do painel.
   */
  async movimentoPorMes(empresaId: string): Promise<{ primeiraConsulta: string | null; completoEm: string | null; meses: Map<string, { noSistema: number; naCaixa: number }> }> {
    this.exigirEmpresa(empresaId);
    const [rC, rN, rX] = await this.db.batch([
      this.db.prepare(
        `SELECT c.sef_completo_em AS completo,
                (SELECT MIN(b.quando) FROM captura_buscas b WHERE b.empresa_id = c.empresa_id AND b.cstat IN ('117','118')) AS primeira
           FROM captura_empresas c WHERE c.tenant_id = ? AND c.empresa_id = ?`,
      ).bind(this.tenant, empresaId),
      this.db.prepare(
        `SELECT competencia, COUNT(*) AS n FROM notas
          WHERE tenant_id = ? AND empresa_id = ? AND cancelada_em IS NULL AND competencia IS NOT NULL
          GROUP BY competencia`,
      ).bind(this.tenant, empresaId),
      this.db.prepare(
        `SELECT substr(c.dh_emi, 1, 7) AS competencia, COUNT(*) AS n FROM captura_caixa c
          WHERE c.tenant_id = ? AND c.empresa_id = ? AND c.tipo = 'nota' AND c.chave IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM notas n WHERE n.tenant_id = c.tenant_id AND n.chave = c.chave)
            AND NOT EXISTS (SELECT 1 FROM captura_caixa e WHERE e.empresa_id = c.empresa_id AND e.chave = c.chave
                             AND e.tipo = 'evento' AND e.tp_evento IN ('110111','110112'))
          GROUP BY substr(c.dh_emi, 1, 7)`,
      ).bind(this.tenant, empresaId),
    ]);
    const c = (rC!.results as any[])[0];
    const meses = new Map<string, { noSistema: number; naCaixa: number }>();
    for (const r of rN!.results as any[]) meses.set(r.competencia, { noSistema: Number(r.n), naCaixa: 0 });
    for (const r of rX!.results as any[]) {
      const m = meses.get(r.competencia) ?? { noSistema: 0, naCaixa: 0 };
      m.naCaixa = Number(r.n);
      meses.set(r.competencia, m);
    }
    return { primeiraConsulta: c?.primeira ?? null, completoEm: c?.completo ?? null, meses };
  }

  /** As notas da caixa emitidas no período, dizendo quais já estão no sistema e quais a SEF cancelou. */
  async notasDaCaixa(empresaId: string, periodo: { de: string; ate: string }): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT c.nsu, c.chave, c.dh_emi, c.emit_cnpj, c.emit_nome, c.numero, c.valor, c.r2_chave,
                (SELECT n.id FROM notas n WHERE n.tenant_id = c.tenant_id AND n.chave = c.chave) AS nota_id,
                EXISTS (SELECT 1 FROM captura_caixa e WHERE e.empresa_id = c.empresa_id AND e.chave = c.chave
                         AND e.tipo = 'evento' AND e.tp_evento IN ('110111','110112')) AS cancelada
           FROM captura_caixa c
          WHERE c.tenant_id = ? AND c.empresa_id = ? AND c.tipo = 'nota'
            AND substr(c.dh_emi, 1, 10) >= ? AND substr(c.dh_emi, 1, 10) <= ?
          ORDER BY c.dh_emi, c.numero`,
      )
      .bind(this.tenant, empresaId, periodo.de, periodo.ate)
      .all<any>();
    return results;
  }

  async notasDaCaixaPorChave(empresaId: string, chaves: string[]): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    if (!chaves.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT nsu, chave, r2_chave FROM captura_caixa
          WHERE tenant_id = ? AND empresa_id = ? AND tipo = 'nota' AND chave IN (${chaves.map(() => '?').join(',')})`,
      )
      .bind(this.tenant, empresaId, ...chaves)
      .all<any>();
    return results;
  }

  /** Cancelamentos e cartas de correção da caixa cuja nota já está no sistema e que ainda não foram aplicados. */
  async eventosPendentesDaCaixa(empresaId: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT c.nsu, c.chave, c.tp_evento, c.r2_chave FROM captura_caixa c
           JOIN notas n ON n.tenant_id = c.tenant_id AND n.chave = c.chave
          WHERE c.tenant_id = ? AND c.empresa_id = ? AND c.tipo = 'evento' AND c.aplicado_em IS NULL
            AND c.tp_evento IN ('110111','110112','110110')
          ORDER BY c.nsu LIMIT 40`,
      )
      .bind(this.tenant, empresaId)
      .all<any>();
    return results;
  }

  async marcarEventosAplicados(empresaId: string, nsus: string[]): Promise<void> {
    this.exigirEmpresa(empresaId);
    if (!nsus.length) return;
    const t = agora();
    await this.db.batch(nsus.map((nsu) => this.db
      .prepare('UPDATE captura_caixa SET aplicado_em = ? WHERE tenant_id = ? AND empresa_id = ? AND nsu = ?')
      .bind(t, this.tenant, empresaId, nsu)));
  }

  /** Liga ou desliga a busca automática da empresa (01/10). Ligar de novo não fura a espera da SEF. */
  async configurarBuscaAutomatica(empresaId: string, ligada: boolean, desde: string | null): Promise<void> {
    this.exigirEmpresa(empresaId);
    const t = agora();
    const antes = await this.estadoSef(empresaId);
    await this.db
      .prepare(
        `INSERT INTO captura_empresas (empresa_id, tenant_id, atualizado_em) VALUES (?,?,?)
         ON CONFLICT(empresa_id) DO NOTHING`,
      )
      .bind(empresaId, this.tenant, t)
      .run();
    await this.db
      .prepare(
        `UPDATE captura_empresas SET auto_ligada = ?, auto_desde = COALESCE(?, auto_desde),
            auto_ligada_por = CASE WHEN ? = 1 THEN ? ELSE auto_ligada_por END,
            auto_ligada_em = CASE WHEN ? = 1 THEN ? ELSE auto_ligada_em END, atualizado_em = ?
          WHERE tenant_id = ? AND empresa_id = ?`,
      )
      .bind(ligada ? 1 : 0, desde, ligada ? 1 : 0, this.ctx.sessao.usuarioId, ligada ? 1 : 0, t, t, this.tenant, empresaId)
      .run();
    await this.aud.registrarLote([
      this.evento({
        acao: 'alterar', entidade: 'captura', entidadeId: empresaId, campo: 'busca_automatica',
        valorAntes: antes?.auto_ligada ? `ligada desde ${antes.auto_desde}` : 'desligada',
        valorDepois: ligada ? `ligada desde ${desde ?? antes?.auto_desde}` : 'desligada',
        origem: 'manual',
      }),
    ]);
  }

  async registrarBuscaAutomatica(empresaId: string, quando: string, resultado: string): Promise<void> {
    this.exigirEmpresa(empresaId);
    await this.db
      .prepare('UPDATE captura_empresas SET auto_ultima = ?, auto_ultimo_resultado = ? WHERE tenant_id = ? AND empresa_id = ?')
      .bind(quando, resultado.slice(0, 500), this.tenant, empresaId)
      .run();
  }

  /**
   * Notas da caixa que a busca automática ainda tem de olhar: emitidas a partir de
   * `desde`, que não estão no sistema e que ela não pulou antes. Mais antigas primeiro.
   */
  async pendentesDaBuscaAutomatica(empresaId: string, desde: string, limite: number): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT c.nsu, c.chave, c.emit_cnpj, c.dh_emi,
                EXISTS (SELECT 1 FROM captura_caixa e WHERE e.empresa_id = c.empresa_id AND e.chave = c.chave
                         AND e.tipo = 'evento' AND e.tp_evento IN ('110111','110112')) AS cancelada
           FROM captura_caixa c
          WHERE c.tenant_id = ? AND c.empresa_id = ? AND c.tipo = 'nota' AND c.chave IS NOT NULL
            AND c.auto_recusada IS NULL AND substr(c.dh_emi, 1, 10) >= ?
            AND NOT EXISTS (SELECT 1 FROM notas n WHERE n.tenant_id = c.tenant_id AND n.chave = c.chave)
          ORDER BY c.dh_emi, c.nsu LIMIT ?`,
      )
      .bind(this.tenant, empresaId, desde, limite)
      .all<any>();
    return results;
  }

  /** A busca automática pulou estas notas (motivo por chave). Continuam na caixa para a importação à mão. */
  async marcarPuladasNaBuscaAutomatica(empresaId: string, motivos: { chave: string; motivo: string }[]): Promise<void> {
    this.exigirEmpresa(empresaId);
    if (!motivos.length) return;
    await this.db.batch(motivos.map((m) => this.db
      .prepare(`UPDATE captura_caixa SET auto_recusada = ? WHERE tenant_id = ? AND empresa_id = ? AND chave = ? AND tipo = 'nota'`)
      .bind(m.motivo.slice(0, 300), this.tenant, empresaId, m.chave)));
  }

  /** Histórico das consultas à SEF, para a tela do administrador. */
  async historicoSef(): Promise<any[]> {
    const { results } = await this.db
      .prepare(
        `SELECT b.*, e.razao_social,
                CASE WHEN b.automatica = 1 THEN '${NOME_BUSCA_AUTOMATICA}' ELSE u.nome END AS usuario_nome FROM captura_buscas b
           JOIN empresas e ON e.id = b.empresa_id LEFT JOIN usuarios u ON u.id = b.usuario_id
          WHERE b.tenant_id = ? ORDER BY b.quando DESC LIMIT 40`,
      )
      .bind(this.tenant)
      .all<any>();
    const visiveis = new Set((await this.listarEmpresas()).map((e) => e.id));
    return results.filter((b) => visiveis.has(b.empresa_id));
  }

  /** Notas de estorno do recorte (29/09): ficam fora dos relatórios e aparecem em destaque. */
  async estornos(empresaId: string, competencia?: string, periodo?: Periodo): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia, periodo);
    const { results } = await this.db
      .prepare(
        `SELECT n.id, n.numero, n.serie, n.dh_emi, n.emit_nome, n.emit_cnpj, n.valor_total
           FROM notas n
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.estorno = 1 AND n.cancelada_em IS NULL ${r.sql}
          ORDER BY n.dh_emi, n.numero`,
      )
      .bind(this.tenant, empresaId, ...r.binds)
      .all<any>();
    return results;
  }

  async relatorioCfop(empresaId: string, competencia?: string, periodo?: Periodo): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia, periodo);
    const { results } = await this.db
      .prepare(
        `SELECT i.cfop_novo AS cfop_novo, i.cfop_original AS cfop_original,
                COUNT(*) AS itens, SUM(i.revisado) AS conferidos, SUM(i.valor_total) AS valor,
                SUM(COALESCE(i.valor_contabil, i.valor_total)) AS valor_contabil,
                SUM(COALESCE(i.v_bc_icms, 0)) AS v_bc, SUM(COALESCE(i.v_icms, 0)) AS v_icms,
                SUM(COALESCE(i.v_st, 0) + COALESCE(i.v_fcp_st, 0)) AS v_st, SUM(COALESCE(i.v_ipi, 0)) AS v_ipi,
                GROUP_CONCAT(DISTINCT n.id) AS notas
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL AND n.estorno = 0 ${r.sql}
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
  async relatorioAnalitico(empresaId: string, competencia?: string, cfop?: string, periodo?: Periodo): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia, periodo);
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
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL AND n.estorno = 0 ${r.sql} ${filtro}
          ORDER BY n.dh_emi, n.numero, i.n_item
          LIMIT 20000`,
      )
      .bind(this.tenant, empresaId, ...r.binds, ...binds)
      .all<any>();
    return results;
  }

  /** Itens do mês com os CFOPs de entrada dados, para a antecipação e o DIFAL (09/10). */
  async itensParaApuracao(empresaId: string, competencia: string, cfops: string[]): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia);
    const { results } = await this.db
      .prepare(
        `SELECT n.id AS nota_id, n.numero, n.serie, n.dh_emi, n.emit_nome, n.emit_cnpj, n.emit_uf, n.valor_total AS valor_nota,
                i.n_item, COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original) AS descricao, i.ncm,
                TRIM(i.cfop_novo) AS cfop, COALESCE(i.valor_total, 0) AS valor_produto,
                COALESCE(i.valor_contabil, i.valor_total, 0) AS valor_contabil,
                COALESCE(i.v_bc_icms, 0) AS base, COALESCE(i.v_icms, 0) AS icms,
                COALESCE(i.v_ipi, 0) AS ipi, COALESCE(i.v_st, 0) + COALESCE(i.v_fcp_st, 0) AS st
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL AND n.estorno = 0 ${r.sql}
            AND TRIM(i.cfop_novo) IN (${cfops.map(() => '?').join(',')})
          ORDER BY n.dh_emi, n.numero, i.n_item
          LIMIT 20000`,
      )
      .bind(this.tenant, empresaId, ...r.binds, ...cfops)
      .all<any>();
    return results;
  }

  async marcasApuracao(empresaId: string, tipo: string, competencia: string): Promise<Map<string, { situacao: 'fica' | 'sai'; por: string | null; em: string }>> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT m.nota_id, m.situacao, m.marcado_em, u.nome AS por
           FROM apuracao_marcas m LEFT JOIN usuarios u ON u.id = m.marcado_por
          WHERE m.tenant_id = ? AND m.empresa_id = ? AND m.tipo = ? AND m.competencia = ?`,
      )
      .bind(this.tenant, empresaId, tipo, competencia)
      .all<any>();
    return new Map(results.map((r: any) => [r.nota_id, { situacao: r.situacao, por: r.por ?? null, em: r.marcado_em }]));
  }

  /** Marca a nota na antecipação ou no DIFAL: fica, sai, ou volta para "a conferir" (null). Fica na trilha. */
  async marcarApuracao(empresaId: string, tipo: string, notaId: string, situacao: 'fica' | 'sai' | null): Promise<boolean> {
    this.exigirEmpresa(empresaId);
    const nota = await this.db
      .prepare('SELECT id, numero, competencia FROM notas WHERE tenant_id = ? AND empresa_id = ? AND id = ?')
      .bind(this.tenant, empresaId, notaId)
      .first<any>();
    if (!nota) return false;
    const antes = await this.db
      .prepare('SELECT situacao FROM apuracao_marcas WHERE tenant_id = ? AND empresa_id = ? AND tipo = ? AND nota_id = ?')
      .bind(this.tenant, empresaId, tipo, notaId)
      .first<any>();
    if ((antes?.situacao ?? null) === situacao) return true;
    const t = agora();
    await this.db.batch([
      situacao
        ? this.db.prepare(
          `INSERT INTO apuracao_marcas (tenant_id, empresa_id, tipo, nota_id, competencia, situacao, marcado_por, marcado_em)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(empresa_id, tipo, nota_id) DO UPDATE SET situacao = excluded.situacao,
             marcado_por = excluded.marcado_por, marcado_em = excluded.marcado_em, competencia = excluded.competencia`,
        ).bind(this.tenant, empresaId, tipo, notaId, nota.competencia ?? '', situacao, this.ctx.sessao.usuarioId, t)
        : this.db.prepare('DELETE FROM apuracao_marcas WHERE tenant_id = ? AND empresa_id = ? AND tipo = ? AND nota_id = ?')
          .bind(this.tenant, empresaId, tipo, notaId),
    ]);
    const nome = (v: string | null) => (v === 'fica' ? 'fica' : v === 'sai' ? 'não fica' : 'a conferir');
    await this.aud.registrarLote([
      this.evento({
        acao: 'alterar', entidade: 'apuracao', entidadeId: notaId, campo: tipo,
        valorAntes: `nota ${nota.numero}: ${nome(antes?.situacao ?? null)}`, valorDepois: `nota ${nota.numero}: ${nome(situacao)}`,
        origem: 'manual',
      }),
    ]);
    return true;
  }

  /**
   * Os itens do mês para a conferência com o Questor (02/10): um por linha, com o nome
   * da nota e o padronizado, a nota e o fornecedor. Mesmo recorte do relatório por
   * produto (sem canceladas e sem estornos), para os totais baterem com ele.
   */
  async itensParaConferencia(empresaId: string, competencia: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia);
    const { results } = await this.db
      .prepare(
        `SELECT i.x_prod_original AS original, COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), '') AS padronizado,
                UPPER(TRIM(COALESCE(i.unidade, ''))) AS unidade, COALESCE(i.ncm, '') AS ncm,
                COALESCE(i.quantidade, 0) AS quantidade, COALESCE(i.valor_total, 0) AS valor,
                n.numero AS nota, COALESCE(n.emit_nome, '') AS fornecedor
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL AND n.estorno = 0 ${r.sql}
          LIMIT 50000`,
      )
      .bind(this.tenant, empresaId, ...r.binds)
      .all<any>();
    return results;
  }

  /**
   * `cfop` (15/10, pedido da Taís na reunião): "o que eu botei 1101 me apareça só os
   * produtos do 1101" - para bater o olho e achar o pão de queijo no uso e consumo.
   * '(sem CFOP)' = itens ainda sem CFOP de entrada.
   */
  async relatorioProdutos(empresaId: string, competencia?: string, periodo?: Periodo, cfop?: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia, periodo);
    if (cfop === '(sem CFOP)') r.sql += " AND TRIM(COALESCE(i.cfop_novo, '')) = ''";
    else if (cfop) { r.sql += " AND TRIM(COALESCE(i.cfop_novo, '')) = ?"; r.binds.push(cfop); }
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
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL AND n.estorno = 0 ${r.sql}
          GROUP BY UPPER(TRIM(COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original))),
                   UPPER(TRIM(COALESCE(i.unidade, '')))`,
      )
      .bind(this.tenant, empresaId, ...r.binds)
      .all<any>();
    return results;
  }

  /**
   * Relatório por fornecedor e produto (16/10, pedido da Taís): cada produto de cada
   * fornecedor, separado pelo CFOP que veio na nota (5102, 5949...), com os CFOPs de
   * entrada que ficaram. Ela trata e confere no fim por aqui, batendo o olho no CFOP
   * que veio ao lado do que ficou. Só leitura.
   */
  async relatorioFornecedores(empresaId: string, competencia?: string, periodo?: Periodo): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia, periodo);
    const { results } = await this.db
      .prepare(
        `SELECT n.emit_cnpj AS cnpj, MIN(n.emit_nome) AS fornecedor,
                MIN(COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original)) AS descricao,
                UPPER(TRIM(COALESCE(i.unidade, ''))) AS unidade,
                TRIM(COALESCE(i.cfop_original, '')) AS cfop_veio,
                SUM(i.quantidade) AS quantidade, SUM(i.valor_total) AS valor,
                COUNT(*) AS itens, SUM(i.revisado) AS conferidos,
                COUNT(DISTINCT n.id) AS notas,
                GROUP_CONCAT(DISTINCT i.c_prod) AS codigos,
                GROUP_CONCAT(COALESCE(NULLIF(TRIM(i.cfop_novo), ''), '(sem CFOP)'), '|') AS entradas,
                MIN(i.x_prod_original) AS descricao_original,
                COUNT(DISTINCT i.x_prod_original) AS descricoes_originais
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL AND n.estorno = 0 ${r.sql}
          GROUP BY n.emit_cnpj,
                   UPPER(TRIM(COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original))),
                   UPPER(TRIM(COALESCE(i.unidade, ''))),
                   TRIM(COALESCE(i.cfop_original, ''))`,
      )
      .bind(this.tenant, empresaId, ...r.binds)
      .all<any>();
    return results;
  }

  /** Os CFOPs de entrada do período, com quantos itens - as opções do filtro de CFOP (15/10). */
  async cfopsDoPeriodo(empresaId: string, competencia?: string, periodo?: Periodo): Promise<{ cfop: string; itens: number }[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia, periodo);
    const { results } = await this.db
      .prepare(
        `SELECT TRIM(COALESCE(i.cfop_novo, '')) AS cfop, COUNT(*) AS itens
           FROM itens i JOIN notas n ON n.id = i.nota_id
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL AND n.estorno = 0 ${r.sql}
          GROUP BY 1 ORDER BY 1`,
      )
      .bind(this.tenant, empresaId, ...r.binds)
      .all<any>();
    return results.map((x: any) => ({ cfop: x.cfop || '(sem CFOP)', itens: Number(x.itens) }));
  }

  /**
   * Divergências (15/10, auditoria pedida na reunião): o MESMO produto, do MESMO
   * fornecedor, na MESMA operação (CFOP de saída), decidido com CFOPs de entrada
   * diferentes. É onde mora o erro do tipo Sprite: um mês 1102, outro 1403. Olha o
   * histórico inteiro da empresa, mas só traz o produto que aparece na competência
   * escolhida (é o mês que ela está fechando). Decidido = conferido ou digitado.
   */
  async divergencias(empresaId: string, competencia?: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const r = this.recorteCompetencia(competencia);
    const chave = "n.emit_cnpj || '|' || UPPER(TRIM(COALESCE(i.c_prod, ''))) || '|' || TRIM(COALESCE(i.cfop_original, ''))";
    const { results } = await this.db
      .prepare(
        `WITH decididos AS (
           SELECT ${chave} AS k, i.id AS item_id, i.n_item, i.c_prod, i.cfop_original, TRIM(i.cfop_novo) AS cfop,
                  COALESCE(NULLIF(TRIM(i.x_prod_novo), ''), i.x_prod_original) AS descricao, i.cfop_origem,
                  i.revisado_em, u.nome AS revisado_por_nome, n.id AS nota_id, n.numero, n.dh_emi, n.emit_nome, n.competencia
             FROM itens i JOIN notas n ON n.id = i.nota_id LEFT JOIN usuarios u ON u.id = i.revisado_por
            WHERE n.tenant_id = ? AND n.empresa_id = ? AND n.cancelada_em IS NULL AND n.estorno = 0
              AND (i.revisado = 1 OR COALESCE(i.cfop_origem, '') LIKE 'manual%')
              AND TRIM(COALESCE(i.cfop_novo, '')) <> ''
         ),
         divergentes AS (
           SELECT k FROM decididos GROUP BY k HAVING COUNT(DISTINCT cfop) > 1
         )
         SELECT d.* FROM decididos d
          WHERE d.k IN (SELECT k FROM divergentes)
            AND d.k IN (SELECT ${chave} FROM itens i JOIN notas n ON n.id = i.nota_id
                         WHERE n.tenant_id = ? AND n.empresa_id = ? ${r.sql})
          ORDER BY d.k, COALESCE(d.revisado_em, '') DESC
          LIMIT 1000`,
      )
      .bind(this.tenant, empresaId, this.tenant, empresaId, ...r.binds)
      .all<any>();
    const grupos = new Map<string, any>();
    for (const x of results as any[]) {
      let g = grupos.get(x.k);
      if (!g) {
        g = { fornecedor: x.emit_nome, codigo: x.c_prod, saida: x.cfop_original, descricao: x.descricao, cfops: {} as Record<string, number>, itens: [] as any[] };
        grupos.set(x.k, g);
      }
      g.cfops[x.cfop] = (g.cfops[x.cfop] ?? 0) + 1;
      g.itens.push({
        itemId: x.item_id, notaId: x.nota_id, numero: x.numero, emissao: x.dh_emi, competencia: x.competencia,
        cfop: x.cfop, como: String(x.cfop_origem ?? '').startsWith('manual') ? 'digitou' : 'conferiu',
        quem: x.revisado_por_nome ?? null, quando: x.revisado_em ?? null, descricao: x.descricao,
      });
    }
    return [...grupos.values()];
  }

  /**
   * Itens cujo NOME veio de outro produto (15/10): descrição dada por regra de NCM
   * (níveis 4 e 6) ou do fornecedor inteiro (5), que o motor gravava até esta data.
   * A origem gravada no item diz qual regra deu o nome; o que alguém digitou tem
   * origem "manual" e nunca entra aqui. Para cada um, o nome certo: o que ensinaram
   * para o PRÓPRIO produto (níveis 1, 2 e 3) ou, sem isso, o do fornecedor - o mesmo
   * que a importação daria hoje.
   */
  async nomesDeOutroProduto(empresaId: string): Promise<any[]> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT i.id AS item_id, i.n_item, i.c_prod, i.c_ean, i.ncm, i.cfop_original, i.cfop_origem,
                i.x_prod_original, i.x_prod_novo, i.x_prod_origem, i.revisado,
                n.id AS nota_id, n.numero, n.competencia, n.dh_emi, n.emit_cnpj, n.emit_nome,
                r.nivel AS regra_nivel
           FROM notas n CROSS JOIN itens i JOIN regras r ON r.id = SUBSTR(i.x_prod_origem, 7)
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND i.nota_id = n.id
            AND i.x_prod_origem LIKE 'regra:%'
            AND r.tenant_id = n.tenant_id AND r.empresa_id = n.empresa_id
            AND r.campo = 'descricao' AND r.nivel NOT IN (1, 2, 3)
          ORDER BY n.dh_emi, n.numero, i.n_item`,
      )
      .bind(this.tenant, empresaId)
      .all<any>();
    if (results.length === 0) return [];

    const comoItem = (i: any) => ({
      nItem: i.n_item, cProd: i.c_prod, cEAN: i.c_ean, xProd: i.x_prod_original, NCM: i.ncm,
      CEST: null, CFOP: i.cfop_original, uCom: null, qCom: null, vUnCom: null, vProd: null,
      cstIcms: null, temIbsCbs: false,
    }) as any;
    const candidatas = await this.carregarRegrasCandidatas(
      empresaId, results.flatMap((i: any) => chavesDoItem(comoItem(i), i.emit_cnpj)),
    );
    const semContexto = { perfil: 'revenda' as const, ufEmitente: null, ufDestinatario: null };
    return results.map((i: any) => {
      const s = sugerir('descricao', comoItem(i), regrasDoItem(comoItem(i), i.emit_cnpj, candidatas), semContexto);
      return {
        itemId: i.item_id, notaId: i.nota_id, numero: i.numero, competencia: i.competencia, emissao: i.dh_emi,
        fornecedor: i.emit_nome, nItem: i.n_item, codigo: i.c_prod, ncm: i.ncm,
        doFornecedor: i.x_prod_original, nomeAtual: i.x_prod_novo, nomeCerto: s.valor,
        comoFica: s.regraId ? 'nome ensinado para o próprio produto' : 'nome do fornecedor',
        origemAtual: i.x_prod_origem, origemCerta: s.origem, cfopOrigem: i.cfop_origem,
        conferido: Number(i.revisado) === 1, trocaNome: String(s.valor ?? '').trim() !== String(i.x_prod_novo ?? '').trim(),
      };
    });
  }

  /**
   * Corrige os itens de nomesDeOutroProduto: nome certo no item, cada troca na trilha
   * (origem "correcao:nome-de-outro-produto", com o nome de antes). Conferido continua
   * conferido; o CFOP não muda. Não ensina nada. Rodar de novo não acha mais nada.
   */
  async corrigirNomesDeOutroProduto(empresaId: string): Promise<{ itens: number; nomesTrocados: number }> {
    const lista = await this.nomesDeOutroProduto(empresaId);
    const comandos: D1PreparedStatement[] = [];
    for (const x of lista) {
      const sets = ['x_prod_novo = ?', 'x_prod_origem = ?'];
      const binds: unknown[] = [x.nomeCerto, x.origemCerta];
      // Linha não conferida com CFOP de palpite: a cor acompanha o que sobrou (como na importação).
      const cfopDoSistema = !String(x.cfopOrigem ?? '').startsWith('regra:') && !String(x.cfopOrigem ?? '').startsWith('manual');
      if (!x.conferido && cfopDoSistema) {
        sets.push('confianca = ?');
        binds.push(String(x.origemCerta).startsWith('regra:') ? 'media' : 'nenhuma');
      }
      // Se alguém mexeu no nome entre a leitura e agora, não sobrescreve.
      comandos.push(
        this.db
          .prepare(`UPDATE itens SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ? AND x_prod_origem = ?`)
          .bind(...binds, this.tenant, x.itemId, x.origemAtual),
      );
    }
    const feitos: any[] = [];
    for (let k = 0; k < comandos.length; k += 100) {
      const r = await this.db.batch(comandos.slice(k, k + 100));
      r.forEach((res: any, j: number) => { if (Number(res?.meta?.changes ?? 0) > 0) feitos.push(lista[k + j]); });
    }
    const eventos = feitos.filter((x) => x.trocaNome).map((x) =>
      this.evento({
        acao: 'alterar', entidade: 'item_nota', entidadeId: x.itemId, campo: 'descricao',
        valorAntes: x.nomeAtual ?? null, valorDepois: x.nomeCerto, origem: 'correcao:nome-de-outro-produto',
      }),
    );
    for (let k = 0; k < eventos.length; k += 100) await this.aud.registrarLote(eventos.slice(k, k + 100));
    return { itens: feitos.length, nomesTrocados: eventos.length };
  }

  /**
   * Verificação completa dos nomes (15/10, "isso não pode acontecer"): TODO item da
   * empresa cujo nome tratado é diferente do nome do fornecedor tem de ter vindo de
   * uma de duas fontes:
   *   - alguém digitou (origem "manual"), ou
   *   - uma regra de nome do PRÓPRIO produto (níveis 1, 2 e 3) cuja chave bate com o
   *     código, o código de barras e o fornecedor do item.
   * Qualquer outra coisa é erro e volta com o motivo. Só leitura.
   *
   * Dos digitados e dos que vieram de regra do próprio produto, separa para a
   * contadora olhar os que não têm nenhuma palavra em comum com o nome do fornecedor
   * (ex.: "1", ou o nome de outro produto colado na linha errada). Esses não são
   * corrigidos sozinhos: foi alguém que digitou.
   */
  async verificarNomes(empresaId: string): Promise<{
    comNomeTratado: number; digitados: number; doProprioProduto: number; erros: any[]; paraConferir: any[];
  }> {
    this.exigirEmpresa(empresaId);
    const { results } = await this.db
      .prepare(
        `SELECT i.id AS item_id, i.n_item, i.c_prod, i.c_ean, i.ncm, i.cfop_original,
                i.x_prod_original, i.x_prod_novo, i.x_prod_origem, i.revisado,
                n.id AS nota_id, n.numero, n.competencia, n.emit_cnpj, n.emit_nome,
                r.id AS r_id, r.nivel AS r_nivel, r.chave AS r_chave, r.campo AS r_campo, r.empresa_id AS r_empresa
           FROM notas n CROSS JOIN itens i
           LEFT JOIN regras r ON r.id = SUBSTR(i.x_prod_origem, 7) AND i.x_prod_origem LIKE 'regra:%'
          WHERE n.tenant_id = ? AND n.empresa_id = ? AND i.nota_id = n.id
            AND TRIM(COALESCE(i.x_prod_novo, '')) <> ''
            AND TRIM(i.x_prod_novo) <> TRIM(COALESCE(i.x_prod_original, ''))
          ORDER BY n.dh_emi, n.numero, i.n_item`,
      )
      .bind(this.tenant, empresaId)
      .all<any>();

    const palavras = (t: unknown) => new Set(
      String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
        .split(/[^A-Z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w)),
    );
    const linha = (i: any, motivo: string) => ({
      itemId: i.item_id, notaId: i.nota_id, numero: i.numero, competencia: i.competencia, nItem: i.n_item,
      fornecedor: i.emit_nome, codigo: i.c_prod, doFornecedor: i.x_prod_original, nomeAtual: i.x_prod_novo,
      origem: i.x_prod_origem, conferido: Number(i.revisado) === 1, motivo,
    });

    let digitados = 0;
    let doProprioProduto = 0;
    const erros: any[] = [];
    const paraConferir: any[] = [];
    for (const i of results as any[]) {
      const origem = String(i.x_prod_origem ?? '');
      const nadaEmComum = () => {
        const forn = palavras(i.x_prod_original);
        const novo = palavras(i.x_prod_novo);
        return novo.size === 0 || ![...novo].some((w) => forn.has(w));
      };
      if (origem.startsWith('manual')) {
        digitados += 1;
        if (nadaEmComum()) paraConferir.push(linha(i, 'digitado sem nenhuma palavra em comum com o nome do fornecedor'));
        continue;
      }
      if (!origem.startsWith('regra:')) { erros.push(linha(i, `nome diferente do fornecedor sem regra nem digitação (origem "${origem || 'vazia'}")`)); continue; }
      if (!i.r_id) { erros.push(linha(i, 'a regra que deu o nome não existe mais')); continue; }
      if (i.r_campo !== 'descricao') { erros.push(linha(i, `a origem aponta para uma regra de ${i.r_campo}, não de nome`)); continue; }
      if (i.r_empresa !== empresaId) { erros.push(linha(i, 'a regra que deu o nome é de outra empresa')); continue; }
      if (![1, 2, 3].includes(Number(i.r_nivel))) { erros.push(linha(i, `nome de outro produto (regra de nível ${i.r_nivel})`)); continue; }
      const item = { cProd: i.c_prod, cEAN: i.c_ean, NCM: i.ncm, CFOP: i.cfop_original } as any;
      if (chaveDoNivel(item, String(i.emit_cnpj ?? ''), Number(i.r_nivel) as Nivel) !== i.r_chave) {
        erros.push(linha(i, 'a regra que deu o nome é de outro código ou fornecedor'));
        continue;
      }
      doProprioProduto += 1;
      if (nadaEmComum()) paraConferir.push(linha(i, 'nome ensinado para o produto sem nenhuma palavra em comum com o nome do fornecedor'));
    }
    return { comNomeTratado: results.length, digitados, doProprioProduto, erros, paraConferir };
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
        `SELECT l.id, l.envio_id, l.origem, l.criado_em, l.criado_por, l.total_arquivos, l.importadas,
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
        id: chave, criadoEm: l.criado_em, quem: l.quem ?? null, origem: l.origem ?? null, lotes: [] as string[],
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

  /** O nome que vai na trilha: o e-mail de quem fez, ou "Busca automática". */
  get quemNaTrilha(): string {
    return this.ctx.automatica ? NOME_BUSCA_AUTOMATICA : this.ctx.sessao.email;
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

/** Palavras da busca aproximada: sem acento, maiúsculas; "de", "o", "e" ficam de fora. */
function palavrasAproximadas(texto: string): string[] {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .split(/[^A-Z0-9,./]+/).filter((p) => p.length >= 3 || /\d/.test(p)).slice(0, 6);
}

/**
 * Pontos de um produto na busca aproximada (16/10): 2 por palavra que aparece inteira
 * (produto, fornecedor ou código); 1 se uma palavra do produto, de 3 letras ou mais, é o
 * começo da palavra dela ("REFRIG" para "refrigerante", "PAP" para "papel").
 */
export function pontosAproximados(palavras: string[], r: { descricao?: string; descricao_original?: string; fornecedor?: string; c_prod?: string }): number {
  const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const prod = `${norm(r.descricao)} ${norm(r.descricao_original)}`;
  const forn = norm(r.fornecedor);
  const cod = norm(r.c_prod);
  const tokens = prod.split(/[^A-Z0-9]+/).filter((t) => t.length >= 3 && /^[A-Z]+$/.test(t));
  let pontos = 0;
  for (const w of palavras) {
    if (prod.includes(w) || forn.includes(w) || cod.includes(w)) pontos += 2;
    else if (w.length >= 4 && tokens.some((t) => w.startsWith(t))) pontos += 1;
  }
  return pontos;
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

// ------------------------------------------------------------------ busca automática: nível sistema
//
// O cron roda sem ninguém logado e passa por todos os escritórios. Esta é a única
// consulta de fora do Repo: acha as empresas com a busca automática ligada que a SEF
// já liberou. O resto (baixar, importar, trilha) passa pelo Repo, na sessão de quem
// ligou a busca daquela empresa.
//
// Entra quem a SEF já liberou (vai baixar) ou quem tem nota na caixa esperando a
// importação (de uma rodada que parou no limite). Quem a SEF liberou vem primeiro.
export async function buscasAutomaticasVencidas(db: D1Database, agoraIso: string, limite: number): Promise<any[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT c.empresa_id, c.tenant_id, c.auto_desde, c.auto_ligada_por, e.cnpj, e.razao_social,
                (c.proxima_consulta IS NULL OR c.proxima_consulta <= ?) AS sef_liberada,
                EXISTS (SELECT 1 FROM captura_caixa x
                         WHERE x.empresa_id = c.empresa_id AND x.tipo = 'nota' AND x.chave IS NOT NULL
                           AND x.auto_recusada IS NULL AND substr(x.dh_emi, 1, 10) >= c.auto_desde
                           AND NOT EXISTS (SELECT 1 FROM notas n WHERE n.tenant_id = x.tenant_id AND n.chave = x.chave)
                       ) AS tem_pendente,
                c.auto_ultima
           FROM captura_empresas c JOIN empresas e ON e.id = c.empresa_id
          WHERE c.auto_ligada = 1 AND c.auto_desde IS NOT NULL AND e.ativo = 1
       ) WHERE sef_liberada = 1 OR tem_pendente = 1
       ORDER BY sef_liberada DESC, auto_ultima IS NOT NULL, auto_ultima LIMIT ?`,
    )
    .bind(agoraIso, limite)
    .all<any>();
  return results;
}

/** O usuário que ligou a busca automática, como sessão — o cron importa em nome dele. */
export async function usuarioDaBuscaAutomatica(db: D1Database, usuarioId: string): Promise<{
  usuario: any; papeis: string[]; empresas: string[]; excecoes: { permissao: string; concedida: number }[];
} | null> {
  const [rU, rP, rE, rX] = await db.batch([
    db.prepare('SELECT id, tenant_id, email, nome, ativo FROM usuarios WHERE id = ?').bind(usuarioId),
    db.prepare(
      `SELECT DISTINCT pp.permissao FROM usuario_papeis up JOIN papel_permissoes pp ON pp.papel_id = up.papel_id
        WHERE up.usuario_id = ?`,
    ).bind(usuarioId),
    db.prepare('SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ?').bind(usuarioId),
    db.prepare('SELECT permissao, concedida FROM usuario_permissoes WHERE usuario_id = ?').bind(usuarioId),
  ]);
  const u = (rU!.results as any[])[0];
  if (!u || u.ativo !== 1) return null;
  return {
    usuario: u,
    papeis: (rP!.results as any[]).map((x) => x.permissao),
    empresas: (rE!.results as any[]).map((x) => x.empresa_id),
    excecoes: rX!.results as any[],
  };
}
