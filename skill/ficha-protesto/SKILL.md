---
name: "ficha-protesto"
description: "Lê fichas de títulos de protesto (CENPROT, CRA/IEPTB, bancos) e gera a ficha JSON para o userscript \"Apontamento assistido\" do NoCartório. Use ao pedir \"ficha de protesto\" ou \"apontamento assistido\"."
---

# Ficha de protesto (Apontamento assistido – NoCartório)

A ficha é um JSON que a escrevente cola no botão **Apontamento assistido** (userscript "NoCartório – Apontamento assistido (Protesto)"), na tela *Selecionar serviço – Tabelionato de Protesto*. O script confere as pessoas, abre **um serviço "Protesto" por título**, inclui Apresentante, Cedente, Sacador e Devedor(es) nos atos e cadastra o documento **Título Apresentado para Protesto** no apontamento. No fim, mostra a relação título × serviço (código e link) para conferência e selagem manual.

## Quando gerar
- O usuário anexa uma ou mais fichas/solicitações de protesto (PDF da CENPROT, "Encaminhamento a protesto" da CRA, borderô de banco) e pede a ficha, o JSON ou o "apontamento assistido".
- Um PDF pode trazer vários títulos (a CRA costuma trazer vários por página; a CENPROT, um por solicitação em 1–2 páginas). Gere **um item em `titulos` para cada título**, todos na mesma ficha. Vários PDFs do mesmo lote podem ir na mesma ficha (use `origem` do primeiro e anote o arquivo em `fontes`).

## Regra de ouro
Só entra o que está ESCRITO no documento. Não calcule, não deduza, não complete. Campo sem dado = campo omitido (não use null nem "").
- Não deduza sexo, estado civil, nacionalidade. O script cadastra PF nova com sexo "Ignorado" e a escrevente pode trocar na conferência.
- Normalizar formato NÃO é deduzir: datas em aaaa-mm-dd, valores em número, cidade no padrão "Município - Estado" com a grafia oficial ("Sao Joao D'Aliança" / "SAO JOAO DA ALIANCA - GO" → "São João d'Aliança - Goiás"), CEP só dígitos.
- Lixo de extração (texto duplicado como "ZONA RURALZONA RURAL", celular "00", campos com "-") é limpo ou descartado, sempre com um aviso.
- Toda divergência ou suposição vai em `avisos` (o script mostra na conferência e na relação final).

## Formato (ficha_protesto_versao 1)
```json
{
  "ficha_protesto_versao": 1,
  "origem": "CENPROT",
  "arquivo": "Cenprot.pdf",
  "titulos": [
    {
      "ref": "CENPROT 2073258",
      "solicitacao": "2073258",
      "paginas": [1, 2],
      "apresentante": { "nome": "EMPRESA LTDA", "cnpj": "00.000.000/0000-00", "email": "…", "telefone": "…",
                        "endereco": { "rua": "…", "numero": "…", "complemento": "…", "bairro": "…", "cep": "00000000", "cidade": "Município - Estado" } },
      "sacador":  { "nome": "…", "cnpj": "…", "endereco": { … } },
      "cedente":  { "nome": "…", "cnpj": "…" },
      "devedores": [
        { "nome": "NOME DO DEVEDOR", "cpf": "000.000.000-00", "email": "…", "telefone": "…",
          "endereco": { "rua": "…", "bairro": "…", "cep": "73760000", "cidade": "São João d'Aliança - Goiás" } }
      ],
      "titulo": {
        "especie_sigla": "DMI",
        "especie_texto": "Duplicata de Venda Mercantil por Indicação",
        "numero": "4460",
        "nosso_numero": "4460",
        "data_emissao": "2023-07-27",
        "data_vencimento": "2024-04-20",
        "valor": 394116.40,
        "saldo": 394116.40,
        "praca": "São João d'Aliança - Goiás",
        "data_apresentacao": "2025-03-19",
        "endosso": "Sem Endosso",
        "aceite": "Não",
        "fins_falimentares": "Não"
      },
      "fontes": { "titulo": "Cenprot.pdf, p. 1, Dados do Título" },
      "avisos": ["…"]
    }
  ]
}
```

### Campos
- `origem`: "CENPROT", "CRA", "BANCO" ou o nome do remetente. `arquivo`: nome do PDF.
- `ref`: rótulo curto para a relação ("CENPROT 2073258", "CRA DSI 059110909").
- `paginas`: páginas do PDF em que o título está (1 = primeira). O script anexa só essas páginas como Requerimento do serviço. Se vários títulos dividem a mesma página, repita a página em cada um.
- Pessoas (`apresentante`, `sacador`, `cedente`, cada item de `devedores`): `nome` como está no documento; `cpf` (PF) ou `cnpj` (PJ) — **obrigatório**, é por ele que o script acha ou cadastra a pessoa; `email`, `telefone` e `endereco` quando constarem.
  - `endereco.rua` = logradouro + número como escritos ("FAZ BOA ESPERANCA ROD GO118, SN", "RUA 2 QD A-37, N. 505"); `numero`/`complemento` só se vierem em campo próprio; `bairro`; `cep` (8 dígitos); `cidade` ("Município - Estado").
  - Mais de um devedor (avalista, coobrigado) → um item por pessoa em `devedores`.
