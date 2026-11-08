# Conecta Aqui: site, catálogo sincronizado com as operadoras e ponte de cobertura

Um único servidor Node.js, sem dependências externas, que entrega três coisas:

| Endereço | O que é |
|---|---|
| `/` | Site público da Conecta Aqui com busca por CEP, cartões de planos, ofertas, como funciona, dúvidas e WhatsApp |
| `/admin` | Painel com senha: escolhe os planos em destaque e os do banner, acompanha a sincronização, operadoras, contatos e testa a cobertura de um CEP |
| `/api/cobertura?cep=` | A ponte: consulta o app Minha Casa Conectada e devolve só as operadoras e os planos que atendem o CEP |

## De onde vêm os planos e preços

Ninguém cadastra plano à mão. A cada 6 horas (e no botão "Sincronizar agora" do painel) o servidor lê os sites das operadoras (`lib/sync/`):

| Operadora | Fonte | Observação |
|---|---|---|
| TIM | `internet.tim.com.br/json/plans.json` e `sp.json` | Tabela nacional e tabela de São Paulo (usada quando o CEP é de SP) |
| Claro | página `/internet` + `/multi` para achar os cards e `api/catalog?state=&city=` para os preços | Preço por cidade. A vitrine usa Rio de Janeiro/RJ; a busca por CEP consulta a cidade do cliente e guarda por 6 horas |
| Nio | HTML da home `niointernet.com.br` | Preço único ("fixo até 2030"), com valor no cartão e Globoplay por 12 meses nos planos Super/Ultra |
| Vivo | HTML de `vivo.com.br/para-voce/produtos-e-servicos/para-casa/internet` | Preço único; aparece só na vitrine (não há lista de CEPs da Vivo no MCC) |

Tudo fica em `DATA_DIR/catalogo.json`. Se o site de uma operadora falhar, os últimos preços lidos dela continuam valendo e o painel mostra o erro. Os ids dos planos são estáveis (vêm do SKU/ID da operadora), então as escolhas do painel sobrevivem às sincronizações.

O painel (`DATA_DIR/curadoria.json`) guarda só: **destaques** (aparecem em "Ofertas do mês" e primeiro nos resultados), **ocultos** e o **preço promo da Nio** por plano.

### Área promocional da Nio

A Nio tem preço diferenciado em algumas cidades. A lista `cidades-promo-claro` do app Minha Casa Conectada é a lista dessas cidades (ex.: ALEGRETE). A regra é o cruzamento das duas listas: o CEP está em `ceps-nio` **e** a cidade do CEP está em `cidades-promo-claro`. Só então os planos da Nio usam o "preço promo Nio" informado no painel (em branco, vale o preço do site). A Nio nunca aparece só pela cidade: a cobertura continua vindo da lista de CEPs.

## Como a ponte funciona

1. O visitante digita o CEP.
2. O servidor entra no app Minha Casa Conectada com um **usuário dedicado** e procura o CEP nas listas `ceps-claro`, `ceps-nio` e `ceps-tim`. O app faz uma busca do tipo "contém", e a ponte confere se o CEP bate exatamente.
3. Busca a cidade no ViaCEP e confere a lista `cidades-promo-claro` (área promocional da Nio).
4. Cruza o resultado com o catálogo sincronizado (preço da Claro da cidade do CEP, tabela SP da TIM quando for o caso) e a curadoria do painel, e responde ao site.

Ela **só lê** dados do app, nunca altera nada. As respostas ficam guardadas na memória por 6 horas. Se a sessão expirar, a ponte entra de novo sozinha.

## Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `MCC_EMAIL` | sim | E-mail do usuário criado só para a ponte no app Minha Casa Conectada |
| `MCC_PASSWORD` | sim | Senha desse usuário. Sem as duas variáveis, o site roda em **modo demonstração**, com cobertura fictícia |
| `ADMIN_PASSWORD` | sim | Senha do painel `/admin` |
| `SESSION_SECRET` | sim | Texto aleatório longo, usado para assinar o login do painel |
| `DATA_DIR` | sim em produção | Pasta persistente para o catálogo, curadoria e contatos (ex.: `/data`, montada como volume) |
| `SYNC_OFERTAS` | opcional | `off` desliga a sincronização automática (os testes usam) |
| `SYNC_INTERVALO_MIN` | opcional | Intervalo da sincronização em minutos (padrão 360) |
| `WHATSAPP_NUMBER` | recomendado | Ex.: `5521923681687` |
| `TELEFONE`, `EMAIL_CONTATO` | opcional | Aparecem no rodapé |
| `NODE_ENV` | `production` | Ativa o cookie seguro |
| `MCC_BASE_URL` | opcional | Padrão: `https://minhacasaconectada.net.br` |

## Publicar no Railway

1. Crie um serviço a partir desta pasta (por um repositório no GitHub ou pelo `railway up`).
2. Adicione um **Volume** montado em `/data` e defina `DATA_DIR=/data`.
3. Cadastre as variáveis acima.
4. Em *Settings → Domains*, gere um domínio ou aponte o `conectaaqui.net.br`.

O comando de início é `npm start`. Não há etapa de build.

## Rodar no computador

```bash
ADMIN_PASSWORD=teste node server.js   # modo demonstração em http://localhost:3000
npm test                               # testes ponta a ponta com um MCC simulado
```

## Planos

- Os planos são lidos dos sites das operadoras; para mudar um preço, mude no painel só o que é seu (destaque, oculto, preço promo da Nio). O cadastro manual antigo, se existia, fica em `DATA_DIR/planos-manual-backup.json`.
- Se uma operadora mudar o site e a leitura quebrar, o painel mostra "falhou" na aba Planos e os últimos preços lidos continuam no ar. Os leitores ficam em `lib/sync/<operadora>.js`, com amostras reais em `test/fixtures/`.

## Pendências antes de ir ao ar

- [ ] Criar no app Minha Casa Conectada um usuário só para a ponte
- [ ] Conferir no painel a primeira sincronização e marcar os destaques
- [ ] Revisar os textos do site, principalmente "Sem custo para você"
- [ ] Copiar `logo-branca.png` e `favicon.png` para `public/images/` caso o site antigo saia do ar. Hoje eles são carregados de conectaaqui.net.br
