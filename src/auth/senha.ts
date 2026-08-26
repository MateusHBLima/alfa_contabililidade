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

const ITERACOES = 600_000;
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
  try {
    const salt = deB64(partes[2] as string);
    const esperado = deB64(partes[3] as string);
    const obtido = await derivar(senha, salt, iteracoes);
    return igualConstante(obtido, esperado);
  } catch {
    return false;
  }
}

/** True quando o hash foi gerado com parametros antigos e vale reidratar no proximo login. */
export function precisaReidratar(armazenado: string): boolean {
  const partes = armazenado.split('$');
  return partes[0] !== 'pbkdf2' || Number(partes[1]) < ITERACOES;
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
