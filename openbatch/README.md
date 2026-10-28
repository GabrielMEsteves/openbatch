# OpenBatch

## Jobs Podman com frontend e backend em Docker

A base de conteinerização do backend vem da branch `feat/backend_docker`
(commit `a2741f2`): build multi-stage, manifesto independente em `backend/`,
configuração de produção e health check `/api/health`. A integração Podman
acrescenta SSH, os endpoints de jobs e o volume de metadados a essa base.

`compose.yaml` executa React/Nginx e Node.js separadamente. O backend acessa o
cluster por SSH; Podman continua instalado nos nós Slurm. Nenhum socket Docker
ou Podman do hospedeiro é montado no backend.

Pré-requisitos: Docker Engine e Compose, SSH no nó de entrada, Slurm com
`proctrack/cgroup` e `task/cgroup`, Podman rootless configurado para cada usuário,
e diretório home acessível no nó de execução. Este primeiro fluxo usa um nó e
uma tarefa. A partição vazia seleciona o padrão do cluster.

Copie `.env.example` para `.env` e defina segredo JWT, `SLURM_SSH_HOST` e
`SLURM_SSH_MOUNT`. Na pasta montada, coloque uma chave privada por usuário
(`julia.key`, permissão 600) autorizada no cluster e `known_hosts` com as chaves
dos hosts verificadas. Não versione essas credenciais. O login valida a senha
da conta por SSH (o servidor deve permitir esse método); as operações usam a
chave desse mesmo usuário. A senha não é persistida. Login `admin` de desenvolvimento
não pode usar os endpoints de jobs.

No laboratório WSL de um nó, `sudo bash setup-wsl-compose.sh julia` prepara
uma chave dedicada, autoriza-a na conta `julia`, copia a chave pública do host
local para `known_hosts` e ajusta apenas as variáveis SSH do `.env` (criando um
JWT_SECRET aleatório se ausente). Docker Engine e openssh-server devem estar ativos.
O backend se conecta ao WSL pelo gateway `host.docker.internal`.

```bash
sudo docker compose up -d --build
sudo docker compose logs -f backend
```

Acesse http://localhost:8081 e selecione **Job com Podman**. O exemplo gera
`resultados/saida.txt` no diretório mostrado na interface. Executável e argumentos
são separados; os argumentos são um array JSON. Não é necessário escrever Bash.
A API gera o script, chama `sbatch --parsable`, conserva o ID em volume persistente
e consulta Slurm a cada cinco segundos enquanto a submissão estiver selecionada.
Fechar a interface não cancela o job. A lista permite retomar o acompanhamento.

O script usa `--cgroups=disabled`, configuração validada no laboratório WSL,
para herdar o confinamento do Slurm. A rede da aplicação fica desabilitada.
O download da imagem ocorre antes de iniciar o contêiner e requer acesso ao registry.
Para reprodutibilidade, informe uma imagem por digest. A interface mostra o digest
obtido e os últimos 64 KiB de cada log.

O cancelamento usa `scancel`. `trap EXIT` faz limpeza normal; após encerramento
confirmado pelo Slurm, as consultas e um monitor de 15 segundos reconciliam registros Podman no nó de entrada
quando ele também é o nó de execução (laboratório WSL). Em outro nó, a interface
mostra `remote-node-required`: configurar limpeza nesse nó é necessário antes de
usar esta versão em um cluster distribuído. Sem resposta de `scontrol` e sem
contabilidade `sacct`, o estado permanece `UNKNOWN`; não se presume conclusão.

O diretório de submissão é criado na home real do usuário no cluster. Montagens
arbitrárias, MPI, GPU e multinó não são expostos pelo formulário. O fluxo antigo
de terminal, upload e comandos continua local e não foi migrado para SSH nesta
implementação; em Docker, use a nova aba para os jobs.

Testes do gerador e validação (Linux/WSL, Node instalado):

```bash
node --test podman-jobs.test.js
npm run build
```

## Frontend em contêiner

O frontend utiliza um build multi-stage: o Node.js compila a aplicação React e
somente os arquivos estáticos gerados são copiados para a imagem final do Nginx.

Construa a imagem a partir desta pasta:

```bash
docker build -f Dockerfile.frontend -t openbatch-frontend .
```

Quando o backend estiver em outro contêiner na mesma rede Docker com o nome
`backend` e porta `8080`:

```bash
docker run --rm --name openbatch-frontend \
  --network openbatch \
  -p 80:80 \
  openbatch-frontend
```

Para executar o frontend contra um backend iniciado diretamente na máquina host:

```bash
docker run --rm --name openbatch-frontend \
  --add-host=host.docker.internal:host-gateway \
  -e BACKEND_HOST=host.docker.internal \
  -e BACKEND_PORT=8080 \
  -p 80:80 \
  openbatch-frontend
```

O Nginx entrega a SPA e encaminha `/login`, `/api/*` e `/ws` para o backend.
As variáveis `BACKEND_HOST` e `BACKEND_PORT` são aplicadas quando o contêiner
inicia, portanto a mesma imagem pode ser usada em ambientes diferentes.

O health check do frontend está disponível em `/health`.

## Desenvolvimento local

```bash
npm install
npm run dev
```

O servidor de desenvolvimento do Vite encaminha as rotas do backend conforme a
configuração de `vite.config.js`.
