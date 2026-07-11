# 🎭 Impostor

Jogo multiplayer de dedução social para navegador, estilo *Spyfall* / *O Camaleão*.
Todos os jogadores recebem uma palavra secreta em comum — menos um: o **Impostor**,
que precisa se misturar dizendo palavras relacionadas sem saber qual é a palavra.

## Como rodar localmente

Pré-requisito: [Node.js](https://nodejs.org) 18 ou superior.

```bash
# 1. Instale as dependências
npm install

# 2. Inicie o servidor
npm start
```

Abra **http://localhost:3000** no navegador. Para testar sozinho, abra 3+ abas
(ou janelas anônimas) e entre com nomes diferentes usando o código da sala.

Para desenvolvimento com reinício automático:

```bash
npm run dev
```

A porta pode ser alterada com a variável de ambiente `PORT` (ex: `PORT=8080 npm start`).

## Jogando com cada pessoa no seu próprio dispositivo

### Na mesma rede Wi-Fi (mais fácil)

1. Rode `npm start`. O console mostra o endereço da máquina na rede local, ex:
   ```
   🎭 Impostor no ar!
      Neste computador:  http://localhost:3000
      Na mesma rede:     http://192.168.0.42:3000  ← celulares/outros aparelhos
   ```
2. Quem criar a sala verá no lobby um **QR code** e um botão de
   **compartilhar link de convite** — o link já abre com o código da sala
   preenchido. Os amigos só digitam o nome e entram.

> Se o celular não conectar, verifique se o firewall do computador permite
> conexões de entrada na porta 3000 e se todos estão na mesma rede.

### Pela internet

- **Túnel (rápido, sem deploy):** com o servidor rodando, em outro terminal:
  ```bash
  npx localtunnel --port 3000
  # ou, se tiver o ngrok instalado:
  ngrok http 3000
  ```
  Compartilhe a URL gerada (ex: `https://abcd.loca.lt`) com os jogadores.

- **Deploy (permanente):** o projeto está pronto para plataformas Node como
  **Render**, **Railway** ou **Fly.io** — todas detectam o `npm start` e
  injetam a variável `PORT` automaticamente.

#### Deploy no Render (gratuito), passo a passo

1. Crie um repositório no GitHub e envie o código:
   ```bash
   git remote add origin https://github.com/SEU_USUARIO/impostor.git
   git push -u origin main
   ```
   (o repositório local já está inicializado e com commit)
2. Crie uma conta em [render.com](https://render.com) (pode entrar com o GitHub).
3. No painel, clique em **New + → Blueprint**, escolha o repositório `impostor`
   e confirme. O Render lê o [`render.yaml`](render.yaml) e cria o serviço
   sozinho (plano Free).
4. Ao final do build, você recebe uma URL pública tipo
   `https://impostor-xxxx.onrender.com` — é só compartilhar. O QR code e o
   link de convite do lobby passam a usar essa URL automaticamente.

> **Limitação do plano Free:** o serviço "dorme" após ~15 min sem uso e leva
> ~1 min para acordar na primeira visita. Para uma partida em andamento não há
> impacto (a conexão fica ativa). Se quiser eliminar o cold start, use um plano
> pago ou um monitor de uptime que faça ping periódico na URL.
>
> **Atenção:** as salas vivem na memória do processo. Em qualquer replataforma
> (deploy novo, restart), as partidas em andamento são perdidas — para
> persistência real seria necessário um Redis ou similar.

### Reconexão automática

Cada aba/dispositivo guarda uma **chave de sessão** no navegador (`sessionStorage`).
Se a tela do celular bloquear, o app for para segundo plano ou a página for
recarregada, o jogador **volta automaticamente para a mesma cadeira** — mesmo
papel (palavra ou impostor), mesmo placar e mesmo turno. Se a queda acontecer
na vez do jogador, o turno espera **10 segundos** pela volta dele antes de ser
pulado. Quem ficar desconectado por mais de **60 segundos** é removido da sala
(no lobby) ou tem os turnos pulados (durante a partida) para não travar o jogo
dos demais.

## Como jogar

1. **Criar sala** — um jogador cria a sala e recebe um código de 4 letras (ex: `ABCD`).
2. **Lobby** — os amigos entram com o código. O host define o número de rodadas (1–5)
   e inicia a partida (mínimo 3 jogadores).
3. **Papéis** — o sistema sorteia um Impostor e uma palavra secreta. Todos veem a
   palavra, exceto o Impostor (que vê apenas a categoria, para conseguir se misturar).
4. **Rodadas** — em turnos, cada jogador digita uma palavra relacionada à palavra
   secreta. Nem óbvia demais (o Impostor descobre), nem vaga demais (você vira suspeito).
5. **Votação** — ao fim das rodadas, o Mural de Votação aparece e cada um vota em
   quem acha que é o Impostor (o Impostor também vota, para disfarçar).
6. **Resultado** —
   - Impostor **não** é o mais votado (ou há empate): ele escapou e ganha **+3 pontos**.
   - Impostor é o mais votado: cada jogador que votou nele ganha **+2 pontos**.
7. O host pode iniciar uma nova partida mantendo o placar acumulado.

## Arquitetura

```
Impostor/
├── package.json
├── server/
│   ├── index.js    # Servidor Express + Socket.io (transporte e salas)
│   ├── game.js     # Classe Room: máquina de estados e regras de negócio
│   └── words.js    # Banco de palavras mockado (5 categorias)
└── public/
    ├── index.html  # SPA com as 5 telas (home, lobby, jogo, votação, resultados)
    ├── app.js      # Cliente Socket.io + renderização
    └── style.css   # Complementos ao Tailwind (CDN)
```

### Fluxo de estados no servidor

```
lobby ──game:start──▶ playing ──fim das rodadas──▶ voting ──todos votaram──▶ results
  ▲                                                                            │
  └────────────────────────── game:playAgain (host) ◀─────────────────────────┘
```

### Eventos Socket.io

| Evento (cliente → servidor) | Payload | Descrição |
|---|---|---|
| `room:create` | `{ name }` | Cria sala; retorna código único |
| `room:join` | `{ code, name }` | Entra em uma sala existente |
| `room:rejoin` | `{ code, playerId }` | Reconecta à mesma cadeira após queda/refresh |
| `room:setRounds` | `{ rounds }` | Host define nº de rodadas (1–5) |
| `game:start` | — | Host inicia; sorteia impostor e palavra |
| `game:hint` | `{ text }` | Envia palavra-dica na sua vez |
| `game:vote` | `{ targetId }` | Vota em um suspeito |
| `game:playAgain` | — | Host volta ao lobby mantendo placar |

| Evento (servidor → cliente) | Descrição |
|---|---|
| `room:update` | Estado público da sala (nunca vaza a palavra nem o impostor) |
| `game:role` | Enviado individualmente: sua palavra, ou aviso de que você é o Impostor |

### Decisões de design

- **A palavra secreta nunca trafega no estado público** — só no evento privado
  `game:role` de cada jogador e nos resultados finais.
- O Impostor recebe a **categoria** como pista (como em *O Camaleão*), para que
  tenha alguma chance de se misturar.
- **Empate na votação favorece o Impostor** — ele só é "descoberto" se for o
  único mais votado.
- **Identidade por sessão, não por conexão**: cada jogador tem um `playerId`
  (UUID) que sobrevive a quedas de conexão. O `socket.id` é apenas o endereço
  de entrega atual. Isso torna o jogo utilizável em celulares, onde a conexão
  cai o tempo todo (tela bloqueada, troca de app).
- Jogadores desconectados têm 60s para voltar. Se caírem na própria vez, o
  turno espera 10s pela reconexão antes de ser pulado; a votação nunca trava
  esperando quem caiu. Se o host cair e não voltar em 10s, a coroa passa para
  outro jogador conectado.
- O servidor valida tudo (vez do jogador, voto duplicado, autovoto, dizer a
  própria palavra secreta) — o cliente é apenas apresentação.
