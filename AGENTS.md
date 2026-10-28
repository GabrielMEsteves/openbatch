 # OpenBatch Contributor Guide

## Repository Layout

- `openbatch/` contains the React/Vite frontend and Express/WebSocket backend.
- `openbatch/src/` contains React pages, components, hooks, context, and styles.
- `openbatch/server.js` contains the Node.js API, PAM authentication, uploads, and terminal WebSocket handling.
- `ansible/` contains the deployment playbooks and roles for networking, SLURM, and OpenBatch.

## Development Commands

Run commands from `openbatch/`:

```bash
npm install
npm run dev
npm run lint
npm run build
```

Use `npm run lint` and `npm run build` before completing frontend or backend changes. The project uses ESLint flat configuration and supports JavaScript/JSX rather than TypeScript.

## Implementation Guidance

- Follow the existing React component and stylesheet organization; keep UI changes scoped to the relevant page, component, or style file.
- Preserve the API paths and authentication flow unless the task explicitly changes the contract.
- Treat `server.js` as security-sensitive: validate authenticated user input, avoid shell interpolation where possible, and do not commit credentials, tokens, inventories, or generated build output.
- Keep Ansible changes idempotent and consistent with the existing role structure.
- Avoid unrelated formatting or refactoring.

## Validation

For application changes, run:

```bash
npm run lint
npm run build
```

For Ansible changes, run an appropriate syntax check when Ansible is available, for example:

```bash
ansible-playbook --syntax-check ansible/01-network-config.yaml
```
