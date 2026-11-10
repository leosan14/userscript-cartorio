---
name: "ficha-cadastro-unificado"
description: "Gera a ficha JSON do protocolo (partes, papéis e documentos) para importar no NoCartório pelo script \"Ficha no cadastro unificado\", a partir da minuta, do título e dos PDFs. Use ao pedir \"gera a ficha\" ou ao terminar uma minuta."
---

# Ficha do protocolo para o Cadastro unificado (NoCartório)

A ficha é um JSON que o escrevente cola no NoCartório (botão **Importar ficha**, na tela do serviço ou do ato). O script "NoCartório – Ficha no cadastro unificado" (0.3.0+) procura cada pessoa pelo CPF/CNPJ e cada imóvel pela matrícula, mostra uma conferência de papéis e abre tudo no **Cadastro unificado** (0.4.0+), já preenchido, para revisar e gravar de uma vez: matrículas, pessoas novas, inclusão nos papéis do ato e documentos. Nada é gravado sem a revisão do escrevente.

O formato é o mesmo do "Preenchedor por Ficha" (`ficha_versao` 1), com um bloco a mais, `partes`, que diz quem entra em qual papel do ato. Serve para qualquer ato de Notas ou de Registro de Imóveis, não só inventário.

## Quando gerar
- Sempre que o usuário pedir a ficha.
- Ao terminar uma minuta (skill de minutas): ofereça gerar a ficha em uma linha, ou gere direto se o usuário já tiver pedido.

## Regra de ouro
Só entra na ficha o que está ESCRITO na minuta, no título ou nos PDFs. Nunca calcule, deduza ou complete valor. Campo sem dado = campo omitido (não use null nem "").
- O mesmo fato escrito pode ir para dois campos que significam a mesma coisa (ex.: "natural de Planaltina/GO" → `naturalidade` e `cidade_nascimento`).
- NÃO deduza sexo pela concordância ("brasileira", "filha de"), estado civil, regime de bens, data, nacionalidade de outro documento, etc. Se a minuta não diz, fica de fora — o Cadastro unificado mostra o campo vazio para o escrevente preencher.
- NÃO calcule livro, folha e termo a partir da matrícula da certidão: informe só a matrícula; o script calcula e marca como "calculado".
- Marcadores [[PREENCHER]] ou [[CONFERIR]] da minuta não são dados: o campo fica fora.
- Todo dado relevante leva a fonte em `fontes` (documento + local: "Minuta, Cláusula Primeira", "Certidão de óbito, campo matrícula").

## Catálogo (fonte de verdade de tipos e campos)
- O catálogo completo dos tipos de documento da NoCartório (todas as atribuições: RCPN, Notas, RI, RTD/PJ, Protesto) é gerado pelo botão **Exportar catálogo** do script "Ficha no cadastro unificado" (arquivo `catalogo-nocartorio.md`). Ele fica na última seção desta skill ("Catálogo de tipos de documento da NoCartório") ou num arquivo `catalogo-nocartorio.md` anexado à conversa ou ao projeto.
- Quando houver catálogo, ele vence as tabelas desta skill: use o `tipo` e os aliases exatamente como estão lá. Legenda: * obrigatório · K campo-chave · [d] data · [dh] data e hora · [h] hora · [$] dinheiro · [n] número · [t] texto longo · [b] sim/não · [cpf] [cnpj] [cep] [tel] com máscara · [mat] matrícula de 32 dígitos · [s:lista] seleção (veja "Listas de opções": se a lista está completa, use o texto exato de uma opção; se é "lista grande", escreva o texto e o script busca) · (anexo) exige arquivo (o cadastro unificado não envia anexos).
- Sem catálogo, use as tabelas abaixo. Tipo que não está em nenhum dos dois: peça ao usuário o número e os campos (ou que gere o catálogo) em vez de inventar. Campo com alias errado é ignorado pelo script, com aviso.
- Atualizar o catálogo: quando o usuário trouxer um `catalogo-nocartorio.md` novo e pedir para atualizar a skill, substitua a última seção inteira pelo conteúdo do arquivo (sem mexer no resto) e proponha a skill atualizada.

