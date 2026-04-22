# InmoOS Scraper Worker

Worker externo para scraping de Idealista, Fotocasa y Habitaclia. Se despliega en silvio-server vía Coolify y se conecta a Propel Properties (Lovable) por HTTP + shared secret.

## Stack
- **Hono** (HTTP server) en puerto 3000
- **BullMQ + Redis** (cola)
- **Playwright + stealth** (scraping)
- **Docker** (Coolify lo construye desde Dockerfile)

## Despliegue rápido en Coolify (silvio-server)

### 1. Sube este repo a GitHub
```bash
cd scraper-worker
git init
git add .
git commit -m "init scraper worker"
git branch -M main
git remote add origin git@github.com:TU-USUARIO/scraper-worker.git
git push -u origin main
```

### 2. En Coolify (http://79.117.130.224:3000)
1. **Projects → + Add → name: `inmoos`**
2. Dentro del proyecto: **+ New Resource → Database → Redis 7** (lo expone como `redis://redis:6379`)
3. **+ New Resource → Application → Public/Private Git Repository**
   - URL del repo
   - Build Pack: **Dockerfile**
   - Branch: `main`
   - **Port: 3000**
   - Domains: `scraper.elmapa.duckdns.org` (asegúrate primero que el DNS apunta a 79.117.130.224)
4. **Environment Variables** (pega esto):
```
SUPABASE_URL=https://YOUR-PROPEL-PROPERTIES-PROJECT.supabase.co
WORKER_TOKEN=1RxExw2COmDh1jJRpb0mJOcEeWnK7SEeX8OK8eh40x0
WORKER_VERSION=1.0.0
WORKER_ID=worker-eu-1
REDIS_URL=redis://redis:6379
MAX_CONCURRENT_JOBS=3
REQUEST_DELAY_MS=8000
JOB_TIMEOUT_MS=300000
HEARTBEAT_INTERVAL_MS=30000
PORT=3000
```
5. **Deploy**.

### 3. Genera token de API de Coolify
- Avatar (arriba derecha) → **Keys & Tokens → Create New Token**
- Permisos: **read + write + deploy**
- Copia el token (empieza por `1|...`)

### 4. Pega credenciales en Propel Properties (Lovable)
En `/configuracion/worker` de Propel Properties pega:

| Campo | Valor |
|---|---|
| Coolify API URL | `http://79.117.130.224:3000/api/v1` |
| Coolify API Token | (el del paso 3) |
| Application UUID | (lo ves en la URL de la app en Coolify) |
| Worker URL pública | `https://scraper.elmapa.duckdns.org` |
| Worker Token | `1RxExw2COmDh1jJRpb0mJOcEeWnK7SEeX8OK8eh40x0` |

⚠️ El **WORKER_TOKEN debe ser idéntico** en el worker y en Propel Properties (es el shared secret que valida cada request).

## Adapters

Los adapters de `src/adapters/*.ts` son **stubs funcionales con la estructura completa** (Playwright + stealth + CAPTCHA detection + paginación + ingest por lotes), pero los **selectores CSS están marcados como TODO**. Tienes que iterarlos contra los portales reales — son cambiantes y si los hardcodeo ahora se rompen el día 1.

## Desarrollo local
```bash
cp .env.example .env
docker compose up --build
curl -X POST http://localhost:3000/jobs \
  -H "x-worker-token: 1RxExw2COmDh1jJRpb0mJOcEeWnK7SEeX8OK8eh40x0" \
  -H "content-type: application/json" \
  -d '{"jobId":"test","tenantId":"t1","params":{"city":"Madrid"},"portals":["idealista"]}'
```
