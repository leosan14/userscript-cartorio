# Scripts do Cartório

Site de instalação dos userscripts de apoio ao NoCartório. Explica como instalar o
Tampermonkey, instala cada script com um clique, traz as instruções de uso de cada um
e serve os arquivos de onde o Tampermonkey busca as atualizações.

Endereço previsto: <https://leosan14.github.io/userscript-cartorio/>

## O que tem aqui

| Caminho | O que é |
| --- | --- |
| `index.html`, `assets/` | A página (HTML, CSS e JavaScript puros, sem etapa de build). |
| `scripts/*.user.js` | Os scripts. É daqui que o Tampermonkey instala e atualiza. |
| `skill/ficha-cadastro-unificado/SKILL.md` | A skill que ensina a IA a gerar a ficha. |
| `skill/ficha-cadastro-unificado.zip` | A mesma skill, empacotada para enviar ao Claude ou ao ChatGPT. |
| `skill/ficha-protesto/SKILL.md` | A skill que gera a ficha de protesto (CENPROT, CRA, bancos) para o Apontamento assistido. |
| `skill/ficha-protesto.zip` | A mesma skill, empacotada para enviar ao Claude ou ao ChatGPT. |
| `config/trello.json` | Configuração do cartório para o script do Trello (chave de API, feriados, quadros ocultos). **Sem token.** |
| `programas/certidao-dominial/` | `CertidaoDominial.exe` e o `config.json` original (textos padrão, que também vão embutidos no `.exe`). |
| `programas/assistente-cnib/` | `AssistenteCNIB.exe` (uso diário) e `AssistenteCNIB-Admin.exe` (TI: credenciais e comandos). |

## Colocar o site no ar (uma vez)

O site é estático e foi feito para o GitHub Pages:

1. No GitHub, abra **Settings › Pages** deste repositório.
2. Em **Build and deployment › Source**, escolha **Deploy from a branch**.
3. Em **Branch**, escolha `main` e a pasta `/ (root)`. Salve.
4. Em um ou dois minutos o site abre em `https://leosan14.github.io/userscript-cartorio/`.

Observações:

- O GitHub Pages em conta gratuita exige repositório **público**. Com repositório privado
  é preciso um plano pago (e, mesmo assim, o site publicado fica aberto a quem tiver o link).
- O site precisa ser aberto sem login: é assim que o Tampermonkey de cada pessoa consegue
  buscar as atualizações.
- A página pede aos buscadores para não ser indexada (`noindex`), mas isso não é proteção:
  qualquer pessoa com o endereço consegue abrir.

## Publicar uma versão nova de um script

1. Substitua o arquivo em `scripts/` **mantendo exatamente o mesmo nome**.
2. Aumente o `@version` no cabeçalho (ex.: `1.3.0` → `1.3.1`). Sem isso o Tampermonkey
   entende que nada mudou e não atualiza ninguém.
3. Mantenha no cabeçalho as linhas `@updateURL` e `@downloadURL` (veja abaixo) e não mude
   `@name` nem `@namespace`: é por eles que o Tampermonkey reconhece que é o mesmo script
   e preserva as configurações de cada pessoa.
4. Faça o commit na `main`.

O número de versão mostrado na página é lido direto do arquivo, então não há mais nada a editar.
Quem já instalou recebe a versão nova na próxima verificação automática do Tampermonkey
(em geral, em até um dia).

Cabeçalho esperado em cada script:

```js
// @version      1.3.1
// @homepageURL  https://leosan14.github.io/userscript-cartorio/
// @updateURL    https://leosan14.github.io/userscript-cartorio/scripts/NOME-DO-ARQUIVO.user.js
// @downloadURL  https://leosan14.github.io/userscript-cartorio/scripts/NOME-DO-ARQUIVO.user.js
```

## Acrescentar um script novo

1. Salve o arquivo em `scripts/` com nome terminado em `.user.js`, sem espaços, acentos
   nem número de versão no nome.
2. Acrescente ao cabeçalho as três linhas acima, com o nome do arquivo.
3. Em `index.html`, copie um bloco `<article class="card">` e ajuste nome, descrição,
   `href` do botão Instalar e `data-version`.
4. Copie um bloco `<dialog class="guide">`, dê a ele um `id` começando com `guia-` e aponte
   o botão **Como usar** para ele em `data-guide`.

Um endereço como `…/userscript-cartorio/#guia-trello` abre o guia direto, para mandar a um colega.

## Publicar uma versão nova de um programa

Os programas do Windows ficam em `programas/` e **não** se atualizam sozinhos: quem usa
baixa de novo pela página.

1. Gere o executável no projeto do programa (`gerar_executavel.bat` na Certidão Dominial,
   `build\construir-windows.bat` no Assistente CNIB).
2. Copie o que saiu na pasta `dist\` para a pasta correspondente em `programas/`,
   **mantendo os nomes dos arquivos** (os links da página apontam para eles).
3. Em `index.html`, atualize a versão e o tamanho mostrados no cartão (`<span class="ver">`)
   e nos botões de download dos guias.
4. Faça o commit. Os arquivos precisam ficar abaixo de 100 MB (limite do GitHub).

## Atualizar a skill da ficha

1. Edite `skill/ficha-cadastro-unificado/SKILL.md`.
2. Gere o pacote de novo:

   ```bash
   cd skill && rm -f ficha-cadastro-unificado.zip && zip -X -r ficha-cadastro-unificado.zip ficha-cadastro-unificado
   ```

3. Faça o commit dos dois arquivos. Quem já instalou a skill precisa baixar e enviar de novo
   à IA: skills não se atualizam sozinhas.

## Atualizar a configuração do Trello

No script do Trello, em **Configurações › Levar para outra máquina › Copiar configuração**,
copie o texto e cole em `config/trello.json`, **apagando antes o valor do token**
(deixe `"token":""` ou remova o campo). O arquivo é público: nunca publique um token.

## Mudar o endereço do site

Se o site for para outro endereço (domínio próprio, outro serviço de hospedagem), troque
`https://leosan14.github.io/userscript-cartorio/` pelo novo em todos os arquivos de `scripts/`
e aumente o `@version` de cada um, publicando ainda uma vez no endereço antigo para que as
instalações existentes aprendam o caminho novo.

## Testar no computador

```bash
python3 -m http.server 8000
```

Abra <http://localhost:8000/>.