## Formato (ficha_versao 1)
```json
{
  "ficha_versao": 1,
  "protocolo": "A-XXXX-0000000000",
  "ato": "Escritura de inventário",
  "partes": [
    { "nome": "NOME COMPLETO", "cpf": "000.000.000-00", "papeis": ["Herdeiros"] },
    { "nome": "EMPRESA LTDA", "cnpj": "00.000.000/0000-00", "papeis": ["Comprador"] },
    { "matricula": "8761", "cnm": "0292312000876117" },
    { "registro_auxiliar": "6942" }
  ],
  "comum": { "alias": "valor" },
  "fontes_comum": { "alias": "fonte" },
  "documentos": [
    {
      "tipo": 6,
      "nome": "Certidão de nascimento",
      "parte": { "nome": "NOME COMPLETO", "cpf": "000.000.000-00" },
      "rotulo": "texto curto opcional",
      "campos": { "alias": "valor" },
      "fontes": { "alias": "fonte" }
    }
  ]
}
```
- `protocolo`: código do serviço no NoCartório (ex.: "A-ZMOS-1779450478"), se o usuário informou ou se consta dos documentos. O script avisa se a ficha for colada no serviço errado.
- `ato`: o tipo de ato como na minuta ("Escritura de inventário", "Escritura de compra e venda", "Registro de compra e venda"). Ajuda o script a escolher o ato certo dentro do serviço.
- `tipo`: número do tipo de documento no NoCartório (tabelas abaixo). `nome`: o nome do tipo.
- `parte` (a quem o documento se prende):
  - Pessoa: `{"nome": "NOME COMPLETO", "cpf": "000.000.000-00"}` (pessoa jurídica: `"cnpj"`). Inclua sempre o CPF/CNPJ quando constar: é por ele que o script acha a pessoa na NoCartório e decide se é nova.
  - Imóvel com matrícula: `{"matricula": "8761"}` (só o número; o mesmo número usado em `partes`).
  - Registro do Livro 3 (Registro Auxiliar — CPR, cédulas, pacto antenupcial, convenção de condomínio etc.): `{"registro_auxiliar": "6942"}` (só o número; na minuta aparece como "R-6942" ou "Registro Auxiliar nº 6.942"). O título registrado no Livro 3 (ex.: a CPR, tipo 192) se prende ao registro, NÃO a uma das partes. Nunca use `"matricula"` para o Livro 3: M-6942 e R-6942 são cadastros diferentes.
  - Matrícula ainda não aberta (ato de abertura; perfil temporário "(P-KEIF-1792412090-4) Abertura de matrícula…"): `{"codigo": "P-KEIF-1792412090-4"}`. Se o usuário não informou o código, peça.
- `comum`: dados que valem para vários formulários do imóvel e do negócio (numero_matricula_imovel, codigo_nacional_matricula, numero_inscricao_imobiliaria, codigo_imovel_rural_incra, numero_ccir, codigo_receita, numero_cadastro_ambiental_rural, codigo_certificacao_sigef, denominacao_imovel_rural, area, data_alienacao, valor_alienacao, forma_pagamento, prazo_pagamento, valor_financiamento, valor_pago_com_recursos_proprios, valor_pago_com_recursos_concedidos_pelo_fgts, quantidade_parcelas_financiamento, endereco_rua, endereco_numero, endereco_bairro, endereco_cep, endereco_cidade, cidade_sede_imovel, onr_tipo_logradouro).
- `campos` do documento SEMPRE vencem o `comum`. Nunca vêm do comum: identificador_registro, data_emissao, data_validade, numero_certificado, certidao_numero, valor, valor_pago, data_pagamento, autenticacao_pagamento, livro, pagina, data_lavratura, resumo_executivo, observacoes, nome. Esses vão sempre em `campos`.
- Um bloco por documento físico. Por parte, só um documento de cada tipo (o script usa o primeiro).
- `"usar_comum": false` no bloco desliga a herança do comum (use nos memoriais SIGEF, tipo 411).

## Partes e papéis (`partes`)
- Uma entrada para cada pessoa física ou jurídica que figura no ato, com `papeis` = os papéis do ato no NoCartório, escritos como aparecem lá. O script aceita singular/plural e masculino/feminino ("Herdeiro" = "Herdeiros", "Meeira" = "Meeiro"); papel que não existe no ato aparece como aviso e o escrevente escolhe na conferência.
- Papéis mais comuns:
  - Inventário/partilha: De Cujus · Herdeiros · Meeiro · Viuvo · Inventariante · Advogado · Cessionário · Cedente · Renunciante · Anuente · Interveniente · Curador · Testemunha
  - Compra e venda: Vendedor · Comprador · Anuente · Interveniente
  - Doação: Doador · Donatário
  - Registro de Imóveis: use os papéis do ato de registro informados pelo usuário (ex.: Transmitente, Adquirente, Credor, Devedor); na dúvida, pergunte.