- `titulo` (vai para o documento "Título Apresentado para Protesto"):
  - `especie_sigla`: a sigla CENPROT da espécie (DMI, DSI, DM, DS, CDA, CCB, CPS, NP, CH, LC, DV, etc.); `especie_texto`: o nome escrito, se houver. O script procura a opção pela sigla.
  - `numero`, `nosso_numero`: como escritos (mantenha zeros à esquerda).
  - `data_emissao`, `data_vencimento`: aaaa-mm-dd.
  - Vencimento "À VISTA" (comum em CDA da PGFN/SEFAZ): omita `data_vencimento` e informe `"vencimento_a_vista": true`. O script lança a data de emissão como vencimento (é o que o cartório usa nas CDAs) e avisa. Não invente outra data.
  - `valor`: valor do título. `saldo`: "Valor a Protestar" (CENPROT) ou "Saldo do título" (CRA); se não houver, omita (o script usa o valor).
  - `praca`: "Praça pagamento" / "Praça de protesto". CENPROT normalmente não traz: omita (o script usa a cidade da serventia e avisa).
  - `data_apresentacao`: CRA → "Remessa ao cartório"; CENPROT → "Gerado"; borderô → data do borderô. Se não houver, omita (o script usa a data do dia).
  - `endosso`, `aceite`, `fins_falimentares`: informativos (o NoCartório não tem campo para eles no título); copie como escritos.

## Mapeamento por origem
**CENPROT – "Solicitação de Protesto Nº …"**
- Dados Apresentante → `apresentante`; Dados Sacador → `sacador`; Dados Cedente → `cedente`; Dados Devedor → `devedores`.
- Dados do Título: Número → `numero`; Nosso Número → `nosso_numero`; Valor do Título → `valor`; Valor a Protestar → `saldo`; Gerado → `data_apresentacao`; Emissão; Vencimento; Espécie "DMI - Duplicata…" → `especie_sigla` "DMI" + `especie_texto`.
- A 2ª página (declaração e certificado) faz parte da solicitação: inclua-a em `paginas`.

**CRA – "Encaminhamento a protesto" (um bloco por título)**
- Sacado → devedor (`devedores`), com CPF/CNPJ e endereço das linhas seguintes.
- Favorecido/Cedente → `cedente`; Sacador/Endereço → `sacador`.
- Apresentante: a CRA não traz campo próprio. Se houver um remetente claro no cabeçalho (ex.: a empresa que encaminha), use-o como `apresentante` e avise "Apresentante não vem nomeado no CRA: usado o remetente do cabeçalho". Se não houver, omita `apresentante` (o script usa o sacador e avisa).
- Data emissão, Vencimento, Nosso número, Espécie (sigla), Número do título, Valor do título → `valor`, Saldo do título → `saldo`, Praça pagamento → `praca`, Remessa ao cartório → `data_apresentacao`.
- "Código do cedente" não vai para o NoCartório; se tiver cara de outra coisa (ex.: telefone), anote em `avisos`.
- Os dados do sacador/cedente costumam se repetir em todos os blocos: repita-os em cada título.

**Outros (borderô de banco, títulos avulsos)**: mesmos campos; se o papel de alguém não estiver claro, pergunte em vez de supor.

## Cuidados que viram aviso
- Divergência de dados da mesma pessoa entre blocos ou entre cabeçalho e bloco (CEP, endereço, razão social) — use o do bloco próprio e avise.
- Datas incoerentes (vencimento antes da emissão, data de geração muito antiga, título vencido há mais de 5 anos) — copie e avise.
- Saldo maior que o valor (CDA atualizada) é normal: não avise.
- Nome do devedor sem CPF/CNPJ — não dá para abrir o serviço; avise e pergunte.
- CPF/CNPJ com dígito verificador inválido — copie e avise.

## Saída
1. Um bloco ```json com a ficha completa e válida, sem comentários. Se tiver mais de 3 títulos, salve também como `ficha-protesto-<origem>-<data>.json` e envie o arquivo.
2. Embaixo, em poucas linhas: quantos títulos, devedores e valores (lista curta), quem ficou como apresentante, e os avisos mais importantes.
3. Lembrete fixo: no NoCartório, em *Abrir um serviço → Tabelionato de Protesto*, clicar em **Apontamento assistido**, colar a ficha (e, se quiser, o PDF original), **Conferir ficha**, revisar pessoas novas e avisos, e **Abrir serviços marcados**. No fim, copiar a relação título × serviço, conferir cada serviço e gerar os selos manualmente.