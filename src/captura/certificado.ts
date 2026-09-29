/**
 * Certificado digital A1 da captura no SAT (29/09/2026).
 *
 * O Web Service de Download de NF-e da SEF/SC só aceita certificado (mTLS) de
 * contabilista vinculado à empresa. A ALFA tem dois A1: o do escritório (e-CNPJ)
 * e o da Isa (e-CPF). Cada empresa usa o de quem é o contabilista responsável.
 *
 * ONDE A CHAVE FICA. O Worker não consegue apresentar certificado de cliente
 * carregado em tempo de execução: só por "mTLS certificate binding", que a
 * Cloudflare guarda e nunca devolve. Então o .pfx é lido aqui, na memória desta
 * requisição, a chave privada vai direto para o cofre de certificados da conta
 * Cloudflare, e NADA da chave é gravado no nosso banco, no R2 ou em log. Fica
 * só o que se pode mostrar: titular, documento, validade e o id na Cloudflare.
 */
import forge from 'node-forge';

export class ErroCertificado extends Error {}

export type CertificadoLido = {
  titular: string;
  /** CNPJ (e-CNPJ) ou CPF (e-CPF), só dígitos, quando o nome segue o padrão ICP-Brasil "NOME:DOC" */
  documento: string | null;
  tipo: 'e-CNPJ' | 'e-CPF' | 'outro';
  emissor: string;
  icpBrasil: boolean;
  serial: string;
  validoDe: string;
  validoAte: string;
  /** certificado + cadeia, PEM — vai para a Cloudflare */
  certificadosPem: string;
  /** chave privada PEM — vai para a Cloudflare e é descartada */
  chavePem: string;
};

const campo = (atributos: forge.pki.CertificateField[], nome: string) =>
  String(atributos.find((a) => a.shortName === nome || a.name === nome)?.value ?? '');

export function lerPfx(bytes: Uint8Array, senha: string): CertificadoLido {
  if (bytes.length === 0) throw new ErroCertificado('Arquivo vazio.');
  if (bytes.length > 50_000) throw new ErroCertificado('Arquivo grande demais para um certificado A1 (.pfx).');
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.binary.raw.encode(bytes);
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, senha);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/MAC|password|Invalid/i.test(msg)) throw new ErroCertificado('Senha do certificado incorreta.');
    throw new ErroCertificado('Não consegui ler o arquivo. Ele precisa ser o certificado A1 (.pfx ou .p12).');
  }

  const oids = forge.pki.oids as Record<string, string>;
  const bolsas = (tipo: string): any[] => (p12.getBags({ bagType: tipo }) as any)[tipo] ?? [];
  const chaves = [...bolsas(oids['pkcs8ShroudedKeyBag']!), ...bolsas(oids['keyBag']!)];
  const chave = chaves.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!chave) throw new ErroCertificado('O arquivo não tem a chave privada. Exporte o certificado A1 com a chave.');
  const certs = bolsas(oids['certBag']!)
    .map((b) => b.cert as forge.pki.Certificate | undefined)
    .filter((c): c is forge.pki.Certificate => !!c);
  // O certificado do titular é o que tem a mesma chave pública da chave privada.
  const titularCert = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals?.(chave.n));
  if (!titularCert) throw new ErroCertificado('O arquivo não tem o certificado correspondente à chave.');
  const cadeia = [titularCert, ...certs.filter((c) => c !== titularCert)];

  const cn = campo(titularCert.subject.attributes, 'CN');
  const [nome, doc] = cn.includes(':') ? [cn.slice(0, cn.lastIndexOf(':')), cn.slice(cn.lastIndexOf(':') + 1)] : [cn, ''];
  const documento = /^\d{11}$|^\d{14}$|^[0-9A-Z]{14}$/.test(doc) ? doc : null;
  const tipo = documento?.length === 14 ? 'e-CNPJ' : documento?.length === 11 ? 'e-CPF' : 'outro';
  const org = [campo(titularCert.subject.attributes, 'O'), campo(titularCert.issuer.attributes, 'O')].join(' ');

  return {
    titular: nome.trim() || cn,
    documento,
    tipo,
    emissor: campo(titularCert.issuer.attributes, 'CN'),
    icpBrasil: /ICP-Brasil/i.test(org),
    serial: titularCert.serialNumber,
    validoDe: titularCert.validity.notBefore.toISOString(),
    validoAte: titularCert.validity.notAfter.toISOString(),
    certificadosPem: cadeia.map((c) => forge.pki.certificateToPem(c)).join(''),
    chavePem: forge.pki.privateKeyToPem(chave),
  };
}

/** Envia para o cofre de certificados mTLS da conta Cloudflare. Devolve o id. */
export async function enviarParaCloudflare(
  cfg: { contaId: string; token: string },
  nome: string,
  c: CertificadoLido,
): Promise<string> {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.contaId}/mtls_certificates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: nome, certificates: c.certificadosPem, private_key: c.chavePem, ca: false }),
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j?.success || !j?.result?.id) {
    const motivo = j?.errors?.[0]?.message ?? `HTTP ${r.status}`;
    throw new ErroCertificado(`A Cloudflare recusou guardar o certificado: ${motivo}`);
  }
  return String(j.result.id);
}

export async function removerDaCloudflare(cfg: { contaId: string; token: string }, id: string): Promise<void> {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.contaId}/mtls_certificates/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!r.ok && r.status !== 404) throw new ErroCertificado(`A Cloudflare recusou remover o certificado (HTTP ${r.status}).`);
}