- Inventário:
  - Autor da herança → "De Cujus".
  - Cônjuge sobrevivente meeiro → "Viuvo" e "Meeiro"; companheiro(a) supérstite em união estável → "Meeiro" (não "Viuvo"). Inventariante nomeado → acrescente "Inventariante" (a mesma pessoa pode ter vários papéis).
  - Herdeiros → "Herdeiros"; advogado → "Advogado"; cessionário/cedente de direitos hereditários → "Cessionário"/"Cedente".
- Imóveis (matrículas): uma entrada em `partes` para cada matrícula objeto do ato — `{"matricula": "8761"}`, com `"cnm"` (Código Nacional de Matrícula) quando constar na certidão/minuta e, se for o caso, `"nome"` curto ("Fazenda Boa Vista"). `papeis` é opcional: sem ele o script usa o papel de matrícula do ato ("Matrícula do Livro de Registro Geral"); informe só se o usuário indicar outro.
  - O script acha o cadastro do imóvel na NoCartório pelo número (e pelo CNM, se houver) e o inclui no ato antes das pessoas. Ao incluir a matrícula, a NoCartório costuma incluir sozinha os proprietários; mesmo assim, liste em `partes` todas as pessoas com seus papéis.
  - Matrícula de outro cartório ou com número repetido: informe o `cnm` para evitar ambiguidade (sem ele, o escrevente escolhe na conferência).
  - Matrícula sem cadastro (perfil) na NoCartório não é criada pela ficha: o script avisa e aponta o termo no Livro Indicador Real. Matrícula ainda não aberta continua pelo perfil temporário (`{"codigo": …}`).
  - Os documentos do imóvel vão em `documentos` com `"parte": {"matricula": …}`.
- Registros do Livro 3 (Registro Auxiliar): uma entrada em `partes` para cada registro objeto do ato — `{"registro_auxiliar": "6942"}`, com `"cnm"` quando constar (o 7º dígito do CNM é 3 no Livro 3 e 2 no Livro 2). `papeis` é opcional: sem ele o script usa "Matrícula do Livro de Registros Auxiliares". O documento do título registrado (CPR, cédula etc.) vai com `"parte": {"registro_auxiliar": …}`.
  - Se a minuta trouxer dois números de registro (ex.: o registro deste ato e um registro anterior ao qual ele se liga), use o do registro em que o título está sendo lançado e diga na saída qual número usou. Na dúvida, pergunte.
  - Registro sem cadastro na NoCartório não é criado pela ficha: o script avisa e os documentos dele ficam de fora.
- Pessoas que só aparecem nos documentos (sem `partes`) e que ainda não estão no ato são ignoradas pelo script, com aviso. Por isso, liste em `partes` todas as pessoas do ato.

