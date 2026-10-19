/**
 * Assistente da contadora (16/10, pedido da Taís no áudio de 15/10):
 *
 *   "se tu colocar a inteligência artificial para eu conversar... eu consigo ir colocando
 *    os produtos que eu quero que fique como precisa atenção e que eu consiga escrever que
 *    alguns não têm que mudar porque eles já são automáticos (...) aí já vai sumir uns
 *    quantos que aparece ali para mim e que às vezes eu até troco por outra coisa e acabo
 *    trocando errado."
 *
 * A IA NÃO MUDA NADA SOZINHA. Ela tem três ferramentas:
 *   - procurar_produtos: leitura, só da empresa aberta;
 *   - propor_marcas: devolve propostas para a tela. Quem confirma é a pessoa, no botão,
 *     e a confirmação passa pelas permissões e pela trilha de sempre (rota /marcas-produto);
 *   - anotar_ajuste (19/10): quando ela corrige a IA, a correção fica anotada para revisão.
 *
 * Tudo fica gravado (19/10, Mateus: "isso tem que ficar gravado, para que possamos usar
 * para ajustar a IA"): o que ela escreveu, o que a IA procurou e viu, o que propôs, o que
 * ela confirmou ou deixou de lado e o que ela disse que deve mudar. Ver a rota /assistente.
 *
 * O modelo é chamado pela API da OpenAI (Responses API) com a chave do servidor
 * (OPENAI_API_KEY, segredo no painel da Cloudflare). Sem a chave, a rota diz isso e nada
 * é chamado.
 *
 * Cache de prompt (decisão do Mateus, 16/10): a OpenAI guarda sozinha o começo repetido
 * do pedido. Para aproveitar, o começo é sempre igual: ferramentas e instruções fixas,
 * sem nada que mude de empresa para empresa (a empresa vai numa mensagem logo depois).
 * Dentro de um mesmo pedido a conversa só cresce no fim, então a segunda e a terceira
 * chamada reaproveitam a primeira. O uso (tokens e quanto veio do cache) volta em `uso`
 * para o log.
 */

export type MensagemChat = { papel: 'ela' | 'assistente'; texto: string };

export type PropostaMarca = {
  tipo: 'automatico' | 'atencao' | 'tirar_atencao';
  cnpj: string;
  fornecedor: string;
  codigo: string;
  produto: string;
  cfopVeio: string | null;
  cfop?: string;
  observacao?: string;
  itens: number;
};

export type FerramentasAssistente = {
  procurar: (texto: string) => Promise<unknown[]>;
  validar: (p: { tipo: string; cnpj: string; codigo: string; cfopVeio?: string; cfop?: string; observacao?: string })
    => Promise<{ ok: true; proposta: PropostaMarca } | { ok: false; erro: string }>;
};

export class ErroAssistente extends Error {}

/** Tokens gastos no pedido, somando as voltas: o que entrou, quanto disso veio do cache e o que saiu. */
export type UsoIA = { chamadas: number; entrada: number; cache: number; saida: number };

/** Modelo padrão (o mais barato da OpenAI em 16/10/2026). Pode ser trocado pela variável IA_MODELO. */
export const MODELO_PADRAO = 'gpt-6-luna';

const LIMITE_VOLTAS = 6;

