/**
 * As quatro leituras frágeis da publicação, isoladas para poderem ser testadas.
 *
 * Todas elas interpretam saída de ferramenta externa ou arquivo escrito à mão —
 * o tipo de código que parece óbvio, passa despercebido na revisão e erra na
 * hora errada. Três das quatro já erraram; os testes em test/publicar.test.ts
 * documentam cada caso.
 */

/**
 * Lê um segredo do SEGREDOS.txt.
 *
 * O nome tem que estar SOZINHO numa linha; o valor é a próxima linha não vazia.
 *
 * A primeira versão procurava o nome em qualquer lugar do arquivo e pegava a
 * palavra seguinte. Só que a primeira ocorrência de "SESSION_SECRET" está no
 * bloco de instruções — `npx wrangler secret put SESSION_SECRET` — então ela
 * lia "npx" como segredo de sessão, e "SESSION_SECRET" como AUDIT_SEED. Iria
 * direto para produção assinar cookie e abrir a cadeia de auditoria.
 */
export function lerSegredo(texto, nome) {
  const linhas = texto.split(/\r?\n/);
  const i = linhas.findIndex((l) => l.trim() === nome);
  if (i < 0) return undefined;
  for (let k = i + 1; k < linhas.length; k++) {
    const v = linhas[k].trim();
    if (v) return v;
  }
  return undefined;
}

/** Um valor só é aceito como segredo se não tiver cara de outra coisa. */
export function segredoPlausivel(valor) {
  if (!valor || valor.length < 24) return false;
  if (/\s/.test(valor)) return false;
  return !/^(npx|wrangler|secret|put|#)$/i.test(valor);
}

/**
 * Acha o uuid do banco na saída de `wrangler d1 list --json`.
 * O wrangler imprime banner e avisos antes do JSON, então cortamos no `[`.
 */
export function acharIdBanco(saida, nome) {
  // Cortar no PRIMEIRO '[' era errado: o wrangler desatualizado imprime
  //     ▲ [WARNING] The version of Wrangler you are using is now out-of-date.
  // antes do JSON — e esse '[' vem primeiro. O parse estourava, a função
  // devolvia null, e o script concluiria que o banco não existe: criaria um
  // segundo "planee-fiscal" na conta e apontaria o wrangler.jsonc para ele,
  // deixando o banco com os dados para trás. E o aviso está na tela do Mateus.
  for (let i = saida.indexOf('['); i >= 0; i = saida.indexOf('[', i + 1)) {
    try {
      const bancos = JSON.parse(saida.slice(i));
      if (!Array.isArray(bancos)) continue;
      return (bancos.find((b) => b && b.name === nome) || {}).uuid || null;
    } catch { /* esse '[' não abria o JSON; tenta o próximo */ }
  }
  return null;
}

/** Troca o database_id no wrangler.jsonc sem encostar em mais nada. */
export function trocarDatabaseId(conf, id) {
  const novo = conf.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${id}"`);
  return novo === conf ? null : novo;
}

/**
 * Conta usuários a partir de `d1 execute --json`.
 *
 * Devolve null quando não dá para saber — e quem chama tem que PARAR nesse caso.
 * Sem `--json` o wrangler desenha uma tabela em ASCII, o número não casa, e um
 * `?? 0` transformava "não sei" em "zero usuários": o script criaria um admin
 * que já existe e estouraria o UNIQUE do e-mail no meio da publicação.
 */
export function contarUsuarios(saida) {
  const m = saida.match(/"n":\s*(\d+)/);
  return m ? Number(m[1]) : null;
}