## Formatos dos valores
- Datas: "aaaa-mm-dd".
- Dinheiro (money): número com ponto decimal, sem R$: 25000.00.
- Número (numeric): número com ponto decimal: 12.3456.
- Área: imóvel RURAL em hectares (ha); URBANO em m². Número puro. Se a fonte trouxer outra unidade, converta e registre em `fontes` o valor original e a conversão ("Memorial, 48.400,00 m² = 4,8400 ha"). Área construída sempre em m². Perímetro (perimeter) em metros.
- CPF, CNPJ, CEP, telefone: com ou sem máscara.
- Caixa de marcar (boolean): true / false.
- Seleção (select): o texto da opção. O script procura a opção na NoCartório pelo texto:
  - cidades (naturalidade, cidade_nascimento, cidade_obito, endereco_cidade, cidade_sede_imovel, local_assinatura, forum_endereco_cidade): "Município - Estado", ex. "São João d'Aliança - Goiás", "Brasília - Distrito Federal". Município sozinho é ambíguo ("Planaltina" existe em GO e no DF).
  - estados (estado_orgao_emissor, estado, uf_documento_responsavel_tecnico): nome do estado, ex. "Goiás".
  - nacionalidade: "Brasileira" (só se a minuta disser brasileiro/brasileira).
  - orgao_expedidor: a sigla, ex. "SSP", "SPTC", "PC", "DETRAN" (a UF vai em estado_orgao_emissor). "SSP/GO" → orgao_expedidor "SSP" + estado_orgao_emissor "Goiás".
  - nome_serventia (Cartório de origem): objeto com o nome como está na minuta e a busca por "Município - UF": `{"texto": "Cartório de Registro Civil das Pessoas Naturais de Planaltina/GO", "busca": "Planaltina - GO"}`. Em certidões de Registro Civil o script ainda confere pelo CNS que está na matrícula.
  - estado_civil: Casado(a) | Separado(a) | Divorciado(a) | Viúvo(a). Não existe "Solteiro(a)": para solteiros não inclua o campo nem a Declaração de estado civil.
  - regime_bens_casamento: Comunhão parcial de bens | Comunhão universal de bens | Separação total de bens | Participação final nos aquestos | Separação obrigatória de bens
  - genero (Sexo): Masculino | Feminino — só se o documento disser expressamente o sexo.
  - tipo_certificado: Positivo | Negativo (certidão "negativa" ou "positiva com efeito de negativa" → conforme escrito).
  - forma_pagamento: Cartão de Crédito | Cartão de Débito | Cheque | Dinheiro | Nota Promissória | Outros | Permuta | Transferência
  - prazo_pagamento: À prazo | À vista | Não informado | Não se aplica | Quitado à prazo
  - onr_tipo_logradouro: o tipo como aparece (ex. "Rua", "Avenida", "Rodovia").

## identificador_registro ("Nome de identificação do Documento")
Texto curto, em maiúsculas, que identifica o documento na lista: "CERTIDÃO NEGATIVA DE DÉBITOS TRABALHISTAS - Nº 52016583/2026", "GUIA DE INFORMAÇÃO - ITBI Nº 991127597", "ESCRITURA PÚBLICA DE COMPRA E VENDA - LV 123 FLS 45". O script compara esse texto (e os campos-chave) com os documentos que a pessoa já tem para sugerir "Vincular" em vez de criar outro. No formulário de abertura de matrícula, o identificador e o código do processo já vêm preenchidos pelo sistema; não os inclua. O Memorial SIGEF (411) não tem identificador.

