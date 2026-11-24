/**
 * O módulo "cloudflare:workers" só existe dentro da Cloudflare. Nos testes (Node) ele é
 * trocado por este (vitest.config.ts): só o bastante para a classe do ponto de entrada
 * interno (src/interno.ts) poder ser criada.
 */
export class WorkerEntrypoint<E = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: E;
  constructor(ctx: unknown, env: E) { this.ctx = ctx; this.env = env; }
}