/** Instruções fixas: iguais para todas as empresas, para o cache de prompt valer sempre. */
export const INSTRUCOES = `Você é o assistente do Alfa Fiscal, o sistema onde a contadora trata as notas fiscais de entrada (NF-e) de uma empresa cliente. O nome da empresa aberta vem na primeira mensagem. Fale português do Brasil, curto e direto, como numa conversa de WhatsApp: frases curtas, sem títulos, sem listas longas, sem emojis.

Sua única função é ajudar a marcar produtos dos fornecedores desta empresa:
- "automático": aquele produto, daquele fornecedor, naquela operação (o CFOP que veio na nota, como 5102 ou 5405), sempre entra com o mesmo CFOP de entrada e não precisa ser olhado. Isso fixa o padrão: as próximas notas já chegam certas.
- "atenção": aquele produto daquele fornecedor sempre aparece para ela conferir, mesmo que o sistema já saiba o CFOP. Não muda CFOP nenhum.
- "tirar atenção": desfaz a marca de atenção.

Como trabalhar:
1. Antes de propor, use procurar_produtos para achar o produto exato. Procure pelo nome do produto, pelo nome do fornecedor ou pelo código. Nas notas os nomes vêm abreviados (REFRIG, DET, PAP, CX); se não achar, tente com menos palavras ou com o começo da palavra. Resultado com "aproximado": true quer dizer que a nota escreve diferente dela (abreviado). Se veio um produto só que bate com o pedido, mesmo aproximado, não pergunte se é ele: trate como achado e diga o nome como está na nota (quem confere é ela, no botão). Só pergunte qual é se vierem produtos diferentes que podem ser o que ela quer.
2. O mesmo produto pode aparecer em mais de um CFOP que veio. Se ela não disse qual, proponha para todos os que aparecerem, ou pergunte se ficar ambíguo. Se vierem produtos diferentes parecidos, pergunte qual ela quer. Se ela já respondeu a uma pergunta sua (qual produto, qual CFOP), não pergunte de novo: proponha.
   Se ela só perguntar como está um produto (se já é automático, se está para conferir), responda direto com o que a busca devolveu, sem propor nada.
3. Para "automático", use o CFOP de entrada que ela disser. Se ela não disser e o produto só teve um CFOP de entrada (o campo entradas), use esse e diga qual é na resposta. Se teve mais de um, ou nenhum, não escolha, nem pelo mais usado: pergunte qual fica, dizendo os que já entraram.
4. Depois chame propor_marcas. Você não aplica nada: as propostas aparecem na tela para ela confirmar no botão. Diga isso numa frase curta.
5. Nunca invente produto, fornecedor, código ou CFOP: use só o que a busca devolveu. Não dê conselho fiscal; se ela perguntar qual CFOP é o certo, diga que quem decide é ela.
6. Se o pedido for sobre outra coisa do sistema, diga que por enquanto você só ajuda a marcar produtos e que o resto é com o Mateus.
7. Se ela disser que você errou, entendeu errado ou deveria fazer diferente (no jeito de falar, na busca ou na proposta), chame anotar_ajuste com o que ela quer que mude, nas palavras dela, e o que você tinha feito. Depois siga o pedido dela normalmente. Responder a uma pergunta sua (dizer qual produto ou qual CFOP fica) não é ajuste.`;

/** A empresa aberta, numa mensagem logo depois das instruções (fora do começo fixo). */
export const mensagemEmpresa = (empresa: string) => ({ role: 'developer' as const, content: `Empresa aberta: ${empresa}.` });

export const FERRAMENTAS = [
  {
    type: 'function',
    name: 'procurar_produtos',
    description:
      'Procura produtos já recebidos por esta empresa. Devolve até 25 produtos, cada um separado por fornecedor, código do fornecedor e CFOP que veio na nota, com os CFOPs de entrada já usados, se já é automático (padrão fixado) e se está marcado para atenção.',
    parameters: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Pedaço do nome do produto, do nome do fornecedor, o código do produto ou o CNPJ do fornecedor.' },
      },
      required: ['texto'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'propor_marcas',
    description:
      'Mostra na tela as marcas para ela confirmar. Não grava nada. Use os dados exatos devolvidos por procurar_produtos.',
    parameters: {
      type: 'object',
      properties: {
        acoes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tipo: { type: 'string', enum: ['automatico', 'atencao', 'tirar_atencao'] },
              cnpj: { type: 'string', description: 'CNPJ do fornecedor, como veio na busca.' },
              codigo: { type: 'string', description: 'Código do produto no fornecedor, como veio na busca.' },
              cfop_que_veio: { type: 'string', description: 'O CFOP que veio na nota (obrigatório para automatico).' },
              cfop_entrada: { type: 'string', description: 'Só para automatico: o CFOP de entrada que deve ficar.' },
              observacao: { type: 'string', description: 'O motivo, nas palavras dela, se ela disse.' },
            },
            required: ['tipo', 'cnpj', 'codigo'],
          },
        },
      },
      required: ['acoes'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'anotar_ajuste',
    description:
      'Anota, para o Mateus revisar depois, o que ela disse que você deve fazer diferente. Não muda nada no sistema e não aparece para ela.',
    parameters: {
      type: 'object',
      properties: {
        o_que_mudar: { type: 'string', description: 'O que ela quer que mude, nas palavras dela.' },
        sobre: { type: 'string', description: 'O que você tinha dito, procurado ou proposto que ela corrigiu.' },
      },
      required: ['o_que_mudar'],
    },
    strict: false,
  },
];

