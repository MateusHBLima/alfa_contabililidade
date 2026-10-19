import { describe, it, expect } from 'vitest';
import { conversar, paraApi, ErroAssistente, FERRAMENTAS, INSTRUCOES } from '../src/assistente/assistente';
import { pontosAproximados } from '../src/db/repo';

/* O assistente (16/10) só procura e propõe. Estes testes trocam a API da IA (OpenAI,
   Responses API) por respostas gravadas: provam o laço de ferramentas, que proposta
   inválida não passa, que o começo do pedido fica igual (cache) e que erro da IA vira
   mensagem para ela, não tela quebrada. */

const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

const chamada = (call_id: string, name: string, args: unknown) =>
  ({ type: 'function_call', id: `fc_${call_id}`, call_id, name, arguments: JSON.stringify(args) });
const raciocinio = (id: string) => ({ type: 'reasoning', id, encrypted_content: 'cifrado', summary: [] });
const texto = (t: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t, annotations: [] }] });
const uso = (entrada: number, cache: number, saida: number) =>
  ({ input_tokens: entrada, input_tokens_details: { cached_tokens: cache }, output_tokens: saida });

const valida = { tipo: 'atencao', cnpj: '11', fornecedor: 'F', codigo: 'A1', produto: 'AGUA', cfopVeio: null, itens: 3 } as const;

