/**
 * Hash de senha com PBKDF2-SHA256 via WebCrypto.
 *
 * Por que PBKDF2 e nao Argon2id: WebCrypto e nativo no runtime de Workers, sem WASM,
 * sem dependencia e sem cold start extra. Argon2id resiste melhor a ataque com GPU,
 * e o caminho de upgrade esta previsto: o formato do hash carrega o algoritmo no prefixo,
 * entao da para reidratar no proximo login sem forcar ninguem a trocar de senha.
 *
 * 600.000 iteracoes segue a recomendacao da OWASP para PBKDF2-SHA256.
 */

/**
 * 100.000 iterações — o teto do runtime de Workers, não uma escolha nossa.
 *
 * A OWASP recomenda 600.000 para PBKDF2-SHA256, e era isso que estava aqui. Só
 * que a Cloudflare limita PBKDF2 a 100.000 iterações no `deriveBits` para evitar
 * que um tenant consuma CPU do vizinho. Acima disso a chamada ESTOURA — e como
 * o `conferirSenha` capturava a exceção devolvendo `false`, uma falha de
 * infraestrutura chegava ao usuário como "e-mail ou senha inválidos".
 *
 * O pior é que isso não aparecia em desenvolvimento: o workerd que o
 * `wrangler dev` roda aceitou 600.000 sem reclamar. Todos os 186 testes
 * passavam, o login local funcionava, e só a produção recusava.
 *
 * Compensação: exigimos senha longa (§avaliarSenha). Doze caracteres com
 * 100.000 iterações resistem melhor do que oito com 600.000 — comprimento
 * multiplica o espaço de busca, iteração só o custo por tentativa.
 *
 * Se um dia a Cloudflare subir o teto, subir aqui basta: o número de iterações
 * viaja dentro do hash e o `precisaReidratar` reidrata no próximo login.
 */
const ITERACOES = 100_000;

/** Teto do runtime. Acima disto o WebCrypto do Workers recusa a operação. */
export const MAX_ITERACOES_RUNTIME = 100_000;

/**
 * Hash que este ambiente não consegue conferir — não é senha errada.
 *
 * Existe para separar duas coisas que o `catch` genérico misturava: "a senha
 * não bate" e "não consegui calcular". A primeira é resposta de negócio; a
 * segunda é defeito, e defeito tem que aparecer como defeito.
 */
export class HashIncompativel extends Error {
  constructor(public iteracoes: number) {
    super(
      `Senha gravada com ${iteracoes} iterações; este ambiente aceita no máximo `
      + `${MAX_ITERACOES_RUNTIME}. É preciso redefinir a senha.`,
    );
    this.name = 'HashIncompativel';
  }
}
const TAM_SALT = 16;
const TAM_HASH = 32;

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function deB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function derivar(senha: string, salt: Uint8Array, iteracoes: number): Promise<Uint8Array> {
  const chave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(senha.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: iteracoes, hash: 'SHA-256' },
    chave,
    TAM_HASH * 8,
  );
  return new Uint8Array(bits);
}

export async function gerarHashSenha(senha: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(TAM_SALT));
  const hash = await derivar(senha, salt, ITERACOES);
  return `pbkdf2$${ITERACOES}$${b64(salt)}$${b64(hash)}`;
}

/**
 * Hash de mentira, para gastar o mesmo tempo quando o e-mail não existe.
 *
 * Mora aqui, montado a partir de ITERACOES, porque a versão anterior estava
 * escrita à mão no handler de login com 600.000 fixo — e quando o teto do
 * runtime baixou para 100.000, esse literal esquecido passou a estourar
 * justamente no caminho do e-mail inexistente. Constante que se repete em dois
 * arquivos é constante que um dia diverge.
 */
export const HASH_INEXISTENTE = `pbkdf2$${ITERACOES}$AAAAAAAAAAAAAAAAAAAAAA==$`
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Comparacao em tempo constante: nao vaza quantos bytes bateram. */
function igualConstante(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

export async function conferirSenha(senha: string, armazenado: string): Promise<boolean> {
  const partes = armazenado.split('$');
  if (partes.length !== 4 || partes[0] !== 'pbkdf2') return false;
  const iteracoes = Number(partes[1]);
  if (!Number.isFinite(iteracoes) || iteracoes < 1000) return false;

  // Antes de tentar: hash acima do teto do runtime não é senha errada, é hash
  // que este ambiente não consegue conferir. Deixar cair no catch abaixo foi
  // exatamente o bug que derrubou o primeiro login em produção.
  if (iteracoes > MAX_ITERACOES_RUNTIME) throw new HashIncompativel(iteracoes);

  // O base64 é decodificado FORA do try. Hash gravado torto é defeito de dado,
  // não senha errada — e o `catch { return false }` que existia aqui é o mesmo
  // padrão que fez o teto de iterações se disfarçar de credencial inválida por
  // horas. Entrada suja continua devolvendo false; o que quebra, quebra à vista.
  let salt: Uint8Array;
  let esperado: Uint8Array;
  try {
    salt = deB64(partes[2] as string);
    esperado = deB64(partes[3] as string);
  } catch {
    return false;   // base64 inválido é dado malformado, e isso é "não confere"
  }
  if (salt.length === 0 || esperado.length !== TAM_HASH) return false;

  // Daqui para baixo, qualquer exceção sobe: só o WebCrypto pode falhar, e se
  // ele falhar é problema de ambiente, que precisa aparecer como problema.
  const obtido = await derivar(senha, salt, iteracoes);
  return igualConstante(obtido, esperado);
}

/** True quando o hash foi gerado com parametros antigos e vale reidratar no proximo login. */
export function precisaReidratar(armazenado: string): boolean {
  const partes = armazenado.split('$');
  // Diferente, não menor: hash com iterações ACIMA do teto também precisa ser
  // refeito — e esse é o caso que existe de verdade hoje.
  return partes[0] !== 'pbkdf2' || Number(partes[1]) !== ITERACOES;
}

export type ForcaSenha = { ok: boolean; problemas: string[] };

/**
 * Politica minima. Comprimento pesa mais do que "tem simbolo": frase longa vence
 * senha curta cheia de caractere estranho, e o usuario nao a anota num post-it.
 */
export function avaliarSenha(senha: string, email?: string): ForcaSenha {
  const problemas: string[] = [];
  if (senha.length < 12) problemas.push('use pelo menos 12 caracteres');
  if (!/[a-zA-Z]/.test(senha)) problemas.push('inclua pelo menos uma letra');
  if (!/[0-9]/.test(senha) && senha.length < 16)
    problemas.push('inclua um número, ou use uma frase mais longa');
  if (email && senha.toLowerCase().includes(email.split('@')[0]!.toLowerCase()))
    problemas.push('não use seu e-mail dentro da senha');
  const comuns = ['senha', 'password', '123456', 'qwerty', 'alfa', 'planee', 'contabilidade'];
  if (comuns.some((c) => senha.toLowerCase().includes(c)))
    problemas.push('evite palavras óbvias como "senha", "planee" ou "alfa"');
  return { ok: problemas.length === 0, problemas };
}