## Documentos de pessoas (tipo | nome | campos; * = obrigatório; [d] data, [$] dinheiro, [n] número, [s] seleção, [t] texto longo, [b] sim/não)
- 2 | CPF | numero_cpf*, nome*, data_nascimento[d], nacionalidade[s], naturalidade[s], genero*[s], numero_telefone, endereco_eletronico. É o cadastro da pessoa: para pessoa nova, inclua sempre este bloco com o que constar (CPF, nome, nascimento, nacionalidade, naturalidade, telefone, e-mail).
- 3 | CNPJ (pessoa jurídica) | numero_cnpj*, nome* (razão social), data_abertura[d], codigo_cnae[n], tipo_empresa[s], endereco_cidade[s], endereco_eletronico, numero_telefone, data_emissao[d]
- 4 | RG | numero_rg*, data_emissao[d], orgao_expedidor*[s], estado_orgao_emissor*[s], nome*, nome_pai, nome_mae, cidade_nascimento[s], data_nascimento[d]
- 905 | Carteira de Identidade Nacional (CIN) | nome*, numero_cpf*, data_nascimento[d], naturalidade[s], nacionalidade[s], data_validade[d], genero[s], nome_pai, nome_mae, orgao_expedidor[s], estado_orgao_expedidor_rg[s]
- 5 | CNH | nome*, numero_cnh*, data_primeira_habilitacao[d], data_nascimento[d], data_emissao[d], data_expiracao[d], numero_rg_cnh, orgao_expedidor_rg[s], estado_orgao_expedidor_rg[s], numero_cpf, categoria_cnh, nome_pai, nome_mae, orgao_expedidor[s], estado[s], numero_espelho_cnh
- 6 | Certidão de nascimento | nome*, numero_matricula_registro_nascimento (matrícula de 32 dígitos), data_nascimento*[d], hora_nascimento, naturalidade*[s], cidade_nascimento*[s], genero[s], nacionalidade[s], nome_mae, nome_pai, nome_progenitora_materno, nome_progenitor_materno, nome_progenitora_paterno, nome_progenitor_paterno, observacoes[t], nome_serventia*[s], data_emissao*[d]. (livro, pagina e numero_termo_assento_registro_nascimento: o script calcula da matrícula.)
- 8 | Certidão de casamento | identificador_registro*, numero_certificado* (matrícula), nome_solteiro_pessoa_1, person_1_married_name, data_nascimento[d], naturalidade[s], estado_civil*[s], nome_mae, nome_pai, nome_solteiro_pessoa_2, nome_casado_pessoa_2*, cpf_segunda_pessoa_casamento, data_nascimento_pessoa_2*[d], naturalidade_2a_pessoa[s], nome_genitora_pessoa_2, nome_genitor_pessoa_2, data_casamento*[d], regime_bens_casamento*[s], data_separacao[d], data_divorcio[d], data_sentenca[d], data_transito_julgado[d], observacoes[t], nome_serventia*[s], data_emissao*[d]. (livro, pagina e numero_termo_registro_casamento: calculados da matrícula.)
- 7 | Certidão de óbito | nome*, numero_certificado* (matrícula), genero[s], estado_civil[s], cidade_nascimento*[s], nome_mae, nome_pai, data_obito[d], lugar_obito, cidade_obito*[s], causa_obito, local_sepultamento, cidade_sepultamento[s], declarante_obito, observacoes[t], nome_serventia*[s], data_emissao*[d]. (livro, pagina e termo: calculados da matrícula.)
- 32 | Declaração de endereço de residência | identificador_registro*, endereco_cep, endereco_rua*, endereco_numero, endereco_complemento, endereco_bairro, endereco_cidade*[s]
- 33 | Declaração de endereço de domicílio | mesmos campos do 32 · 44 | Declaração de endereço comercial | idem
- 286 | Declaração de estado civil | estado_civil*[s], regime_bens_casamento[s], nome_conjuge_precedente, cpf_segunda_pessoa_casamento
- 140 | OAB - Ordem dos Advogados do Brasil | nome*, numero_inscricao_ordem_dos_advogados_brasil*, estado_orgao_emissor*[s], data_emissao[d], data_expiracao[d]
- 15 | Certidão de débitos federais | identificador_registro*, tipo_certificado[s], nome, numero_certificado, codigo_controle, data_emissao[d], hora_emissao, data_expiracao[d]
- 16 | Certidão de débitos estaduais | identificador_registro*, tipo_certificado[s], numero_certificado*, autenticacao_pagamento, data_emissao[d], data_expiracao[d], codigo_controle
- 17 | Certidão de débitos municipais | identificador_registro*, tipo_certificado[s], numero_certificado*, data_emissao[d], data_expiracao[d], data_validade[d]
- 36 | Certidão de débitos trabalhista | identificador_registro*, tipo_certificado[s], numero_certificado*, data_emissao[d], hora_emissao, data_expiracao[d], autenticacao_pagamento
- 113 | Certidão Negativa de Protesto | identificador_registro, nome_serventia[s], numero_certificado, nome, numero_cnpj, data_emissao[d], data_expiracao*[d] · 163/164 | Protesto GO/DF
- 42 | Consulta a Central Nacional de Indisponibilidade de Bens (CNIB) | identificador_registro*, data_emissao[d], codigo_hash*, resultado_consulta*, disponibilidade_parte*[b]. Um bloco por pessoa consultada, com o hash dela.
- 353 | Informação Nacional de Existência de Testamento (CENSEC) | codigo_verificacao*, data_emissao[d], ha_testamento[b]
- 60 | Imposto sobre Transmissão Causa Mortis e Doação (ITCD/ITCMD) | identificador_registro*, numero_certificado*, data_emissao*[d], valor_avaliado*[$], valor_pago*[$], data_pagamento[d], autenticacao_pagamento
- 26 | Procuração · 27 | Declaração profissional · 129 | Passaporte: o script lê o formulário na hora; use os aliases que o usuário informar.

