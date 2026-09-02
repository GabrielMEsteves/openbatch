# OpenBatch

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

## Backend em contêiner

O backend possui um manifesto de dependências independente em `backend/` e um
build multi-stage. O primeiro estágio compila os módulos nativos usados por PAM
e pelo terminal; a imagem final recebe apenas os pacotes de produção e as
bibliotecas Linux necessárias em tempo de execução.

Crie o arquivo local de configuração e defina uma chave JWT segura:

```bash
cp .env.example .env
```

Construa a imagem:

```bash
docker build -f Dockerfile.backend -t openbatch-backend:local .
```

Execute somente o backend:

```bash
docker run --rm --name openbatch-backend \
  --env-file .env \
  --tmpfs /tmp:rw,size=512m,mode=1777 \
  -p 8080:8080 \
  openbatch-backend:local
```

O health check da API está disponível em `/api/health`.

## Plataforma com Docker Compose

Depois de preencher `.env`, frontend e backend podem ser construídos e iniciados
na mesma rede privada:

```bash
docker compose up --build -d
docker compose ps
```

Somente o Nginx do frontend é publicado. O backend fica disponível internamente
como `backend:8080`, e o frontend encaminha `/login`, `/api/*` e `/ws`.

Para acompanhar os logs e encerrar os serviços:

```bash
docker compose logs -f
docker compose down
```

### Limitação da arquitetura atual

PAM, `su`, `runuser`, diretórios pessoais e comandos SLURM ainda pertencem ao
sistema operacional do nó mestre. A imagem permite construir e iniciar o backend,
mas essas funções exigem integração com o cluster. A etapa seguinte deve mover
essas operações para uma conexão SSH autenticada, evitando montar no contêiner
arquivos sensíveis como `/etc/shadow` ou o socket do Munge.
