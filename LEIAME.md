# Conecta Aqui: site, ponte de cobertura e painel de planos

Um único servidor Node.js, sem dependências externas, que entrega três coisas:

| Endereço | O que é |
|---|---|
| `/` | Site público da Conecta Aqui com busca por CEP, cartões de planos, ofertas, como funciona, dúvidas e WhatsApp |
| `/admin` | Painel com senha para gerenciar planos, operadoras e contatos e testar a cobertura de um CEP |
| `/api/cobertura?cep=` | A ponte: consulta o app Minha Casa Conectada e devolve só as operadoras e os planos que atendem o CEP |

## Como a ponte funciona

1. O visitante digita o CEP.
2. O servidor entra no app Minha Casa Conectada com um **usuário dedicado** e procura o CEP nas listas `ceps-claro`, `ceps-nio` e `ceps-tim`. O app faz uma busca do tipo "contém", e a ponte confere se o CEP bate exatamente.
3. Busca a cidade no ViaCEP e confere a lista `cidades-promo-claro`.
4. Cruza o resultado com os planos ativos do painel e responde ao site.

Ela **só lê** dados do app, nunca altera nada. As respostas ficam guardadas na memória por 6 horas. Se a sessão expirar, a ponte entra de novo sozinha.

## Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `MCC_EMAIL` | sim | E-mail do usuário criado só para a ponte no app Minha Casa Conectada |
| `MCC_PASSWORD` | sim | Senha desse usuário. Sem as duas variáveis, o site roda em **modo demonstração**, com cobertura fictícia |
| `ADMIN_PASSWORD` | sim | Senha do painel `/admin` |
| `SESSION_SECRET` | sim | Texto aleatório longo, usado para assinar o login do painel |
| `DATA_DIR` | sim em produção | Pasta persistente para os planos e contatos (ex.: `/data`, montada como volume) |
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

- Os planos que vêm instalados são **de exemplo**, com preços fictícios. Substitua pelo painel antes de publicar.
- Para importar uma planilha, use **Exportar planilha**, edite no Excel, salve como CSV e use **Importar planilha**. Se alguma linha tiver erro, nada é importado.
- **Só em cidades promo Claro**: o plano só aparece quando a cidade do CEP está na lista de cidades promocionais do app.
- **Desativar** tira o plano do site sem apagar o cadastro.

## Pendências antes de ir ao ar

- [ ] Criar no app Minha Casa Conectada um usuário só para a ponte
- [ ] Cadastrar os planos reais (e os logos das operadoras, se houver autorização para usá-los)
- [ ] Revisar os textos do site, principalmente "Sem custo para você"
- [ ] Copiar `logo-branca.png` e `favicon.png` para `public/images/` caso o site antigo saia do ar. Hoje eles são carregados de conectaaqui.net.br