## Negócio, títulos e imóvel (Notas e RI)
- 284 | Contrato de Compra e Venda (PCVA/SFH) | identificador_registro*, numero_contrato*, data_emissao*[d], data_alienacao*[d], local_assinatura[s], valor_pago*[$], valor_pago_com_recursos_proprios[$], valor_pago_com_recursos_concedidos_pelo_fgts[$], valor_financiamento[$], valor_pago_titulo_sinal[$], valor_desconto_fgts[$], forma_pagamento*[s], prazo_pagamento*[s], valor_avaliacao_para_leilao[$], quantidade_parcelas_financiamento[n], vencimento_primeira_parcela[d], data_vencimento_ultima_parcela[d], valor_primeiro_encargo[$], taxa_juros_anual, taxa_juros_efetiva, resumo_executivo[t]
- 110 | Contrato de Alienação de Bens Imobiliários | identificador_registro*, numero_contrato*, data_emissao*[d], data_alienacao*[d], valor_alienacao*[$], valor_pago_com_recursos_proprios[$], valor_financiamento[$], valor_pago_dinheiro_especie[$], valor_pago_com_recursos_concedidos_pelo_fgts[$], forma_pagamento*[s], prazo_pagamento*[s], vencimento_divida[d], quantidade_parcelas_financiamento[n], valor_parcela[$], vencimento_primeira_parcela[d], data_vencimento_ultima_parcela[d], taxa_juros_mensal, taxa_juros_anual, taxa_juros_efetiva, resumo_executivo[t]
- 35 | Contrato de Compra e Venda | como o 284, mas valor_pago_com_recursos_proprios é obrigatório; sem valor_desconto_fgts, valor_primeiro_encargo e taxas · 276 | Instrumento particular de promessa de compra e venda | mesmos campos do 35
- 49 | Escritura de Compra e Venda | identificador_registro*, nome_serventia*[s], livro*, pagina*, data_lavratura*[d], data_alienacao[d], valor_venda*[$], valor_declarado[$], valor_pago_com_recursos_proprios[$], valor_pago_com_recursos_concedidos_pelo_fgts[$], valor_financiamento[$], forma_pagamento*[s], prazo_pagamento*[s], valor_pago_titulo_sinal[$], data_vencimento_ultima_parcela[d], resumo_executivo[t]
- 133 | Escritura Pública de Doação | identificador_registro*, nome_serventia[s], livro, pagina, data_lavratura[d], data_alienacao[d], valor_alienacao[$], resumo_executivo[t]
- 112 | Escritura Pública de Inventário | identificador_registro, numero_certificado*, data_lavratura*[d], nome_serventia*[s], livro*, pagina*, valor[$], valor_alienacao[$], data_alienacao[d], observacoes[t], resumo_executivo[t]
- 280 | Título de domínio | identificador_registro*, numero_certificado*, data_emissao*[d], numero_inscricao_imobiliaria, codigo_imovel_rural_incra, valor_alienacao*[$], data_alienacao*[d]
- 130 | Formal de Partilha de Bens Imobiliários | identificador_registro*, numero_processo*, data_emissao[d], vara[t], forum_endereco_cidade[s], ffff_nome_juiz, valor_alienacao[$], data_alienacao[d], resumo_executivo[t]
- 103 | Título Judicial | identificador_registro*, numero_processo*, vara[t], data_alienacao[d], valor_causa[$], nome_juiz, data_sentenca[d], resumo_executivo[t]
- 349 | Declaração de Forma e Prazo de Pagamento em Negócio Imobiliário | identificador_registro*, nome_declarante*, data_alienacao*[d], forma_pagamento*[s], prazo_pagamento*[s], valor_alienacao*[$], valor_pago_com_recursos_proprios[$], valor_pago_com_recursos_concedidos_pelo_fgts[$], valor_financiamento[$], quantidade_parcelas_financiamento[n], valor_parcela[$], vencimento_primeira_parcela[d], data_vencimento_ultima_parcela[d], vencimento_divida[d], data_declaracao*[d]
- 373 | Dívida de Financiamento de Bens Imobiliários | identificador_registro*, numero_contrato*, data_emissao*[d], data_alienacao*[d], valor_alienacao*[$], forma_pagamento*[s], prazo_pagamento*[s], valores e parcelas como no 110
- 57 | Cédula de Crédito Bancário | identificador_registro*, numero_cedula_credito*, vencimento_divida[d], vencimento_primeira_parcela[d], forma_pagamento*[s], prazo_pagamento*[s], valor_divida*[$], numero_parcela[n], valor_parcela[$], prazo_amortizacao, valor_avaliacao_para_leilao[$], taxa_juros_mensal, taxa_juros_anual, praca_pagamento, endereco_cidade[s], data_emissao*[d], resumo_executivo[t]
- 204 | Cédula rural hipotecária | identificador_registro*, numero_cedula_credito*, vencimento_divida[d], vencimento_primeira_parcela[d], data_vencimento_ultima_parcela[d], forma_pagamento*[s], prazo_pagamento*[s], valor_divida*[$], quantidade_parcelas_financiamento[n], valor_parcela[$], descricao_imovel[t], praca_pagamento, endereco_cidade[s], data_emissao*[d], resumo_executivo[t]
- 10 | ITBI | identificador_registro*, numero_registro_prefeitura* (nº DUAM), data_emissao[d], numero_inscricao_imobiliaria*, valor_avaliado*[$], valor_pago[$], data_pagamento[d], local_pagamento, autenticacao_pagamento
- 343 | CND Municipal (Imóvel) | identificador_registro*, certidao_numero*, numero_controle_autenticacao, numero_inscricao_imobiliaria*, valor_avaliado[$], data_emissao*[d], data_validade[d]
- 354 | Certidão de Valor Venal | identificador_registro, certidao_numero*, numero_inscricao_imobiliaria*, valor_avaliado*[$], onr_tipo_logradouro*[s], endereco_rua*, endereco_numero*, endereco_complemento, endereco_bairro*, endereco_cep*, endereco_cidade*[s], data_emissao*[d]
- 202 | CAT (Patrimônio da União) | identificador_registro*, numero_certidao_autorizacao_transferencia*, registro_imobiliario_patrimonial_rip*, cat_natureza_transacao, cat_regime, area[n], area_total_uniao[n], im_fracao_ideal[n], data_emissao*[d], data_validade[d]
- 345 | CIB - Imóvel Urbano | codigo_cib*, numero_inscricao_imobiliaria*, data_emissao[d], hora_emissao, data_validade[d], codigo_controle · 346 | CIB - Imóvel Rural | codigo_cib*, codigo_imovel_rural_incra*
- 347 | Declaração de Endereço de Imóvel Urbano | identificador_registro*, endereco_cep*, onr_tipo_logradouro*[s], endereco_rua*, endereco_numero, endereco_complemento, endereco_bairro*, endereco_cidade*[s]
- 348 | Declaração de Endereço de Imóvel Rural | identificador_registro*, denominacao_imovel_rural*, cidade_sede_imovel*[s], endereco_cidade[s], ponto_referencia_para_localizacao_imovel*
- 64 | Certidão de ônus | identificador_registro*, nome_serventia*[s], numero_matricula_imovel*, data_emissao[d], onus*[t], resumo_executivo[t]
- 213 | Declaração de anuência | identificador_registro*, credor, numero_cnpj
- 411 | Memorial Descritivo SIGEF | codigo_certificacao_sigef*, codigo_imovel_rural_incra, responsavel_tecnico, formacao_responsavel_tecnico, codigo_credenciamento, codigo_conselho_profissional_responsavel_tecnico, documento_responsavel_tecnico (sem a UF), uf_documento_responsavel_tecnico[s], referencia_sistema_geodesico, area[n], perimeter[n], tipo_coordenadas_geodesia, tipo_azimutes, data_certificacao[d], data_geracao[d], status_certificacao
- 74 | CCIR | codigo_imovel_rural_incra*, numero_ccir*, im_farm_name, area[n], data_emissao[d], data_validade[d], codigo_controle, descricao_imovel[t]
- 73 | ITR | identificador_registro*, numero_referencia[n], data_emissao*[d], codigo_receita* (NIRF), periodo_apuracao[d], valor[$], valor_pago[$], data_pagamento[d], autenticacao_pagamento
- 81 | CAR | identificador_registro*, numero_cadastro_ambiental_rural*, data_emissao*[d], area[n], codigo_imovel_rural_incra*, descricao_imovel[t]
- 120 | CND Federal (Imóvel Rural) | identificador_registro*, certidao_numero*, numero_controle_autenticacao, denominacao_imovel_rural*, codigo_receita*, codigo_imovel_rural_incra*, data_emissao*[d], data_validade[d]
- 65 | Memorial descritivo | identificador_registro*, numero_matricula_imovel, data_emissao*[d], nome, numero_cpf, numero_cnpj, area[n], art_projeto[n], numero_crea, descricao_imovel[t], observacoes[t], resumo_executivo[t]
- 52 | ART | identificador_registro*, numero_certificado, responsavel_tecnico, numero_crea, data_emissao[d]
- Abertura de matrícula (formulário do perfil temporário; parte `{"codigo": …}`): 387 fazenda/sítio/chácara | 390 casa | 384 terreno/fração | 381 apartamento | 382 loja | 383 sala/conjunto | 385 prédio comercial | 386 prédio residencial | 375 galpão | 388 depósito | 377 vaga | 389 públicos. Rural (387): denominacao_imovel_rural, cidade_sede_imovel[s], ponto_referencia_para_localizacao_imovel, acidente_geografico, onr_tipo_logradouro[s], endereco_rua, endereco_numero, endereco_complemento, endereco_cep, numero_ccir, codigo_imovel_rural_incra, codigo_receita, numero_cadastro_ambiental_rural, codigo_certificacao_sigef, area[n] (ha), area_construida[n] (m²), confrontantes_texto_corrido[t]. Urbanas: onr_tipo_logradouro[s], endereco_rua, endereco_numero, endereco_complemento, endereco_bairro, endereco_cep, setor, super_quadra, quadra, lote, area[n] (m²), area_construida[n] (m²), confrontantes_texto_corrido[t].
- Matrícula para X (mesmos campos + codigo_nacional_matricula*, numero_matricula_imovel*, nome_serventia*[s], numero_inscricao_imobiliaria, codigo_cib, descricao_imovel[t]): 397 fazenda | 400 casa | 394 terreno/fração | 391 apartamento | 392 loja | 393 sala | 395 prédio comercial | 396 prédio residencial | 376 galpão | 398 depósito | 378 vaga | 399 públicos.
- Várias aberturas no mesmo protocolo: ordene os códigos pelo número final (…-4, …-5, …-6) e associe na ordem da minuta; mostre a associação na saída ("P-NKDY-…-4 = Parte 01 – 93,5351 ha – mat. 8.890").

