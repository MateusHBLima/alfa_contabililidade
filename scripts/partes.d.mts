/**
 * Tipos das leituras frágeis da publicação (scripts/partes.mjs).
 *
 * O script é ESM puro de propósito — ele roda com `node scripts/publicar.mjs`,
 * sem passo de build, na máquina de quem publica. Mas os testes são TypeScript
 * e o typecheck cobre a pasta test/, então os tipos moram aqui.
 */
export function lerSegredo(texto: string, nome: string): string | undefined;
export function segredoPlausivel(valor: string | undefined): boolean;
export function acharIdBanco(saida: string, nome: string): string | null;
export function trocarDatabaseId(conf: string, id: string): string | null;
export function contarUsuarios(saida: string): number | null;