describe('assistente: a conversa com a IA', () => {
  it('a conversa vira mensagens da API começando por ela, sem a saudação da tela', () => {
    expect(paraApi([
      { papel: 'assistente', texto: 'Oi!' },
      { papel: 'ela', texto: 'o guaraná é sempre 1403' },
      { papel: 'ela', texto: 'da Bebidas' },
      { papel: 'assistente', texto: 'Achei.' },
      { papel: 'ela', texto: '  ' },
    ])).toEqual([
      { role: 'user', content: 'o guaraná é sempre 1403\n\nda Bebidas' },
      { role: 'assistant', content: 'Achei.' },
    ]);
  });

  it('procura, propõe e responde; só as propostas válidas voltam', async () => {
    const pedidos: any[] = [];
    const roteiro = [
      { output: [raciocinio('rs_1'), chamada('c1', 'procurar_produtos', { texto: 'guarana' })], usage: uso(1200, 0, 80) },
      { output: [chamada('c2', 'propor_marcas', { acoes: [
        { tipo: 'atencao', cnpj: '11', codigo: 'A1' },
        { tipo: 'atencao', cnpj: '11', codigo: 'NAO' },
        { tipo: 'atencao', cnpj: '11', codigo: 'A1' }, // repetida: aparece uma vez só
      ] })], usage: uso(1500, 1280, 60) },
      { output: [texto('Separei para você confirmar.')], usage: uso(1600, 1536, 20) },
    ];
    const buscas: string[] = [];
    const r = await conversar({
      chave: 'k', empresa: 'EMPRESA X', mensagens: [{ papel: 'ela', texto: 'o guaraná precisa de atenção' }],
      ferramentas: {
        procurar: async (t) => { buscas.push(t); return [{ codigo: 'A1' }]; },
        validar: async (p) => (p.codigo === 'A1' ? { ok: true, proposta: { ...valida } } : { ok: false, erro: 'não encontrado' }),
      },
      buscar: (async (u: any, init: any) => {
        expect(String(u)).toBe('https://api.openai.com/v1/responses');
        expect(init.headers.authorization).toBe('Bearer k');
        pedidos.push(JSON.parse(init.body));
        return resposta(roteiro.shift());
      }) as any,
    });
    expect(r).toEqual({
      texto: 'Separei para você confirmar.', propostas: [valida],
      uso: { chamadas: 3, entrada: 4300, cache: 2816, saida: 160 },
      // 19/10: o que a IA fez fica junto, para gravar e revisar.
      passos: [
        { ferramenta: 'procurar_produtos', texto: 'guarana', achados: [{ codigo: 'A1' }] },
        { ferramenta: 'propor_marcas', pedidas: expect.any(Array), aceitas: 1, recusadas: ['NAO: não encontrado'] },
      ],
      ajustes: [],
    });
    expect(buscas).toEqual(['guarana']);
    expect(pedidos).toHaveLength(3);

    // Cache: o começo é sempre igual (modelo, instruções fixas, ferramentas), e a empresa
    // não entra nas instruções.
    for (const p of pedidos) {
      expect(p.model).toBe('gpt-6-luna');
      expect(p.instructions).toBe(INSTRUCOES);
      expect(p.tools).toEqual(FERRAMENTAS);
      expect(p.store).toBe(false);
      expect(p.include).toEqual(['reasoning.encrypted_content']);
      expect(p.prompt_cache_key).toBe('alfa-fiscal-assistente');
    }
    expect(INSTRUCOES).not.toContain('EMPRESA X');
    expect(pedidos[0].input).toEqual([
      { role: 'developer', content: 'Empresa aberta: EMPRESA X.' },
      { role: 'user', content: 'o guaraná precisa de atenção' },
    ]);
    // A conversa só cresce no fim: cada pedido começa exatamente com o anterior.
    expect(pedidos[1].input.slice(0, pedidos[0].input.length)).toEqual(pedidos[0].input);
    expect(pedidos[2].input.slice(0, pedidos[1].input.length)).toEqual(pedidos[1].input);
    // O raciocínio e a chamada voltam iguais, seguidos do resultado da busca.
    expect(pedidos[1].input.slice(2)).toEqual([
      raciocinio('rs_1'), chamada('c1', 'procurar_produtos', { texto: 'guarana' }),
      { type: 'function_call_output', call_id: 'c1', output: JSON.stringify([{ codigo: 'A1' }]) },
    ]);
    const devolvido = JSON.parse(pedidos[2].input.at(-1).output);
    expect(pedidos[2].input.at(-1).call_id).toBe('c2');
    expect(devolvido).toEqual({ mostradas_para_confirmar: 1, recusadas: ['NAO: não encontrado'] });
  });

  it('quando ela corrige, a IA anota o ajuste (sem mudar nada) e segue a conversa', async () => {
    const roteiro = [
      { output: [chamada('c1', 'anotar_ajuste', { o_que_mudar: 'não perguntar de novo', sobre: 'perguntei se era aquele produto' })] },
      { output: [chamada('c2', 'anotar_ajuste', { o_que_mudar: '   ' })] },
      { output: [texto('Anotado.')] },
    ];
    const pedidos: any[] = [];
    const r = await conversar({
      chave: 'k', empresa: 'E', mensagens: [{ papel: 'ela', texto: 'você perguntou de novo, não precisa' }],
      ferramentas: { procurar: async () => [], validar: async () => ({ ok: false, erro: 'x' }) },
      buscar: (async (_u: any, init: any) => { pedidos.push(JSON.parse(init.body)); return resposta(roteiro.shift()); }) as any,
    });
    expect(r.texto).toBe('Anotado.');
    expect(r.ajustes).toEqual([{ oQueMudar: 'não perguntar de novo', sobre: 'perguntei se era aquele produto' }]);
    expect(r.propostas).toEqual([]);
    expect(JSON.parse(pedidos[1].input.at(-1).output)).toEqual({ anotado: true });
    expect(JSON.parse(pedidos[2].input.at(-1).output)).toEqual({ erro: 'diga o que mudar' });
    expect(FERRAMENTAS.map((f) => f.name)).toEqual(['procurar_produtos', 'propor_marcas', 'anotar_ajuste']);
  });

  it('instruções de 19/10: aproximado com um produto só propõe direto; pergunta de situação responde direto', () => {
    expect(INSTRUCOES).toContain('mesmo aproximado, não pergunte se é ele');
    expect(INSTRUCOES).toContain('nem pelo mais usado: pergunte qual fica');
    expect(INSTRUCOES).toContain('não pergunte de novo');
    expect(INSTRUCOES).toContain('responda direto com o que a busca devolveu');
    expect(INSTRUCOES).toContain('anotar_ajuste');
    expect(INSTRUCOES).not.toContain('confira com ela se é aquele mesmo');
  });

  it('argumento quebrado da IA não derruba: a busca vai vazia', async () => {
    const buscas: string[] = [];
    const roteiro = [
      { output: [{ type: 'function_call', call_id: 'c1', name: 'procurar_produtos', arguments: '{quebrado' }] },
      { output: [texto('Não achei.')] },
    ];
    const r = await conversar({
      chave: 'k', empresa: 'E', mensagens: [{ papel: 'ela', texto: 'oi' }],
      ferramentas: { procurar: async (t) => { buscas.push(t); return []; }, validar: async () => ({ ok: false as const, erro: '' }) },
      buscar: (async () => resposta(roteiro.shift())) as any,
    });
    expect(buscas).toEqual(['']);
    expect(r.texto).toBe('Não achei.');
  });

  it('chave recusada, sem crédito ou IA fora do ar viram mensagem curta, sem detalhe técnico', async () => {
    const f = { procurar: async () => [], validar: async () => ({ ok: false as const, erro: '' }) };
    const tentar = (buscar: any) => conversar({ chave: 'k', empresa: 'E', mensagens: [{ papel: 'ela', texto: 'oi' }], ferramentas: f, buscar });
    await expect(tentar(async () => resposta({ error: 'x' }, 401))).rejects.toThrow(/chave da IA não foi aceita/);
    await expect(tentar(async () => resposta({ error: 'x' }, 429))).rejects.toThrow(/ocupada ou sem crédito/);
    await expect(tentar(async () => { throw new Error('rede'); })).rejects.toBeInstanceOf(ErroAssistente);
  });

  it('não fica em laço: no máximo 6 voltas, mesmo se a IA só pedir ferramenta', async () => {
    let n = 0;
    const r = await conversar({
      chave: 'k', empresa: 'E', mensagens: [{ papel: 'ela', texto: 'oi' }],
      ferramentas: { procurar: async () => [], validar: async () => ({ ok: false as const, erro: '' }) },
      buscar: (async () => { n += 1; return resposta({ output: [chamada(`c${n}`, 'procurar_produtos', { texto: 'x' })] }); }) as any,
    });
    expect(n).toBe(6);
    expect(r.propostas).toEqual([]);
    expect(r.texto).toMatch(/Pode dizer o produto e o fornecedor/);
  });

  it('busca aproximada: por extenso acha o abreviado da nota, sem pegar parecido errado', () => {
    const p = (texto: string, prod: string) => pontosAproximados(texto.split(' '), { descricao: prod, fornecedor: 'F', c_prod: 'X1' });
    expect(p('REFRIGERANTE', 'REFRIG GUARANA LATA')).toBe(1);
    expect(p('PAPEL TOALHA', 'PAP TOALHA 2 ROLOS')).toBe(3);
    expect(p('DETERGENTE', 'DET NEUTRO 500ML')).toBe(1);
    expect(p('MARGARINA', 'EMBALAGEM MARMITEX N8')).toBe(0);
    expect(p('GUARANA', 'AGUA MINERAL')).toBe(0);
  });
});