Outros tipos: veja o catálogo (última seção). O script lê o formulário na hora, então qualquer tipo funciona se `tipo` e os aliases estiverem certos. Na dúvida sobre o número do tipo ou um alias, pergunte ao usuário em vez de inventar.

## Escolha dos documentos
- Um bloco para cada documento apresentado que tenha tipo no sistema e dado aproveitável — de cada pessoa (CPF, RG/CIN/CNH, certidões de nascimento/casamento/óbito, endereço, OAB…) e do ato (CNDs, CNIB, CENSEC, ITCD, ITBI, títulos, imóvel).
- Certidões e consultas do autor da herança (CNDs, CNIB, CENSEC, ITCD) vão na parte do De Cujus; a CNIB de cada herdeiro, na parte de cada um.
- Na dúvida entre dois tipos parecidos, escolha pelo título apresentado e diga a escolha em uma linha.

## Cuidados de conferência que a skill deve apontar
- Grafias diferentes do mesmo nome na minuta (ex.: "GENECÍ" × "GENECI"): use a da qualificação e avise.
- Dados que a NoCartório exige e a minuta não traz (ex.: Sexo no cadastro do CPF): liste para o escrevente preencher no Cadastro unificado.
- CCIR × SNCR: o número do CCIR é diferente do código do imóvel no SNCR. Se um "CCIR" tiver os dígitos do código INCRA/SNCR, use-o só em codigo_imovel_rural_incra e avise.
- CIB rural × NIRF: se o documento só trouxer o CIB, pode ir em codigo_receita, com aviso na fonte.
- Confrontantes do SIGEF cortados ("…"): não use nem complete; use o texto completo da minuta ou do memorial do técnico, ou deixe de fora e avise.

## Saída
1. Um bloco ```json com a ficha completa e válida (sem comentários), pronta para copiar. Se for longa, salve também como arquivo .json e envie.
2. Embaixo, em poucas linhas: partes e papéis; documentos incluídos (tipo e nome); dados que NÃO estavam nos documentos e por isso ficaram de fora (ex.: Sexo); divergências encontradas; conversões de unidade; associação código de abertura → parte (quando houver).
3. Lembrete fixo: no NoCartório, na tela do serviço ou do ato, clicar em **Importar ficha**, colar, conferir pessoas, matrículas e papéis e clicar em **Abrir no cadastro unificado**; lá, revisar (campos com selo "ficha"/"calculado", sugestões "Ficha: … usar") e **Revisar e salvar**.

## Catálogo de tipos de documento da NoCartório

(Ainda não incluído. Para incluir: no NoCartório, abra a tela de um serviço → **Importar ficha** → **Exportar catálogo** → **Gerar e baixar**; depois traga o `catalogo-nocartorio.md` ao Claude e peça para atualizar a skill "ficha-cadastro-unificado".)