/**
 * O que a IA fez em cada volta, para gravar junto com a resposta (19/10, pedido do Mateus:
 * "ver o que ela está falando e sugerindo"). A busca guarda o que a IA viu, como viu.
 */
export type PassoAssistente =
  | { ferramenta: 'procurar_produtos'; texto: string; achados: unknown[] }
  | { ferramenta: 'propor_marcas'; pedidas: unknown[]; aceitas: number; recusadas: string[] }
  | { ferramenta: 'anotar_ajuste'; oQueMudar: string; sobre?: string }
  | { ferramenta: string; desconhecida: true };

/** Ajuste que a própria IA anotou quando ela corrigiu (vai para a tela de revisão). */
export type AjusteAnotado = { oQueMudar: string; sobre?: string };

/** A conversa vira mensagens da API: só texto, alternando, começando por ela. */
export function paraApi(mensagens: MensagemChat[]): { role: 'user' | 'assistant'; content: any }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of mensagens) {
    const role = m.papel === 'ela' ? 'user' : 'assistant';
    const texto = String(m.texto ?? '').trim();
    if (!texto) continue;
    const ultima = out.at(-1);
    if (ultima && ultima.role === role) ultima.content += `\n\n${texto}`;
    else out.push({ role, content: texto });
  }
  while (out.length && out[0]!.role !== 'user') out.shift();
  return out;
}

