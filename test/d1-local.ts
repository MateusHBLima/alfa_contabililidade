import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Carregado por require e não por import: o bundler do Vitest não resolve `node:sqlite`
// estaticamente, e aqui queremos o módulo nativo do Node, sem dependência externa.
const exigir = createRequire(import.meta.url);
const { DatabaseSync } = exigir('node:sqlite') as { DatabaseSync: any };
type DatabaseSync = any;

/**
 * Adaptador que faz o `node:sqlite` falar a interface do D1.
 *
 * Serve para rodar o sistema de verdade nos testes, contra um SQLite real, sem
 * depender de conta na Cloudflare. O D1 É SQLite, então o que passa aqui passa lá -
 * com a ressalva de que latência, limites e concorrência do D1 não são simulados.
 */

type Bind = string | number | null;

class Stmt {
  private args: Bind[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}

  bind(...args: unknown[]): Stmt {
    this.args = args.map(normalizar);
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const r = this.db.prepare(this.sql).get(...this.args);
    return (r as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }

  /**
   * `meta.changes` importa: o código de produção decide com base nele.
   *
   * As escritas condicionais da autenticação — "só avança o contador do TOTP se
   * ninguém avançou antes", "só gasta o código de recuperação se ele ainda não
   * foi usado" — perguntam quantas linhas mudaram para saber se venceram a
   * corrida. Um shim que devolvesse só `{ success: true }` deixaria justamente
   * essa lógica sem teste, que é onde ela mais precisa de um.
   */
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const r = this.db.prepare(this.sql).run(...this.args);
    return {
      success: true,
      meta: { changes: Number(r?.changes ?? 0), last_row_id: Number(r?.lastInsertRowid ?? 0) },
    };
  }

  executar(): void {
    this.db.prepare(this.sql).run(...this.args);
  }
}

function normalizar(v: unknown): Bind {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  return String(v);
}

export class D1Local {
  private db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  /** Aplica as migrações reais do projeto, em ordem. */
  migrar(dir = 'migrations'): string[] {
    const arquivos = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of arquivos) this.db.exec(readFileSync(join(dir, f), 'utf8'));
    return arquivos;
  }

  prepare(sql: string): Stmt {
    return new Stmt(this.db, sql);
  }

  async batch(stmts: Stmt[]): Promise<{ success: true }[]> {
    this.db.exec('BEGIN');
    try {
      for (const s of stmts) s.executar();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return stmts.map(() => ({ success: true as const }));
  }

  /** Atalho para asserções nos testes. */
  consultar<T = any>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...args.map(normalizar)) as T[];
  }
}

/** R2 de mentira: um Map. Guarda o que foi gravado para o teste conferir. */
export class R2Local {
  readonly objetos = new Map<string, { corpo: string; meta: Record<string, string> }>();

  async put(chave: string, corpo: string, opts?: { customMetadata?: Record<string, string> }) {
    this.objetos.set(chave, { corpo, meta: opts?.customMetadata ?? {} });
    return { key: chave };
  }

  async get(chave: string) {
    const o = this.objetos.get(chave);
    if (!o) return null;
    return { text: async () => o.corpo };
  }
}
