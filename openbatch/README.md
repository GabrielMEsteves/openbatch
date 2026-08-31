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