type ItemSaida =
  | { type: 'message'; content?: { type: string; text?: string }[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: string; [k: string]: unknown };

/** Lê os argumentos da ferramenta (vêm como texto JSON); se vierem quebrados, volta vazio. */
function argumentos(texto: unknown): any {
  try { return JSON.parse(String(texto ?? '{}')) ?? {}; } catch { return {}; }
}

/** Endereço padrão da API (a variável IA_URL troca, por exemplo para um teste local). */
export const URL_PADRAO = 'https://api.openai.com/v1/responses';

export async function conversar(opts: {
  chave: string;
  modelo?: string;
  url?: string;
  empresa: string;
  mensagens: MensagemChat[];
  ferramentas: FerramentasAssistente;
  buscar?: typeof fetch;
}): Promise<{ texto: string; propostas: PropostaMarca[]; uso: UsoIA; passos: PassoAssistente[]; ajustes: AjusteAnotado[] }> {
  const buscar = opts.buscar ?? fetch;
  const passos: PassoAssistente[] = [];
  const ajustes: AjusteAnotado[] = [];
  const conversa = paraApi(opts.mensagens);
  if (conversa.length === 0 || conversa.at(-1)!.role !== 'user') throw new ErroAssistente('mensagem vazia');
  // Só cresce no fim: é isso que deixa as voltas seguintes reaproveitarem o cache.
  const input: any[] = [mensagemEmpresa(opts.empresa), ...conversa];
  const propostas = new Map<string, PropostaMarca>();
  const uso: UsoIA = { chamadas: 0, entrada: 0, cache: 0, saida: 0 };
  let texto = '';

  for (let volta = 0; volta < LIMITE_VOLTAS; volta++) {
    let r: Response;
    try {
      r = await buscar(opts.url || URL_PADRAO, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.chave}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opts.modelo || MODELO_PADRAO,
          instructions: INSTRUCOES,
          tools: FERRAMENTAS,
          input,
          reasoning: { effort: 'low' },
          max_output_tokens: 4096,
          // Nada fica guardado na OpenAI; o raciocínio volta cifrado para seguir a conversa.
          store: false,
          include: ['reasoning.encrypted_content'],
          prompt_cache_key: 'alfa-fiscal-assistente',
        }),
      });
    } catch {
      throw new ErroAssistente('não consegui falar com a IA agora. Tente de novo em instantes.');
    }
    if (!r.ok) {
      const motivo = r.status === 401 ? 'a chave da IA não foi aceita'
        : r.status === 429 ? 'a IA está ocupada ou sem crédito'
        : `a IA respondeu ${r.status}`;
      throw new ErroAssistente(`${motivo}. Tente de novo em instantes.`);
    }
    const d = (await r.json()) as { output?: ItemSaida[]; usage?: any };
    uso.chamadas += 1;
    uso.entrada += Number(d.usage?.input_tokens ?? 0);
    uso.cache += Number(d.usage?.input_tokens_details?.cached_tokens ?? 0);
    uso.saida += Number(d.usage?.output_tokens ?? 0);
    const saida = Array.isArray(d.output) ? d.output : [];
    // Tudo o que veio (inclusive o raciocínio) volta igual na próxima chamada.
    input.push(...saida);
    const chamadas = saida.filter((o): o is Extract<ItemSaida, { type: 'function_call' }> => o.type === 'function_call');
    texto = saida
      .filter((o): o is Extract<ItemSaida, { type: 'message' }> => o.type === 'message')
      .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
      .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (chamadas.length === 0) break;

    for (const ch of chamadas) {
      const a = argumentos(ch.arguments);
      let resultado: string;
      if (ch.name === 'procurar_produtos') {
        const busca = String(a.texto ?? '').slice(0, 80);
        const achados = await opts.ferramentas.procurar(busca);
        passos.push({ ferramenta: 'procurar_produtos', texto: busca, achados });
        resultado = JSON.stringify(achados.length ? achados : { nada: 'nenhum produto com esse texto nesta empresa' });
      } else if (ch.name === 'anotar_ajuste') {
        const oQueMudar = String(a.o_que_mudar ?? '').trim().slice(0, 1000);
        const sobre = a.sobre == null ? undefined : String(a.sobre).trim().slice(0, 1000) || undefined;
        if (oQueMudar) {
          ajustes.push({ oQueMudar, sobre });
          passos.push({ ferramenta: 'anotar_ajuste', oQueMudar, sobre });
        }
        resultado = JSON.stringify(oQueMudar ? { anotado: true } : { erro: 'diga o que mudar' });
      } else if (ch.name === 'propor_marcas') {
        const recusadas: string[] = [];
        const acoes = Array.isArray(a.acoes) ? a.acoes.slice(0, 30) : [];
        const antes = propostas.size;
        for (const x of acoes) {
          const v = await opts.ferramentas.validar({
            tipo: String(x?.tipo ?? ''), cnpj: String(x?.cnpj ?? ''), codigo: String(x?.codigo ?? ''),
            cfopVeio: x?.cfop_que_veio == null ? undefined : String(x.cfop_que_veio),
            cfop: x?.cfop_entrada == null ? undefined : String(x.cfop_entrada),
            observacao: x?.observacao == null ? undefined : String(x.observacao),
          });
          if (v.ok) propostas.set(`${v.proposta.tipo}|${v.proposta.cnpj}|${v.proposta.codigo}|${v.proposta.cfopVeio ?? '*'}`, v.proposta);
          else recusadas.push(`${x?.codigo ?? '?'}: ${v.erro}`);
        }
        passos.push({ ferramenta: 'propor_marcas', pedidas: acoes, aceitas: propostas.size - antes, recusadas });
        resultado = JSON.stringify({ mostradas_para_confirmar: propostas.size, recusadas });
      } else {
        passos.push({ ferramenta: String(ch.name ?? '?'), desconhecida: true });
        resultado = JSON.stringify({ erro: 'ferramenta desconhecida' });
      }
      input.push({ type: 'function_call_output', call_id: ch.call_id, output: resultado });
    }
  }

  if (!texto) texto = propostas.size ? 'Separei aqui embaixo para você confirmar.' : 'Não consegui entender. Pode dizer o produto e o fornecedor?';
  return { texto, propostas: [...propostas.values()], uso, passos, ajustes };
}
